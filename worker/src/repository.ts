import type { Enrichment, Env, SimpleFinConnection, SimpleFinPayload, SyncOptions, TransactionRow } from "./types.js";
import {
  nullableNumber,
  stableTransactionId,
  transactionAmount,
  transactionPostedAt,
  transactionTransactedAt
} from "./simplefin.js";

export class FinanceRepository {
  constructor(private readonly env: Env) {}

  async status(): Promise<Record<string, unknown>> {
    const accounts = await this.env.DB.prepare("SELECT COUNT(*) AS count FROM accounts").first<{ count: number }>();
    const transactions = await this.env.DB.prepare("SELECT COUNT(*) AS count FROM transactions").first<{ count: number }>();
    const enriched = await this.env.DB.prepare("SELECT COUNT(*) AS count FROM transaction_enrichment").first<{ count: number }>();
    const lastSync = await this.env.DB.prepare(
      "SELECT synced_at, start_date, end_date, account_count, transaction_count, errlist_json, status, error FROM sync_runs ORDER BY synced_at DESC LIMIT 1"
    ).first();

    return {
      ok: true,
      service: "simplefin-finance-mcp",
      accounts: accounts?.count ?? 0,
      transactions: transactions?.count ?? 0,
      enriched_transactions: enriched?.count ?? 0,
	      last_sync: lastSync ?? null,
	      data_freshness: await this.dataFreshness(),
	      account_coverage: await this.accountCoverageSummary(),
	      scheduled_sync: await this.scheduledSyncStatus(),
	      ai_enrichment: await this.aiEnrichmentHealth(),
	      health: { issues: await this.healthIssues() }
	    };
	  }

  async scheduledSyncStatus(): Promise<Record<string, unknown>> {
    const lastScheduledSync = await this.env.DB.prepare(
      `SELECT synced_at, start_date, end_date, account_count, transaction_count, errlist_json, status, error
       FROM sync_runs
       WHERE trigger = 'scheduled'
       ORDER BY synced_at DESC
       LIMIT 1`
    ).first<Record<string, unknown>>();

    return {
      cron_utc: "15 12 * * *",
      cadence: "daily",
      verified_completed_run: Boolean(lastScheduledSync),
      verification_status: lastScheduledSync ? "verified" : "awaiting_first_scheduled_run",
      last_scheduled_sync: lastScheduledSync ?? null
    };
  }

  async dataFreshness(): Promise<Record<string, unknown>> {
    const maxStalenessHours = Math.max(1, Number(this.env.DATA_MAX_STALENESS_HOURS ?? "36"));
    const lastSync = await this.env.DB.prepare(
      `SELECT synced_at, start_date, end_date, account_count, transaction_count, status, error
       FROM sync_runs
       ORDER BY synced_at DESC
       LIMIT 1`
    ).first<{
      synced_at: string;
      start_date: string;
      end_date: string;
      account_count: number;
      transaction_count: number;
      status: string;
      error?: string | null;
    }>();

    const previousSync = await this.env.DB.prepare(
      `SELECT synced_at, account_count, transaction_count, status
       FROM sync_runs
       ORDER BY synced_at DESC
       LIMIT 1 OFFSET 1`
    ).first<{ synced_at: string; account_count: number; transaction_count: number; status: string }>();

    const latestTransaction = await this.env.DB.prepare(
      `SELECT MAX(COALESCE(posted_at, transacted_at)) AS latest_epoch
       FROM transactions`
    ).first<{ latest_epoch?: number | null }>();

    const now = Date.now();
    const lastSyncAgeHours = lastSync ? roundHours((now - Date.parse(lastSync.synced_at)) / (60 * 60 * 1000)) : null;
    const latestTransactionAt = latestTransaction?.latest_epoch
      ? new Date(Number(latestTransaction.latest_epoch) * 1000).toISOString()
      : null;
    const latestTransactionAgeHours = latestTransactionAt
      ? roundHours((now - Date.parse(latestTransactionAt)) / (60 * 60 * 1000))
      : null;

    const stale = lastSyncAgeHours === null || lastSyncAgeHours > maxStalenessHours || lastSync?.status !== "ok";
    const accountCountChanged = Boolean(previousSync && lastSync && previousSync.account_count !== lastSync.account_count);
    const warnings: string[] = [];
    if (!lastSync) warnings.push("no_sync_run_recorded");
    if (lastSync?.status && lastSync.status !== "ok") warnings.push("last_sync_not_ok");
    if (lastSyncAgeHours !== null && lastSyncAgeHours > maxStalenessHours) warnings.push("last_sync_stale");
    if (accountCountChanged) warnings.push("source_account_count_changed_since_previous_sync");

    return {
      fresh: !stale,
      stale,
      max_staleness_hours: maxStalenessHours,
      last_sync_at: lastSync?.synced_at ?? null,
      last_sync_age_hours: lastSyncAgeHours,
      last_sync_window: lastSync ? { start_date: lastSync.start_date, end_date: lastSync.end_date } : null,
      latest_transaction_at: latestTransactionAt,
      latest_transaction_age_hours: latestTransactionAgeHours,
      source_account_count: lastSync?.account_count ?? null,
      previous_source_account_count: previousSync?.account_count ?? null,
      source_account_count_changed: accountCountChanged,
      warnings
    };
  }

