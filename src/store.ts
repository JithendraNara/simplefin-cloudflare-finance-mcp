import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { SimpleFinAccount, SimpleFinAccountsResponse, SimpleFinTransaction } from "./simplefin.js";
import { normalizeAccounts, toNumber } from "./simplefin.js";

export type CachedAccount = {
  id: string;
  name: string | null;
  org_name: string | null;
  org_domain: string | null;
  balance: number | null;
  available_balance: number | null;
  currency: string | null;
  raw_json: string;
  updated_at: string;
};

export type CachedTransaction = {
  id: string;
  account_id: string;
  account_name: string | null;
  org_name: string | null;
  amount: number;
  description: string | null;
  payee: string | null;
  memo: string | null;
  category: string;
  transacted_at: number | null;
  posted_at: number | null;
  pending: number;
  raw_json: string;
};

export class FinanceStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    const absolutePath = resolve(path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    this.db = new DatabaseSync(absolutePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  getStatus(): Record<string, unknown> {
    const accountCount = this.db.prepare("SELECT COUNT(*) AS count FROM accounts").get() as { count: number };
    const transactionCount = this.db.prepare("SELECT COUNT(*) AS count FROM transactions").get() as { count: number };
    const lastSync = this.db
      .prepare("SELECT synced_at, account_count, transaction_count, errlist_json FROM sync_runs ORDER BY synced_at DESC LIMIT 1")
      .get() as Record<string, unknown> | undefined;

    return {
      account_count: accountCount.count,
      transaction_count: transactionCount.count,
      last_sync: lastSync ?? null
    };
  }

  saveSimpleFinPayload(payload: SimpleFinAccountsResponse): Record<string, unknown> {
    const accounts = normalizeAccounts(payload);
    const syncedAt = new Date().toISOString();
    let transactionCount = 0;

    const save = this.db.prepare(`
      INSERT OR REPLACE INTO accounts
        (id, name, org_name, org_domain, balance, available_balance, currency, raw_json, updated_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const saveTransaction = this.db.prepare(`
      INSERT OR REPLACE INTO transactions
        (id, account_id, amount, description, payee, memo, category, transacted_at, posted_at, pending, raw_json)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const saveRun = this.db.prepare(`
      INSERT INTO sync_runs (synced_at, account_count, transaction_count, errlist_json)
      VALUES (?, ?, ?, ?)
    `);

    this.db.exec("BEGIN");
    try {
      for (const account of accounts) {
        save.run(
          account.id,
          account.name ?? null,
          account.org?.name ?? null,
          account.org?.domain ?? null,
          nullableNumber(account.balance),
          nullableNumber(account["available-balance"]),
          account.currency ?? null,
          JSON.stringify(account),
          syncedAt
        );

        for (const transaction of account.transactions ?? []) {
          const id = stableTransactionId(account.id, transaction);
          saveTransaction.run(
            id,
            account.id,
            toNumber(transaction.amount),
            transaction.description ?? null,
            transaction.payee ?? null,
            transaction.memo ?? null,
            categorize(transaction),
            transaction.transacted_at ?? transaction.transacted ?? null,
            transaction.posted_at ?? transaction.posted ?? null,
            transaction.pending ? 1 : 0,
            JSON.stringify(transaction)
          );
          transactionCount += 1;
        }
      }

      saveRun.run(syncedAt, accounts.length, transactionCount, JSON.stringify(payload.errlist ?? payload.errors ?? []));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return {
      synced_at: syncedAt,
      account_count: accounts.length,
      transaction_count: transactionCount,
      errlist: payload.errlist ?? payload.errors ?? []
    };
  }

  listAccounts(includeTransactions: boolean): Array<CachedAccount & { transaction_count: number; transactions?: CachedTransaction[] }> {
    const accounts = this.db
      .prepare(
        `SELECT a.*, COUNT(t.id) AS transaction_count
         FROM accounts a
         LEFT JOIN transactions t ON t.account_id = a.id
         GROUP BY a.id
         ORDER BY COALESCE(a.org_name, ''), COALESCE(a.name, a.id)`
      )
      .all() as Array<CachedAccount & { transaction_count: number }>;

    if (!includeTransactions) return accounts;

    return accounts.map((account) => ({
      ...account,
      transactions: this.getTransactions({ accountId: account.id, limit: 200 })
    }));
  }

  getAccount(accountId: string): CachedAccount | undefined {
    return this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId) as CachedAccount | undefined;
  }

  getTransactions(options: {
    accountId?: string;
    startDate?: string;
    endDate?: string;
    pending?: boolean;
    limit?: number;
  }): CachedTransaction[] {
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];

    if (options.accountId) {
      clauses.push("t.account_id = ?");
      params.push(options.accountId);
    }
    if (options.startDate) {
      clauses.push("COALESCE(t.posted_at, t.transacted_at, 0) >= ?");
      params.push(dateToEpoch(options.startDate));
    }
    if (options.endDate) {
      clauses.push("COALESCE(t.posted_at, t.transacted_at, 0) < ?");
      params.push(dateToEpoch(addOneDay(options.endDate)));
    }
    if (options.pending !== undefined) {
      clauses.push("t.pending = ?");
      params.push(options.pending ? 1 : 0);
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(options.limit ?? 200);

    return this.db
      .prepare(
        `SELECT t.*, a.name AS account_name, a.org_name
         FROM transactions t
         LEFT JOIN accounts a ON a.id = t.account_id
         ${where}
         ORDER BY COALESCE(t.posted_at, t.transacted_at, 0) DESC
         LIMIT ?`
      )
      .all(...params) as CachedTransaction[];
  }

  searchTransactions(options: {
    query: string;
    accountId?: string;
    startDate?: string;
    endDate?: string;
    limit?: number;
  }): CachedTransaction[] {
    const needle = `%${options.query.toLowerCase()}%`;
    const clauses = [
      `(LOWER(COALESCE(t.description, '') || ' ' || COALESCE(t.payee, '') || ' ' || COALESCE(t.memo, '') || ' ' || COALESCE(a.name, '') || ' ' || COALESCE(a.org_name, '') || ' ' || COALESCE(t.category, '')) LIKE ?)`
    ];
    const params: SQLInputValue[] = [needle];

    if (options.accountId) {
      clauses.push("t.account_id = ?");
      params.push(options.accountId);
    }
    if (options.startDate) {
      clauses.push("COALESCE(t.posted_at, t.transacted_at, 0) >= ?");
      params.push(dateToEpoch(options.startDate));
    }
    if (options.endDate) {
      clauses.push("COALESCE(t.posted_at, t.transacted_at, 0) < ?");
      params.push(dateToEpoch(addOneDay(options.endDate)));
    }

    params.push(options.limit ?? 100);

    return this.db
      .prepare(
        `SELECT t.*, a.name AS account_name, a.org_name
         FROM transactions t
         LEFT JOIN accounts a ON a.id = t.account_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY COALESCE(t.posted_at, t.transacted_at, 0) DESC
         LIMIT ?`
      )
      .all(...params) as CachedTransaction[];
  }

  summarizeCashflow(options: { accountId?: string; startDate?: string; endDate?: string }): Record<string, unknown> {
    const transactions = this.getTransactions({ ...options, limit: 10000 });
    const byCategory = new Map<string, { income: number; spending: number; net: number; count: number }>();
    let income = 0;
    let spending = 0;
    let net = 0;

    for (const transaction of transactions) {
      net += transaction.amount;
      if (transaction.amount >= 0) income += transaction.amount;
      else spending += Math.abs(transaction.amount);

      const bucket = byCategory.get(transaction.category) ?? { income: 0, spending: 0, net: 0, count: 0 };
      bucket.net += transaction.amount;
      bucket.count += 1;
      if (transaction.amount >= 0) bucket.income += transaction.amount;
      else bucket.spending += Math.abs(transaction.amount);
      byCategory.set(transaction.category, bucket);
    }

    return {
      income,
      spending,
      net,
      transaction_count: transactions.length,
      categories: Array.from(byCategory.entries())
        .map(([category, totals]) => ({ category, ...totals }))
        .sort((a, b) => b.spending - a.spending)
    };
  }

  detectSubscriptions(options: { minOccurrences?: number; limit?: number }): Record<string, unknown> {
    const minOccurrences = options.minOccurrences ?? 2;
    const rows = this.db
      .prepare(
        `SELECT
          LOWER(TRIM(COALESCE(payee, description, memo, 'unknown'))) AS merchant_key,
          COALESCE(payee, description, memo, 'unknown') AS merchant,
          ROUND(AVG(ABS(amount)), 2) AS average_amount,
          COUNT(*) AS occurrences,
          MIN(COALESCE(posted_at, transacted_at)) AS first_seen,
          MAX(COALESCE(posted_at, transacted_at)) AS last_seen
         FROM transactions
         WHERE amount < 0
         GROUP BY merchant_key
         HAVING COUNT(*) >= ?
         ORDER BY occurrences DESC, average_amount DESC
         LIMIT ?`
      )
      .all(minOccurrences, options.limit ?? 50);

    return { subscriptions: rows };
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        name TEXT,
        org_name TEXT,
        org_domain TEXT,
        balance REAL,
        available_balance REAL,
        currency TEXT,
        raw_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        amount REAL NOT NULL,
        description TEXT,
        payee TEXT,
        memo TEXT,
        category TEXT NOT NULL,
        transacted_at INTEGER,
        posted_at INTEGER,
        pending INTEGER NOT NULL DEFAULT 0,
        raw_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions(account_id);
      CREATE INDEX IF NOT EXISTS idx_transactions_posted ON transactions(posted_at);
      CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category);

      CREATE TABLE IF NOT EXISTS sync_runs (
        synced_at TEXT PRIMARY KEY,
        account_count INTEGER NOT NULL,
        transaction_count INTEGER NOT NULL,
        errlist_json TEXT NOT NULL
      );
    `);
  }
}

function nullableNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stableTransactionId(accountId: string, transaction: SimpleFinTransaction): string {
  if (transaction.id) return `${accountId}:${transaction.id}`;
  return `${accountId}:${transaction.posted_at ?? transaction.posted ?? transaction.transacted_at ?? transaction.transacted ?? "unknown"}:${transaction.amount}:${transaction.description ?? transaction.payee ?? transaction.memo ?? ""}`;
}

function categorize(transaction: SimpleFinTransaction): string {
  const text = [transaction.description, transaction.payee, transaction.memo].filter(Boolean).join(" ").toLowerCase();

  if (toNumber(transaction.amount) > 0) return "income";
  if (/(rent|mortgage|apartment|property management)/.test(text)) return "housing";
  if (/(grocery|market|trader joe|whole foods|kroger|costco|walmart|target)/.test(text)) return "groceries";
  if (/(restaurant|cafe|coffee|doordash|ubereats|grubhub|bar|diner|pizza)/.test(text)) return "dining";
  if (/(uber|lyft|shell|chevron|exxon|bp|parking|transit|metro)/.test(text)) return "transport";
  if (/(netflix|spotify|hulu|apple|google|youtube|amazon prime|subscription)/.test(text)) return "subscriptions";
  if (/(pharmacy|doctor|dental|medical|hospital|clinic|cvs|walgreens)/.test(text)) return "health";
  if (/(electric|water|gas|internet|comcast|xfinity|verizon|at&t|tmobile|utility)/.test(text)) return "utilities";
  if (/(transfer|payment|credit card|autopay)/.test(text)) return "transfers";
  return "uncategorized";
}

function dateToEpoch(value: string): number {
  return Math.floor(new Date(`${value}T00:00:00Z`).getTime() / 1000);
}

function addOneDay(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