  async operationalStatus(): Promise<Record<string, unknown>> {
    const status = await this.status();
    const coverage = await this.env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM accounts) AS accounts,
        (SELECT COUNT(*) FROM transactions) AS transactions,
        (SELECT COUNT(*) FROM transaction_enrichment) AS enriched_transactions,
        (SELECT COUNT(*) FROM semantic_index_jobs) AS indexed_transactions,
        (SELECT COUNT(*) FROM transactions WHERE pending = 1) AS pending_transactions,
        (SELECT COUNT(*) FROM transactions WHERE COALESCE(posted_at, transacted_at) IS NULL) AS undated_transactions,
        (SELECT COUNT(*) FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id WHERE a.id IS NULL) AS orphan_transactions`
    ).first<Record<string, number>>();

    const { results: recentSyncs } = await this.env.DB.prepare(
      `SELECT synced_at, start_date, end_date, account_count, transaction_count, status, trigger, error
       FROM sync_runs
       ORDER BY synced_at DESC
       LIMIT 5`
    ).all();

    const aiSince = new Date();
    aiSince.setUTCHours(0, 0, 0, 0);
    const { results: aiUsageToday } = await this.env.DB.prepare(
      `SELECT task, model, status, COUNT(*) AS runs, COALESCE(SUM(item_count), 0) AS item_count
       FROM ai_usage
       WHERE created_at >= ?
       GROUP BY task, model, status
       ORDER BY item_count DESC, runs DESC`
    )
      .bind(aiSince.toISOString())
      .all();

    const transactions = Number(coverage?.transactions ?? 0);
    const enriched = Number(coverage?.enriched_transactions ?? 0);
    const indexed = Number(coverage?.indexed_transactions ?? 0);
    const lastSync = status.last_sync as { status?: string; synced_at?: string } | null;
    const dataFreshness = await this.dataFreshness();
	    const accountCoverage = await this.accountCoverageSummary();
	    const scheduledSync = await this.scheduledSyncStatus();
	    const aiEnrichment = await this.aiEnrichmentHealth();
	    const accountCoverageHealthy = accountCoverage.healthy !== false;
	    const readiness = {
	      ready: Boolean(lastSync?.status === "ok" && transactions > 0 && dataFreshness.fresh === true && accountCoverageHealthy),
	      data_cached: transactions > 0,
	      last_sync_ok: lastSync?.status === "ok",
	      data_fresh: dataFreshness.fresh === true,
	      account_coverage_healthy: accountCoverageHealthy,
	      enrichment_complete: transactions === 0 || enriched >= transactions,
	      semantic_index_complete: transactions === 0 || indexed >= transactions
	    };

    return {
      service: "simplefin-finance-mcp",
      generated_at: new Date().toISOString(),
	      readiness,
	      data_freshness: dataFreshness,
	      scheduled_sync: scheduledSync,
	      account_coverage: accountCoverage,
	      ai_enrichment: aiEnrichment,
	      health: { issues: await this.healthIssues(dataFreshness, accountCoverage, aiEnrichment) },
	      coverage,
      recent_syncs: recentSyncs,
      ai_usage_today: aiUsageToday,
      limits: {
        simplefin_sync_window_days_max: 90,
        manual_syncs_per_hour_without_force: 3,
        daily_ai_item_limit: 500,
        default_incremental_overlap_days: 3
      }
    };
  }

  async recentManualSyncCount(): Promise<number> {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const row = await this.env.DB.prepare(
      "SELECT COUNT(*) AS count FROM sync_runs WHERE trigger = 'manual' AND synced_at >= ?"
    )
      .bind(oneHourAgo)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }

	  async latestSuccessfulSync(): Promise<{ synced_at: string; start_date: string; end_date: string } | null> {
    const row = await this.env.DB.prepare(
      `SELECT synced_at, start_date, end_date
       FROM sync_runs
       WHERE status = 'ok'
       ORDER BY synced_at DESC
       LIMIT 1`
    ).first<{ synced_at: string; start_date: string; end_date: string }>();
    return row ?? null;
	  }

	  async accountIds(): Promise<string[]> {
	    const { results } = await this.env.DB.prepare("SELECT id FROM accounts").all<{ id: string }>();
	    return results.map((row) => row.id);
	  }

  async saveSyncPayload(payload: SimpleFinPayload, options: Required<Pick<SyncOptions, "startDate" | "endDate" | "trigger">>): Promise<Record<string, unknown>> {
    const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
    const connections = new Map<string, SimpleFinConnection>();
    for (const connection of payload.connections ?? []) {
      connections.set(connection.conn_id, connection);
    }

	    const syncedAt = new Date().toISOString();
	    const syncRunId = crypto.randomUUID();
    let transactionCount = 0;

    for (const account of accounts) {
      const connection = account.conn_id ? connections.get(account.conn_id) : undefined;
      await this.env.DB.prepare(
        `INSERT INTO accounts
         (id, name, conn_id, conn_name, org_name, org_url, currency, balance, available_balance, balance_date, raw_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           conn_id = excluded.conn_id,
           conn_name = excluded.conn_name,
           org_name = excluded.org_name,
           org_url = excluded.org_url,
           currency = excluded.currency,
           balance = excluded.balance,
           available_balance = excluded.available_balance,
           balance_date = excluded.balance_date,
           raw_json = excluded.raw_json,
           updated_at = excluded.updated_at`
      )
        .bind(
          account.id,
          account.name ?? null,
          account.conn_id ?? null,
          account.conn_name ?? connection?.name ?? null,
          connection?.org_name ?? account.org?.name ?? null,
          connection?.org_url ?? account.org?.domain ?? null,
          account.currency ?? null,
          nullableNumber(account.balance),
          nullableNumber(account["available-balance"]),
          account["balance-date"] ?? null,
          JSON.stringify(account),
          syncedAt
        )
        .run();

      for (const transaction of account.transactions ?? []) {
        await this.env.DB.prepare(
          `INSERT INTO transactions
           (id, account_id, amount, description, payee, memo, posted_at, transacted_at, pending, raw_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             account_id = excluded.account_id,
             amount = excluded.amount,
             description = excluded.description,
             payee = excluded.payee,
             memo = excluded.memo,
             posted_at = excluded.posted_at,
             transacted_at = excluded.transacted_at,
             pending = excluded.pending,
             raw_json = excluded.raw_json,
             updated_at = excluded.updated_at`
        )
          .bind(
            stableTransactionId(account.id, transaction),
            account.id,
            transactionAmount(transaction),
            transaction.description ?? null,
            transaction.payee ?? null,
            transaction.memo ?? null,
            transactionPostedAt(transaction),
            transactionTransactedAt(transaction),
            transaction.pending ? 1 : 0,
            JSON.stringify(transaction),
            syncedAt
          )
          .run();
        transactionCount += 1;
      }
    }

    await this.env.DB.prepare(
      `INSERT INTO sync_runs
       (id, synced_at, start_date, end_date, account_count, transaction_count, errlist_json, status, error, trigger)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
	        syncRunId,
        syncedAt,
        options.startDate,
        options.endDate,
        accounts.length,
        transactionCount,
        JSON.stringify(payload.errlist ?? payload.errors ?? []),
        "ok",
        null,
        options.trigger
      )
      .run();

	    return {
	      sync_run_id: syncRunId,
	      synced_at: syncedAt,
	      start_date: options.startDate,
	      end_date: options.endDate,
	      account_count: accounts.length,
	      transaction_count: transactionCount,
	      account_ids: accounts.map((account) => account.id),
	      errlist: payload.errlist ?? payload.errors ?? []
	    };
	  }

  async saveFailedSync(options: Required<Pick<SyncOptions, "startDate" | "endDate" | "trigger">>, error: unknown): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO sync_runs
       (id, synced_at, start_date, end_date, account_count, transaction_count, errlist_json, status, error, trigger)
       VALUES (?, ?, ?, ?, 0, 0, ?, 'error', ?, ?)`
    )
      .bind(
        crypto.randomUUID(),
        new Date().toISOString(),
        options.startDate,
        options.endDate,
        "[]",
        error instanceof Error ? error.message : String(error),
        options.trigger
      )
      .run();
  }

	  async listAccounts(): Promise<Record<string, unknown>> {
	    const { results } = await this.env.DB.prepare(
	      `SELECT
	        a.id,
	        a.name,
	        a.conn_id,
	        a.conn_name,
	        a.org_name,
	        a.org_url,
	        a.currency,
	        a.balance,
	        a.available_balance,
	        a.balance_date,
	        a.updated_at,
	        COUNT(t.id) AS transaction_count,
	        c.coverage_status,
	        c.earliest_transaction_at,
	        c.latest_transaction_at,
	        c.last_incremental_sync_at,
	        c.last_backfill_at,
	        c.last_backfill_days,
	        c.warnings_json
	       FROM accounts a
	       LEFT JOIN transactions t ON t.account_id = a.id
	       LEFT JOIN account_sync_coverage c ON c.account_id = a.id
	       GROUP BY a.id
	       ORDER BY COALESCE(a.org_name, ''), COALESCE(a.name, a.id)`
	    ).all();

	    return { accounts: results.map((row) => ({
	      ...row,
	      warnings: safeJsonArray(row.warnings_json),
	      warnings_json: undefined,
	      earliest_transaction_at_iso: epochToIso(row.earliest_transaction_at),
	      latest_transaction_at_iso: epochToIso(row.latest_transaction_at),
	      balance_date_iso: epochToIso(row.balance_date)
	    })) };
	  }

	  async financeOverview(options: { days?: number } = {}): Promise<Record<string, unknown>> {
    const days = Math.max(1, Math.min(options.days ?? 30, 90));
    const endDate = new Date().toISOString().slice(0, 10);
    const start = new Date(`${endDate}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - days + 1);
    const startDate = start.toISOString().slice(0, 10);
    const startEpoch = dateToEpochNumber(startDate);

    const balances = await this.env.DB.prepare(
      `SELECT
        ROUND(COALESCE(SUM(CASE WHEN balance > 0 THEN balance ELSE 0 END), 0), 2) AS positive_cash,
        ROUND(COALESCE(SUM(CASE WHEN balance < 0 THEN -balance ELSE 0 END), 0), 2) AS debt_like_balances,
        ROUND(COALESCE(SUM(balance), 0), 2) AS net_balance,
        COUNT(*) AS account_count
       FROM accounts`
    ).first();

    const cashflow = await this.env.DB.prepare(
      `SELECT
        ROUND(COALESCE(SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END), 0), 2) AS income,
        ROUND(COALESCE(SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END), 0), 2) AS total_outflow,
        ROUND(COALESCE(SUM(CASE WHEN t.amount < 0 AND COALESCE(e.category, '') <> 'transfers' THEN -t.amount ELSE 0 END), 0), 2) AS operating_spend,
        ROUND(COALESCE(SUM(CASE WHEN t.amount < 0 AND COALESCE(e.category, '') = 'transfers' THEN -t.amount ELSE 0 END), 0), 2) AS debt_payments_transfers,
        ROUND(COALESCE(SUM(t.amount), 0), 2) AS net_after_all_outflows,
        ROUND(COALESCE(SUM(CASE WHEN COALESCE(e.category, '') <> 'transfers' THEN t.amount ELSE 0 END), 0), 2) AS operating_net,
        COUNT(*) AS transaction_count
       FROM transactions t
       LEFT JOIN transaction_enrichment e ON e.transaction_id = t.id
       WHERE COALESCE(t.posted_at, t.transacted_at, 0) >= ?`
    )
      .bind(startEpoch)
      .first();

    const { results: categories } = await this.env.DB.prepare(
      `SELECT
        COALESCE(e.category, 'uncategorized') AS category,
        COUNT(*) AS transaction_count,
        ROUND(COALESCE(SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END), 0), 2) AS income,
        ROUND(COALESCE(SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END), 0), 2) AS spending,
        ROUND(COALESCE(SUM(t.amount), 0), 2) AS net
       FROM transactions t
       LEFT JOIN transaction_enrichment e ON e.transaction_id = t.id
       WHERE COALESCE(t.posted_at, t.transacted_at, 0) >= ?
       GROUP BY category
       ORDER BY spending DESC`
    )
      .bind(startEpoch)
      .all();

    const { results: topMerchants } = await this.env.DB.prepare(
      `SELECT
        ${merchantDisplaySql()} AS merchant,
        COALESCE(e.category, 'uncategorized') AS category,
        COUNT(*) AS transaction_count,
        ROUND(COALESCE(SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END), 0), 2) AS spending
       FROM transactions t
       LEFT JOIN transaction_enrichment e ON e.transaction_id = t.id
       WHERE t.amount < 0 AND COALESCE(t.posted_at, t.transacted_at, 0) >= ?
       GROUP BY LOWER(merchant), category
       HAVING spending > 0
       ORDER BY spending DESC
       LIMIT 10`
    )
      .bind(startEpoch)
      .all();

    const { results: feeSignals } = await this.env.DB.prepare(
      `SELECT
        ${merchantDisplaySql()} AS fee,
        COUNT(*) AS count,
        ROUND(COALESCE(SUM(-t.amount), 0), 2) AS total
       FROM transactions t
       LEFT JOIN transaction_enrichment e ON e.transaction_id = t.id
       WHERE t.amount < 0
         AND COALESCE(t.posted_at, t.transacted_at, 0) >= ?
         AND (
           LOWER(COALESCE(t.description, '') || ' ' || COALESCE(t.payee, '') || ' ' || COALESCE(t.memo, '') || ' ' || COALESCE(e.category, '') || ' ' || COALESCE(e.merchant_normalized, '')) LIKE '%fee%'
           OR LOWER(COALESCE(t.description, '') || ' ' || COALESCE(e.merchant_normalized, '')) LIKE '%interest%'
         )
       GROUP BY fee
       ORDER BY total DESC
       LIMIT 10`
    )
      .bind(startEpoch)
      .all();

    const integrity = await this.env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id WHERE a.id IS NULL) AS orphan_transactions,
        (SELECT COUNT(*) FROM transactions WHERE COALESCE(posted_at, transacted_at) IS NULL) AS undated_transactions,
        (SELECT COUNT(*) - COUNT(DISTINCT id) FROM transactions) AS duplicate_transaction_ids,
        (SELECT COUNT(*) FROM transactions) AS transactions,
        (SELECT COUNT(*) FROM transaction_enrichment) AS enriched_transactions,
        (SELECT COUNT(*) FROM semantic_index_jobs) AS indexed_transactions`
    ).first();

    const lastSync = await this.latestSuccessfulSync();

	    return {
	      period: { days, start_date: startDate, end_date: endDate },
	      balances,
	      cashflow,
	      categories,
	      top_merchants: mergeMerchantRows(topMerchants, "merchant", "spending").slice(0, 10),
	      fee_signals: mergeMerchantRows(feeSignals, "fee", "total").slice(0, 10),
	      data_quality: {
	        ...integrity,
	        ai_enrichment: await this.aiEnrichmentHealth(),
	        health_issues: await this.healthIssues()
	      },
	      last_sync: lastSync,
	      data_freshness: await this.dataFreshness(),
	      account_coverage: await this.accountCoverageSummary()
	    };
	  }

	  async refreshAccountCoverage(options: {
	    accountIds?: string[];
	    newAccountIds?: string[];
	    syncRunId?: string;
	    startDate: string;
	    endDate: string;
	    trigger: SyncOptions["trigger"];
	    isBackfill?: boolean;
	    backfillDays?: number;
	    errlist?: unknown[];
	  }): Promise<Record<string, unknown>> {
	    const accountIds = options.accountIds?.length ? options.accountIds : await this.accountIds();
	    if (accountIds.length === 0) {
	      return { accounts_checked: 0, candidates: [], summary: await this.accountCoverageSummary() };
	    }

	    const placeholders = accountIds.map(() => "?").join(", ");
	    const { results } = await this.env.DB.prepare(
	      `SELECT
	        a.id,
	        a.name,
	        a.conn_id,
	        a.conn_name,
	        a.org_name,
	        a.balance_date,
	        c.first_seen_at,
	        c.transaction_count AS previous_transaction_count,
	        c.last_backfill_at,
	        c.last_backfill_days,
	        COUNT(t.id) AS transaction_count,
	        MIN(COALESCE(t.posted_at, t.transacted_at)) AS earliest_transaction_at,
	        MAX(COALESCE(t.posted_at, t.transacted_at)) AS latest_transaction_at
	       FROM accounts a
	       LEFT JOIN transactions t ON t.account_id = a.id
	       LEFT JOIN account_sync_coverage c ON c.account_id = a.id
	       WHERE a.id IN (${placeholders})
	       GROUP BY a.id`
	    )
	      .bind(...accountIds)
	      .all<Record<string, unknown>>();

	    const now = new Date().toISOString();
	    const newAccountIds = new Set(options.newAccountIds ?? []);
	    const inferredBackfill = await this.latestWideSuccessfulSync();
	    const backfillCandidates = new Set<string>();

	    for (const row of results) {
	      const accountId = String(row.id);
	      const previousCount = row.previous_transaction_count === null || row.previous_transaction_count === undefined
	        ? null
	        : Number(row.previous_transaction_count);
	      const transactionCount = Number(row.transaction_count ?? 0);
	      const isNewAccount = newAccountIds.has(accountId);
	      const errlistWarnings = errlistWarningsForAccount(options.errlist ?? [], row);
	      const hasBackfill = Boolean(options.isBackfill || row.last_backfill_at || inferredBackfill);
	      const warnings = accountWarnings({
	        balanceDate: nullableEpoch(row.balance_date),
	        earliestTransactionAt: nullableEpoch(row.earliest_transaction_at),
	        latestTransactionAt: nullableEpoch(row.latest_transaction_at),
	        transactionCount,
	        isNewAccount,
	        hasBackfill,
	        previousTransactionCount: previousCount,
	        errlistWarnings
	      });
	      const balanceOnlyNeedsBackfill = warnings.includes("balance_only_account") && !hasBackfill;
	      const coverageStatus = warnings.includes("new_account_needs_backfill") || balanceOnlyNeedsBackfill
	        ? "needs_backfill"
	        : warnings.length > 0
	          ? "warning"
	          : "ok";

	      if (!options.isBackfill && (isNewAccount || balanceOnlyNeedsBackfill)) {
	        backfillCandidates.add(accountId);
	      }

	      const lastBackfillAt = options.isBackfill
	        ? now
	        : (row.last_backfill_at as string | null | undefined) ?? inferredBackfill?.synced_at ?? null;
	      const lastBackfillDays = options.isBackfill
	        ? options.backfillDays ?? null
	        : clampBackfillDays(nullableNumberValue(row.last_backfill_days) ?? inferredBackfill?.days ?? null);

	      await this.env.DB.prepare(
	        `INSERT INTO account_sync_coverage
	         (account_id, first_seen_at, last_seen_at, last_balance_date, earliest_transaction_at, latest_transaction_at,
	          transaction_count, last_incremental_sync_at, last_backfill_at, last_backfill_days, coverage_status, warnings_json, updated_at)
	         VALUES (?, COALESCE(?, ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	         ON CONFLICT(account_id) DO UPDATE SET
	           last_seen_at = excluded.last_seen_at,
	           last_balance_date = excluded.last_balance_date,
	           earliest_transaction_at = excluded.earliest_transaction_at,
	           latest_transaction_at = excluded.latest_transaction_at,
	           transaction_count = excluded.transaction_count,
	           last_incremental_sync_at = COALESCE(excluded.last_incremental_sync_at, account_sync_coverage.last_incremental_sync_at),
	           last_backfill_at = COALESCE(excluded.last_backfill_at, account_sync_coverage.last_backfill_at),
	           last_backfill_days = COALESCE(excluded.last_backfill_days, account_sync_coverage.last_backfill_days),
	           coverage_status = excluded.coverage_status,
	           warnings_json = excluded.warnings_json,
	           updated_at = excluded.updated_at`
	      )
	        .bind(
	          accountId,
	          row.first_seen_at ?? null,
	          now,
	          now,
	          nullableEpoch(row.balance_date),
	          nullableEpoch(row.earliest_transaction_at),
	          nullableEpoch(row.latest_transaction_at),
	          transactionCount,
	          options.isBackfill ? null : now,
	          lastBackfillAt,
	          lastBackfillDays,
	          coverageStatus,
	          JSON.stringify(warnings),
	          now
	        )
	        .run();

	      await this.recordAccountSyncEvent({
	        accountId,
	        eventType: options.isBackfill ? "account_backfill_completed" : isNewAccount ? "new_account_seen" : "account_incremental_sync",
	        eventAt: now,
	        syncRunId: options.syncRunId,
	        startDate: options.startDate,
	        endDate: options.endDate,
	        backfillDays: options.isBackfill ? options.backfillDays : undefined,
	        transactionCountBefore: previousCount,
	        transactionCountAfter: transactionCount,
	        warnings,
	        details: {
	          trigger: options.trigger,
	          coverage_status: coverageStatus,
	          account_name: row.name ?? null,
	          org_name: row.org_name ?? null
	        }
	      });

	      if (previousCount !== null && previousCount !== transactionCount) {
	        await this.recordAccountSyncEvent({
	          accountId,
	          eventType: previousCount > transactionCount ? "transaction_count_dropped" : "transaction_count_changed",
	          eventAt: now,
	          syncRunId: options.syncRunId,
	          startDate: options.startDate,
	          endDate: options.endDate,
	          transactionCountBefore: previousCount,
	          transactionCountAfter: transactionCount,
	          warnings: previousCount > transactionCount ? ["transaction_count_dropped"] : [],
	          details: { delta: transactionCount - previousCount }
	        });
	      }

	      if (errlistWarnings.length > 0) {
	        await this.recordAccountSyncEvent({
	          accountId,
	          eventType: "simplefin_errlist",
	          eventAt: now,
	          syncRunId: options.syncRunId,
	          startDate: options.startDate,
	          endDate: options.endDate,
	          transactionCountBefore: previousCount,
	          transactionCountAfter: transactionCount,
	          warnings: errlistWarnings,
	          details: { errlist: options.errlist ?? [] }
	        });
	      }
	    }

	    return {
	      accounts_checked: results.length,
	      candidates: [...backfillCandidates],
	      summary: await this.accountCoverageSummary()
	    };
	  }

	  async accountCoverageSummary(): Promise<Record<string, unknown>> {
	    const totals = await this.env.DB.prepare(
	      `SELECT
	        (SELECT COUNT(*) FROM accounts) AS source_accounts,
	        COUNT(*) AS tracked_accounts,
	        SUM(CASE WHEN coverage_status = 'ok' THEN 1 ELSE 0 END) AS ok_accounts,
	        SUM(CASE WHEN coverage_status = 'warning' THEN 1 ELSE 0 END) AS warning_accounts,
	        SUM(CASE WHEN coverage_status = 'needs_backfill' THEN 1 ELSE 0 END) AS needs_backfill_accounts,
	        MIN(earliest_transaction_at) AS earliest_transaction_at,
	        MAX(latest_transaction_at) AS latest_transaction_at,
	        SUM(transaction_count) AS transaction_count
	       FROM account_sync_coverage`
	    ).first<Record<string, unknown>>();

	    const { results: recommendations } = await this.env.DB.prepare(
	      `SELECT account_id, coverage_status, transaction_count, latest_transaction_at, last_backfill_at, warnings_json
	       FROM account_sync_coverage
	       WHERE coverage_status <> 'ok'
	       ORDER BY coverage_status, account_id
	       LIMIT 10`
	    ).all();

	    const needsBackfill = Number(totals?.needs_backfill_accounts ?? 0);
	    const warningAccounts = Number(totals?.warning_accounts ?? 0);
	    const sourceAccounts = Number(totals?.source_accounts ?? 0);
	    const trackedAccounts = Number(totals?.tracked_accounts ?? 0);
	    const untrackedAccounts = Math.max(0, sourceAccounts - trackedAccounts);
	    return {
	      healthy: needsBackfill === 0 && untrackedAccounts === 0,
	      source_accounts: sourceAccounts,
	      tracked_accounts: trackedAccounts,
	      untracked_accounts: untrackedAccounts,
	      ok_accounts: Number(totals?.ok_accounts ?? 0),
	      warning_accounts: warningAccounts,
	      needs_backfill_accounts: needsBackfill,
	      transaction_count: Number(totals?.transaction_count ?? 0),
	      earliest_transaction_at: epochToIso(totals?.earliest_transaction_at),
	      latest_transaction_at: epochToIso(totals?.latest_transaction_at),
	      recommendations
	    };
	  }

	  async simpleFinDataCoverage(accountId?: string): Promise<Record<string, unknown>> {
	    const where = accountId ? "WHERE c.account_id = ?" : "";
	    const query = `SELECT
	        c.*,
	        a.name AS account_name,
	        a.conn_name,
	        a.org_name,
	        a.currency,
	        a.balance,
	        a.available_balance
	       FROM account_sync_coverage c
	       LEFT JOIN accounts a ON a.id = c.account_id
	       ${where}
	       ORDER BY COALESCE(a.org_name, ''), COALESCE(a.name, c.account_id)`;
	    const statement = this.env.DB.prepare(query);
	    const { results } = accountId
	      ? await statement.bind(accountId).all()
	      : await statement.all();
	    return {
	      generated_at: new Date().toISOString(),
	      summary: await this.accountCoverageSummary(),
	      accounts: results.map(normalizeCoverageRow)
	    };
	  }

	  async simpleFinAccountGaps(options: { limit?: number } = {}): Promise<Record<string, unknown>> {
	    const { results } = await this.env.DB.prepare(
	      `SELECT
	        c.*,
	        a.name AS account_name,
	        a.org_name
	       FROM account_sync_coverage c
	       LEFT JOIN accounts a ON a.id = c.account_id
	       WHERE c.coverage_status <> 'ok' OR c.warnings_json <> '[]'
	       ORDER BY
	        CASE c.coverage_status WHEN 'needs_backfill' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
	        COALESCE(c.latest_transaction_at, 0) ASC
	       LIMIT ?`
	    )
	      .bind(options.limit ?? 50)
	      .all();
	    return {
	      summary: await this.accountCoverageSummary(),
	      gaps: results.map(normalizeCoverageRow)
	    };
	  }

	  async simpleFinSyncHistory(options: { accountId?: string; limit?: number } = {}): Promise<Record<string, unknown>> {
	    const { results: syncRuns } = await this.env.DB.prepare(
	      `SELECT synced_at, start_date, end_date, account_count, transaction_count, errlist_json, status, error, trigger
	       FROM sync_runs
	       ORDER BY synced_at DESC
	       LIMIT ?`
	    )
	      .bind(options.limit ?? 20)
	      .all();
	    const eventWhere = options.accountId ? "WHERE account_id = ?" : "";
	    const eventStatement = this.env.DB.prepare(
	      `SELECT account_id, event_type, event_at, sync_run_id, start_date, end_date, backfill_days,
	        transaction_count_before, transaction_count_after, warnings_json, details_json
	       FROM account_sync_events
	       ${eventWhere}
	       ORDER BY event_at DESC
	       LIMIT ?`
	    );
	    const { results: accountEvents } = options.accountId
	      ? await eventStatement.bind(options.accountId, options.limit ?? 50).all()
	      : await eventStatement.bind(options.limit ?? 50).all();
	    return { sync_runs: syncRuns, account_events: accountEvents };
	  }

  async operationalEvents(options: { limit?: number } = {}): Promise<Record<string, unknown>> {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    const { results } = await this.env.DB.prepare(
      `SELECT created_at, event_type, path, method, operation, auth_type, is_admin, status, duration_ms, details_json
       FROM operational_events
       ORDER BY created_at DESC
       LIMIT ?`
    )
      .bind(limit)
      .all();
    return {
      retention_days: 30,
      sanitization: "No bearer tokens, OAuth tokens, finance payloads, request bodies, or tool arguments are stored.",
      events: results
    };
  }

	  async simpleFinRawAccount(options: {
	    accountId: string;
	    includeRawJson?: boolean;
	    includeTransactions?: boolean;
	    limit?: number;
	  }): Promise<Record<string, unknown>> {
	    const account = await this.env.DB.prepare(
	      `SELECT a.*, c.coverage_status, c.earliest_transaction_at, c.latest_transaction_at,
	        c.last_backfill_at, c.last_backfill_days, c.warnings_json
	       FROM accounts a
	       LEFT JOIN account_sync_coverage c ON c.account_id = a.id
	       WHERE a.id = ?`
	    )
	      .bind(options.accountId)
	      .first<Record<string, unknown>>();
	    if (!account) return { found: false, account_id: options.accountId };

	    const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
	    const rawJson = options.includeRawJson === false ? undefined : safeJson(account.raw_json);
	    if (rawJson && !options.includeTransactions && typeof rawJson === "object" && !Array.isArray(rawJson)) {
	      delete (rawJson as Record<string, unknown>).transactions;
	    }
	    if (rawJson && options.includeTransactions && typeof rawJson === "object" && !Array.isArray(rawJson)) {
	      const rawTransactions = (rawJson as Record<string, unknown>).transactions;
	      if (Array.isArray(rawTransactions)) {
	        (rawJson as Record<string, unknown>).transactions = rawTransactions.slice(0, limit);
	      }
	    }

	    const transactions = options.includeTransactions
	      ? await this.getTransactions({ accountId: options.accountId, limit })
	      : undefined;

	    return {
	      found: true,
	      account: {
	        ...account,
	        raw_json: undefined,
	        parsed_raw_account: rawJson
	      },
	      transactions,
	      transaction_limit: options.includeTransactions ? limit : undefined
	    };
	  }

  async getTransactions(options: {
    accountId?: string;
    startDate?: string;
    endDate?: string;
    pending?: boolean;
    category?: string;
    limit?: number;
  }): Promise<TransactionRow[]> {
    const clauses: string[] = [];
    const values: Array<string | number> = [];

    if (options.accountId) {
      clauses.push("t.account_id = ?");
      values.push(options.accountId);
    }
    if (options.startDate) {
      clauses.push("COALESCE(t.posted_at, t.transacted_at, 0) >= ?");
      values.push(dateToEpochNumber(options.startDate));
    }
    if (options.endDate) {
      clauses.push("COALESCE(t.posted_at, t.transacted_at, 0) < ?");
      values.push(dateToEpochNumber(addOneDay(options.endDate)));
    }
    if (options.pending !== undefined) {
      clauses.push("t.pending = ?");
      values.push(options.pending ? 1 : 0);
    }
    if (options.category) {
      clauses.push("COALESCE(e.category, 'uncategorized') = ?");
      values.push(options.category);
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const { results } = await this.env.DB.prepare(
      `${transactionSelectSql()} ${where}
       ORDER BY COALESCE(t.posted_at, t.transacted_at, 0) DESC
       LIMIT ?`
    )
      .bind(...values, options.limit ?? 200)
      .all<TransactionRow>();

    return results;
  }

  async searchTransactions(options: {
    query: string;
    accountId?: string;
    startDate?: string;
    endDate?: string;
    limit?: number;
  }): Promise<TransactionRow[]> {
    const clauses = [
      "LOWER(COALESCE(t.description, '') || ' ' || COALESCE(t.payee, '') || ' ' || COALESCE(t.memo, '') || ' ' || COALESCE(a.name, '') || ' ' || COALESCE(a.org_name, '') || ' ' || COALESCE(e.category, '') || ' ' || COALESCE(e.merchant_normalized, '')) LIKE ?"
    ];
    const values: Array<string | number> = [`%${options.query.toLowerCase()}%`];

    if (options.accountId) {
      clauses.push("t.account_id = ?");
      values.push(options.accountId);
    }
    if (options.startDate) {
      clauses.push("COALESCE(t.posted_at, t.transacted_at, 0) >= ?");
      values.push(dateToEpochNumber(options.startDate));
    }
    if (options.endDate) {
      clauses.push("COALESCE(t.posted_at, t.transacted_at, 0) < ?");
      values.push(dateToEpochNumber(addOneDay(options.endDate)));
    }

    const { results } = await this.env.DB.prepare(
      `${transactionSelectSql()} WHERE ${clauses.join(" AND ")}
       ORDER BY COALESCE(t.posted_at, t.transacted_at, 0) DESC
       LIMIT ?`
    )
      .bind(...values, options.limit ?? 100)
      .all<TransactionRow>();

    return results;
  }

  async transactionsByIds(ids: string[]): Promise<TransactionRow[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const { results } = await this.env.DB.prepare(
      `${transactionSelectSql()} WHERE t.id IN (${placeholders})`
    )
      .bind(...ids)
      .all<TransactionRow>();
    return results;
  }

  async summarizeCashflow(options: { accountId?: string; startDate?: string; endDate?: string }): Promise<Record<string, unknown>> {
    const clauses: string[] = [];
    const values: Array<string | number> = [];

    if (options.accountId) {
      clauses.push("t.account_id = ?");
      values.push(options.accountId);
    }
    if (options.startDate) {
      clauses.push("COALESCE(t.posted_at, t.transacted_at, 0) >= ?");
      values.push(dateToEpochNumber(options.startDate));
    }
    if (options.endDate) {
      clauses.push("COALESCE(t.posted_at, t.transacted_at, 0) < ?");
      values.push(dateToEpochNumber(addOneDay(options.endDate)));
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const { results } = await this.env.DB.prepare(
      `SELECT COALESCE(e.category, 'uncategorized') AS category,
        COUNT(*) AS count,
        SUM(CASE WHEN t.amount >= 0 THEN t.amount ELSE 0 END) AS income,
        SUM(CASE WHEN t.amount < 0 THEN ABS(t.amount) ELSE 0 END) AS spending,
        SUM(t.amount) AS net
       FROM transactions t
       LEFT JOIN transaction_enrichment e ON e.transaction_id = t.id
       ${where}
       GROUP BY COALESCE(e.category, 'uncategorized')
       ORDER BY spending DESC`
    )
      .bind(...values)
      .all();

    const totals = results.reduce<{ income: number; spending: number; net: number; transaction_count: number }>(
      (memo, row) => {
        memo.income += Number(row.income ?? 0);
        memo.spending += Number(row.spending ?? 0);
        memo.net += Number(row.net ?? 0);
        memo.transaction_count += Number(row.count ?? 0);
        return memo;
      },
      { income: 0, spending: 0, net: 0, transaction_count: 0 }
    );

    return {
      income: roundMoney(totals.income),
      spending: roundMoney(totals.spending),
      net: roundMoney(totals.net),
      transaction_count: totals.transaction_count,
      categories: results.map((row) => ({
        ...row,
        income: roundMoney(Number(row.income ?? 0)),
        spending: roundMoney(Number(row.spending ?? 0)),
        net: roundMoney(Number(row.net ?? 0))
      }))
    };
  }

  async detectSubscriptions(): Promise<Record<string, unknown>> {
    const { results } = await this.env.DB.prepare(
      `SELECT
        t.id,
        t.amount,
        t.description,
        t.payee,
        t.memo,
        COALESCE(t.posted_at, t.transacted_at) AS occurred_at,
        COALESCE(e.category, 'uncategorized') AS category,
        COALESCE(e.is_subscription_candidate, 0) AS ai_subscription_candidate,
        ${merchantDisplaySql()} AS merchant
       FROM transactions t
       LEFT JOIN transaction_enrichment e ON e.transaction_id = t.id
       WHERE t.amount < 0
       ORDER BY COALESCE(t.posted_at, t.transacted_at, 0) DESC
       LIMIT 2000`
    ).all();

    return { subscriptions: detectSubscriptionCandidates(results) };
  }

  async unenrichedTransactions(limit = 20): Promise<TransactionRow[]> {
    const { results } = await this.env.DB.prepare(
      `${transactionSelectSql()}
       WHERE e.transaction_id IS NULL
          OR e.ai_reason LIKE 'Deterministic fallback%'
       ORDER BY
         CASE WHEN e.transaction_id IS NULL THEN 0 ELSE 1 END,
         COALESCE(e.enriched_at, '1970-01-01T00:00:00.000Z') ASC,
         COALESCE(t.posted_at, t.transacted_at, 0) DESC
       LIMIT ?`
    )
      .bind(limit)
      .all<TransactionRow>();
    return results;
  }

  async unindexedTransactions(limit = 50): Promise<TransactionRow[]> {
    const { results } = await this.env.DB.prepare(
      `${transactionSelectSql()}
       LEFT JOIN semantic_index_jobs s ON s.transaction_id = t.id
       WHERE s.transaction_id IS NULL
       ORDER BY COALESCE(t.posted_at, t.transacted_at, 0) DESC
       LIMIT ?`
    )
      .bind(limit)
      .all<TransactionRow>();
    return results;
  }

  async saveEnrichments(enrichments: Enrichment[]): Promise<void> {
    for (const enrichment of enrichments) {
      await this.env.DB.prepare(
        `INSERT OR REPLACE INTO transaction_enrichment
         (transaction_id, category, merchant_normalized, is_subscription_candidate, confidence, ai_reason, enriched_at, model)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          enrichment.transaction_id,
          enrichment.category,
          enrichment.merchant_normalized,
          enrichment.is_subscription_candidate ? 1 : 0,
          enrichment.confidence,
          enrichment.ai_reason,
          new Date().toISOString(),
          enrichment.model
        )
        .run();
    }
  }

  async saveSemanticIndexJob(transactionId: string, vectorId: string, embeddingModel: string): Promise<void> {
    await this.env.DB.prepare(
      `INSERT OR REPLACE INTO semantic_index_jobs (transaction_id, indexed_at, embedding_model, vector_id)
       VALUES (?, ?, ?, ?)`
    )
      .bind(transactionId, new Date().toISOString(), embeddingModel, vectorId)
      .run();
  }

  async saveAiUsage(task: string, model: string, itemCount: number, status: "ok" | "error", error?: unknown): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO ai_usage (id, created_at, task, model, item_count, status, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        crypto.randomUUID(),
        new Date().toISOString(),
        task,
        model,
        itemCount,
        status,
        error instanceof Error ? error.message : error ? String(error) : null
      )
      .run();
  }

  async dailyAiUsageCount(): Promise<number> {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const row = await this.env.DB.prepare("SELECT COALESCE(SUM(item_count), 0) AS count FROM ai_usage WHERE created_at >= ?")
      .bind(start.toISOString())
      .first<{ count: number }>();
    return Number(row?.count ?? 0);
  }

  async aiEnrichmentHealth(): Promise<Record<string, unknown>> {
    const row = await this.env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM transactions) AS transactions,
        COUNT(e.transaction_id) AS enriched_transactions,
        SUM(CASE WHEN e.ai_reason LIKE 'Deterministic fallback%' THEN 1 ELSE 0 END) AS fallback_enriched,
        SUM(CASE WHEN e.ai_reason NOT LIKE 'Deterministic fallback%' THEN 1 ELSE 0 END) AS ai_enriched,
        SUM(CASE WHEN e.ai_reason LIKE '%daily_ai_item_limit_reached%' THEN 1 ELSE 0 END) AS quota_fallback,
        SUM(CASE WHEN e.ai_reason LIKE '%parseable JSON%' OR e.ai_reason LIKE '%JSON%' OR e.ai_reason LIKE '%SyntaxError%' THEN 1 ELSE 0 END) AS parse_fallback,
        SUM(CASE WHEN e.confidence < 0.5 THEN 1 ELSE 0 END) AS low_confidence_enriched
       FROM transaction_enrichment e`
    ).first<Record<string, unknown>>();
    const transactions = Number(row?.transactions ?? 0);
    const fallback = Number(row?.fallback_enriched ?? 0);
    return {
      transactions,
      enriched_transactions: Number(row?.enriched_transactions ?? 0),
      ai_enriched: Number(row?.ai_enriched ?? 0),
      fallback_enriched: fallback,
      fallback_ratio: transactions > 0 ? Math.round((fallback / transactions) * 1000) / 1000 : 0,
      quota_fallback: Number(row?.quota_fallback ?? 0),
      parse_fallback: Number(row?.parse_fallback ?? 0),
      low_confidence_enriched: Number(row?.low_confidence_enriched ?? 0),
      healthy: transactions === 0 || fallback / transactions < 0.25
    };
  }

  async healthIssues(
    dataFreshness?: Record<string, unknown>,
    accountCoverage?: Record<string, unknown>,
    aiEnrichment?: Record<string, unknown>
  ): Promise<Array<Record<string, unknown>>> {
    const freshness = dataFreshness ?? await this.dataFreshness();
    const coverage = accountCoverage ?? await this.accountCoverageSummary();
    const ai = aiEnrichment ?? await this.aiEnrichmentHealth();
    const issues: Array<Record<string, unknown>> = [];

    if (freshness.fresh !== true) {
      issues.push({
        severity: "critical",
        source: "data_freshness",
        message: "Finance cache is stale or last sync failed.",
        actionable_hint: "Run sync_simplefin as an admin before analysis."
      });
    }
    for (const warning of Array.isArray(freshness.warnings) ? freshness.warnings : []) {
      issues.push({
        severity: "warning",
        source: "data_freshness",
        message: String(warning),
        actionable_hint: "Check connection_status and simplefin_sync_history."
      });
    }

    if (coverage.healthy === false || Number(coverage.warning_accounts ?? 0) > 0 || Number(coverage.needs_backfill_accounts ?? 0) > 0) {
      issues.push({
        severity: Number(coverage.needs_backfill_accounts ?? 0) > 0 ? "critical" : "warning",
        source: "account_coverage",
        message: `${coverage.warning_accounts ?? 0} warning accounts, ${coverage.needs_backfill_accounts ?? 0} accounts need backfill.`,
        actionable_hint: "Call simplefin_data_coverage and simplefin_account_gaps before per-account conclusions."
      });
    }

    const fallback = Number(ai.fallback_enriched ?? 0);
    const transactions = Number(ai.transactions ?? 0);
    if (fallback > 0) {
      issues.push({
        severity: transactions > 0 && fallback / transactions > 0.5 ? "critical" : "warning",
        source: "ai_enrichment",
        message: `${fallback} transactions are deterministic fallback enrichments, not successful AI enrichments.`,
        actionable_hint: "Run categorize_uncategorized_transactions or refresh_insights after fixing AI parsing."
      });
    }
    if (Number(ai.quota_fallback ?? 0) > 0) {
      issues.push({
        severity: "warning",
        source: "ai_enrichment",
        message: `${ai.quota_fallback} transactions fell back because the daily AI item limit was reached.`,
        actionable_hint: "Retry after the daily AI quota window resets or lower batch size."
      });
    }

    const lastSync = await this.env.DB.prepare(
      `SELECT errlist_json FROM sync_runs WHERE status = 'ok' ORDER BY synced_at DESC LIMIT 1`
    ).first<{ errlist_json?: string }>();
    const errlist = safeJsonArray(lastSync?.errlist_json);
    if (errlist.length > 0) {
      const affectedAccounts = await this.accountsWithCoverageWarning("missingdata_errlist");
      const affectedLabel = affectedAccounts.length > 0
        ? ` (${affectedAccounts.map((account) => account.org_name ?? account.name ?? account.id).join(", ")})`
        : "";
      issues.push({
        severity: "warning",
        source: "simplefin_errlist",
        message: `Last successful SimpleFIN sync returned ${errlist.length} errlist item(s)${affectedLabel}.`,
        actionable_hint: "Call simplefin_sync_history and simplefin_account_gaps for account-level mapping."
      });
    }

    return issues;
  }

  async accountsWithCoverageWarning(warning: string): Promise<Array<Record<string, string>>> {
    const { results } = await this.env.DB.prepare(
      `SELECT a.id, a.name, a.org_name
       FROM account_sync_coverage c
       LEFT JOIN accounts a ON a.id = c.account_id
       WHERE c.warnings_json LIKE ?
       ORDER BY COALESCE(a.org_name, ''), COALESCE(a.name, a.id)
       LIMIT 5`
    )
      .bind(`%"${warning}"%`)
      .all<Record<string, string>>();
    return results;
  }

  async saveBriefing(data: {
    periodStart: string;
    periodEnd: string;
    kind: string;
    summaryJson: Record<string, unknown>;
    summaryText: string;
    model: string;
  }): Promise<Record<string, unknown>> {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    await this.env.DB.prepare(
      `INSERT INTO briefings (id, period_start, period_end, kind, summary_json, summary_text, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(id, data.periodStart, data.periodEnd, data.kind, JSON.stringify(data.summaryJson), data.summaryText, data.model, createdAt)
      .run();

    return { id, created_at: createdAt, ...data };
  }

	  async latestBriefing(periodStart: string, periodEnd: string, kind: string): Promise<Record<string, unknown> | null> {
	    return await this.env.DB.prepare(
      `SELECT id, period_start, period_end, kind, summary_json, summary_text, model, created_at
       FROM briefings
       WHERE period_start = ? AND period_end = ? AND kind = ?
       ORDER BY created_at DESC
       LIMIT 1`
    )
	      .bind(periodStart, periodEnd, kind)
	      .first<Record<string, unknown>>();
	  }

	  private async latestWideSuccessfulSync(): Promise<{ synced_at: string; days: number } | null> {
	    const { results } = await this.env.DB.prepare(
	      `SELECT synced_at, start_date, end_date
	       FROM sync_runs
	       WHERE status = 'ok'
	       ORDER BY synced_at DESC
	       LIMIT 20`
	    ).all<{ synced_at: string; start_date: string; end_date: string }>();
	    for (const row of results) {
	      const days = inclusiveDaySpan(row.start_date, row.end_date);
	      if (days >= 85) return { synced_at: row.synced_at, days: Math.min(days, 90) };
	    }
	    return null;
	  }

	  private async recordAccountSyncEvent(event: {
	    accountId: string;
	    eventType: string;
	    eventAt: string;
	    syncRunId?: string;
	    startDate?: string;
	    endDate?: string;
	    backfillDays?: number;
	    transactionCountBefore?: number | null;
	    transactionCountAfter?: number;
	    warnings?: string[];
	    details?: Record<string, unknown>;
	  }): Promise<void> {
	    await this.env.DB.prepare(
	      `INSERT INTO account_sync_events
	       (id, account_id, event_type, event_at, sync_run_id, start_date, end_date, backfill_days,
	        transaction_count_before, transaction_count_after, warnings_json, details_json)
	       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	    )
	      .bind(
	        crypto.randomUUID(),
	        event.accountId,
	        event.eventType,
	        event.eventAt,
	        event.syncRunId ?? null,
	        event.startDate ?? null,
	        event.endDate ?? null,
	        event.backfillDays ?? null,
	        event.transactionCountBefore ?? null,
	        event.transactionCountAfter ?? null,
	        JSON.stringify(event.warnings ?? []),
	        JSON.stringify(event.details ?? {})
	      )
	      .run();
	  }
	}

export function transactionText(transaction: TransactionRow): string {
  return [
    transaction.description,
    transaction.payee,
    transaction.memo,
    transaction.account_name,
    transaction.org_name,
    transaction.category,
    transaction.merchant_normalized,
    String(transaction.amount)
  ]
    .filter(Boolean)
    .join(" | ");
}

function transactionSelectSql(): string {
  return `SELECT
    t.id,
    t.account_id,
    a.name AS account_name,
    a.conn_id,
    a.conn_name,
    a.org_name,
    t.amount,
    t.description,
    t.payee,
    t.memo,
    t.posted_at,
    t.transacted_at,
    t.pending,
    COALESCE(e.category, 'uncategorized') AS category,
    e.merchant_normalized,
    e.is_subscription_candidate,
    e.confidence,
    e.ai_reason
   FROM transactions t
   LEFT JOIN accounts a ON a.id = t.account_id
   LEFT JOIN transaction_enrichment e ON e.transaction_id = t.id`;
}

function merchantDisplaySql(): string {
  return "COALESCE(NULLIF(TRIM(t.payee), ''), NULLIF(TRIM(e.merchant_normalized), ''), NULLIF(TRIM(t.description), ''), NULLIF(TRIM(t.memo), ''), 'unknown')";
}

function mergeMerchantRows(rows: Record<string, unknown>[], nameField: "merchant" | "fee", amountField: "spending" | "total"): Record<string, unknown>[] {
  const groups = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const display = canonicalMerchantDisplay(String(row[nameField] ?? "unknown"));
    const key = normalizeMerchantKey(display);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        ...row,
        [nameField]: display,
        [amountField]: roundMoney(Number(row[amountField] ?? 0)),
        transaction_count: Number(row.transaction_count ?? row.count ?? 0),
        count: row.count === undefined ? undefined : Number(row.count ?? 0)
      });
      continue;
    }
    existing[amountField] = roundMoney(Number(existing[amountField] ?? 0) + Number(row[amountField] ?? 0));
    if (existing.transaction_count !== undefined || row.transaction_count !== undefined) {
      existing.transaction_count = Number(existing.transaction_count ?? 0) + Number(row.transaction_count ?? 0);
    }
    if (existing.count !== undefined || row.count !== undefined) {
      existing.count = Number(existing.count ?? 0) + Number(row.count ?? 0);
    }
  }
  return [...groups.values()]
    .map((row) => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)))
    .sort((left, right) => Number(right[amountField] ?? 0) - Number(left[amountField] ?? 0));
}

function canonicalMerchantDisplay(value: string): string {
  const normalized = normalizeMerchantKey(value);
  if (normalized === "interest" || normalized === "interest charge") return "Interest Charge";
  if (normalized.includes("returned payment")) return "Returned Payment Fee";
  if (normalized.includes("apple credit card")) return "Payment: Apple Card";
  if (normalized.includes("american express credit card")) return "Payment: American Express";
  if (normalized.includes("chase credit card")) return "Payment: Chase";
  if (normalized === "doordash") return "DoorDash";
  if (normalized === "openai") return "OpenAI";
  if (normalized === "google fi wireless") return "Google Fi Wireless";
  return value
    .split(/\s+/)
    .map((part) => part.length <= 3 && part === part.toUpperCase() ? part : part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function dateToEpochNumber(value: string): number {
  return Math.floor(new Date(`${value}T00:00:00Z`).getTime() / 1000);
}

function addOneDay(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function roundHours(value: number): number {
  return Math.round(value * 10) / 10;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function nullableNumberValue(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nullableEpoch(value: unknown): number | null {
  const number = nullableNumberValue(value);
  return number && number > 0 ? number : null;
}

function clampBackfillDays(value: number | null): number | null {
  return value === null ? null : Math.max(1, Math.min(value, 90));
}

function epochToIso(value: unknown): string | null {
  const epoch = nullableEpoch(value);
  return epoch ? new Date(epoch * 1000).toISOString() : null;
}

function normalizeCoverageRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    first_seen_at: row.first_seen_at ?? null,
    last_seen_at: row.last_seen_at ?? null,
    last_balance_at: epochToIso(row.last_balance_date),
    earliest_transaction_at_iso: epochToIso(row.earliest_transaction_at),
    latest_transaction_at_iso: epochToIso(row.latest_transaction_at),
    warnings: safeJsonArray(row.warnings_json)
  };
}

function accountWarnings(options: {
  balanceDate: number | null;
  earliestTransactionAt: number | null;
  latestTransactionAt: number | null;
  transactionCount: number;
  isNewAccount: boolean;
  hasBackfill: boolean;
  previousTransactionCount: number | null;
  errlistWarnings: string[];
}): string[] {
  const warnings = new Set<string>();
  const nowEpoch = Math.floor(Date.now() / 1000);
  if (options.isNewAccount && !options.hasBackfill) warnings.add("new_account_needs_backfill");
  if (options.transactionCount === 0) warnings.add("balance_only_account");
  if (options.balanceDate && nowEpoch - options.balanceDate > 36 * 60 * 60) warnings.add("stale_balance_date");
  if (options.balanceDate && options.balanceDate - nowEpoch > 24 * 60 * 60) warnings.add("balance_date_in_future");
  if (options.latestTransactionAt && nowEpoch - options.latestTransactionAt > 45 * 24 * 60 * 60) {
    warnings.add("no_recent_transactions");
  }
  if (options.previousTransactionCount !== null && options.previousTransactionCount > options.transactionCount) {
    warnings.add("transaction_count_dropped");
  }
  for (const warning of options.errlistWarnings) warnings.add(warning);
  return [...warnings];
}

function errlistWarningsForAccount(errlist: unknown[], account: Record<string, unknown>): string[] {
  const haystacks = [
    String(account.id ?? ""),
    String(account.conn_id ?? ""),
    String(account.conn_name ?? "")
  ].filter(Boolean);
  const matched = errlist.some((item) => {
    const serialized = JSON.stringify(item ?? {});
    return haystacks.some((needle) => needle && serialized.includes(needle));
  });
  return matched ? ["missingdata_errlist"] : [];
}

function safeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function safeJsonArray(value: unknown): unknown[] {
  const parsed = safeJson(value);
  return Array.isArray(parsed) ? parsed : [];
}

function detectSubscriptionCandidates(rows: Record<string, unknown>[]): Array<Record<string, unknown>> {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const text = subscriptionText(row);
    if (isSubscriptionBlocked(text, String(row.category ?? ""))) continue;
    const key = normalizeMerchantKey(String(row.merchant ?? "unknown"));
    const existing = groups.get(key) ?? [];
    existing.push(row);
    groups.set(key, existing);
  }

  return [...groups.entries()]
    .map(([merchantKey, group]) => scoreSubscriptionGroup(merchantKey, group))
    .filter((candidate): candidate is Record<string, unknown> => Boolean(candidate))
    .sort((left, right) => Number(right.score ?? 0) - Number(left.score ?? 0))
    .slice(0, 20);
}

function scoreSubscriptionGroup(merchantKey: string, group: Record<string, unknown>[]): Record<string, unknown> | null {
  const sorted = [...group].sort((left, right) => Number(left.occurred_at ?? 0) - Number(right.occurred_at ?? 0));
  const amounts = sorted.map((row) => Math.abs(Number(row.amount ?? 0))).filter((value) => Number.isFinite(value) && value > 0);
  if (amounts.length === 0) return null;

  const merchant = String(sorted[sorted.length - 1]?.merchant ?? merchantKey);
  const category = String(sorted[sorted.length - 1]?.category ?? "uncategorized");
  const text = sorted.map(subscriptionText).join(" ");
  const explicitSubscription = /\b(uber one|netflix|spotify|hulu|disney|google fi|apple\.com\/bill|subscription|monthly|membership)\b/i.test(text);
  const occurrences = amounts.length;
  if (occurrences < 2 && !explicitSubscription) return null;

  const average = averageOf(amounts);
  const amountStddev = stddevOf(amounts, average);
  const coefficientOfVariation = average > 0 ? amountStddev / average : 1;
  const dates = sorted.map((row) => Number(row.occurred_at ?? 0)).filter((value) => Number.isFinite(value) && value > 0);
  const intervals = dates.slice(1).map((date, index) => Math.abs(date - dates[index]) / (24 * 60 * 60));
  const intervalAverage = intervals.length > 0 ? averageOf(intervals) : null;
  const intervalStddev = intervals.length > 1 && intervalAverage !== null ? stddevOf(intervals, intervalAverage) : null;

  const amountStability = Math.max(0, 1 - Math.min(coefficientOfVariation, 1));
  const intervalRegularity = intervalStddev === null
    ? explicitSubscription ? 0.75 : 0.55
    : Math.max(0, 1 - Math.min(intervalStddev / 10, 1));
  const categoryPrior = subscriptionCategoryPrior(category, text);
  const score = roundScore(amountStability * intervalRegularity * categoryPrior);
  const stableEnough = coefficientOfVariation <= 0.15;
  const regularEnough = intervalStddev === null || intervalStddev <= 7;

  if (!explicitSubscription && (!stableEnough || !regularEnough || score < 0.35)) return null;
  if (score < 0.25) return null;

  return {
    merchant_key: merchantKey,
    merchant,
    category,
    average_amount: roundMoney(average),
    amount_stddev: roundMoney(amountStddev),
    coefficient_of_variation: roundScore(coefficientOfVariation),
    interval_average_days: intervalAverage === null ? null : roundScore(intervalAverage),
    interval_stddev_days: intervalStddev === null ? null : roundScore(intervalStddev),
    occurrences,
    first_seen: epochToIso(dates[0]),
    last_seen: epochToIso(dates[dates.length - 1]),
    score,
    explicit_subscription_signal: explicitSubscription,
    ai_subscription_candidate: sorted.some((row) => Number(row.ai_subscription_candidate ?? 0) > 0)
  };
}

function subscriptionText(row: Record<string, unknown>): string {
  return [
    row.merchant,
    row.description,
    row.payee,
    row.memo,
    row.category
  ].filter(Boolean).join(" ").toLowerCase();
}

function isSubscriptionBlocked(text: string, category: string): boolean {
  if (["transfers", "fees", "dining_offset"].includes(category)) return true;
  if (category === "dining" && /\bapple\b/i.test(text)) return true;
  return /\b(interest|payment|ach pmt|e-payment|epayment|adjustment|late fee|returned payment|return payment|gas|fuel|doordash|grubhub|uber eats|restaurant|mcdonald|costco gas)\b/i.test(text);
}

function subscriptionCategoryPrior(category: string, text: string): number {
  if (/\b(uber one|netflix|spotify|hulu|disney|google fi|apple\.com\/bill|membership|subscription)\b/i.test(text)) return 1;
  if (category === "subscriptions") return 0.95;
  if (category === "utilities") return 0.75;
  if (category === "entertainment") return 0.7;
  if (category === "health") return 0.55;
  if (category === "shopping") return 0.35;
  if (category === "dining" || category === "transport") return 0.2;
  return 0.4;
}

function normalizeMerchantKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() || "unknown";
}

function averageOf(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stddevOf(values: number[], average: number): number {
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function inclusiveDaySpan(startDate: string, endDate: string): number {
  const start = new Date(`${startDate}T00:00:00Z`).getTime();
  const end = new Date(`${endDate}T00:00:00Z`).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.floor((end - start) / (24 * 60 * 60 * 1000)) + 1;
}
