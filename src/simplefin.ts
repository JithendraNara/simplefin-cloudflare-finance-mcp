export type SimpleFinTransaction = {
  id?: string;
  amount: string;
  description?: string;
  payee?: string;
  memo?: string;
  posted?: number;
  transacted?: number;
  transacted_at?: number;
  posted_at?: number;
  pending?: boolean;
  [key: string]: unknown;
};

export type SimpleFinAccount = {
  id: string;
  name?: string;
  org?: {
    name?: string;
    domain?: string;
    "sfin-url"?: string;
    [key: string]: unknown;
  };
  balance?: string;
  "available-balance"?: string;
  currency?: string;
  transactions?: SimpleFinTransaction[];
  [key: string]: unknown;
};

export type SimpleFinAccountsResponse = {
  accounts?: SimpleFinAccount[];
  errors?: unknown[];
  errlist?: unknown[];
  [key: string]: unknown;
};

export type FetchAccountsOptions = {
  startDate?: string;
  endDate?: string;
  pending?: boolean;
};

export class SimpleFinClient {
  constructor(private readonly accessUrl: string | undefined) {}

  isConfigured(): boolean {
    return Boolean(this.accessUrl);
  }

  async fetchAccounts(options: FetchAccountsOptions = {}): Promise<SimpleFinAccountsResponse> {
    if (!this.accessUrl) {
      throw new Error("SIMPLEFIN_ACCESS_URL is not configured yet");
    }

    const url = new URL(joinUrl(this.accessUrl, "accounts"));
    const authorization = basicAuthHeader(url);
    url.searchParams.set("version", "2");

    if (options.startDate) url.searchParams.set("start-date", dateToEpoch(options.startDate));
    if (options.endDate) url.searchParams.set("end-date", dateToEpoch(options.endDate));
    if (options.pending) url.searchParams.set("pending", "1");

    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        ...(authorization ? { authorization } : {}),
        "user-agent": "simplefin-mcp/0.1.0"
      }
    });

    const text = await response.text();
    const payload = parseJson(text);

    if (!response.ok) {
      throw new Error(`SimpleFIN returned HTTP ${response.status}: ${summarizePayload(payload, text)}`);
    }

    return payload as SimpleFinAccountsResponse;
  }
}

export function normalizeAccounts(payload: SimpleFinAccountsResponse): SimpleFinAccount[] {
  if (!Array.isArray(payload.accounts)) return [];
  return payload.accounts.filter((account): account is SimpleFinAccount => typeof account.id === "string");
}

export function collectTransactions(
  accounts: SimpleFinAccount[],
  accountId?: string
): Array<SimpleFinTransaction & { account_id: string; account_name?: string; org_name?: string }> {
  return accounts
    .filter((account) => !accountId || account.id === accountId)
    .flatMap((account) =>
      (account.transactions ?? []).map((transaction) => ({
        ...transaction,
        account_id: account.id,
        account_name: account.name,
        org_name: account.org?.name
      }))
    );
}

export function toNumber(amount: string | undefined): number {
  if (!amount) return 0;
  const parsed = Number.parseFloat(amount);
  return Number.isFinite(parsed) ? parsed : 0;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function basicAuthHeader(url: URL): string | undefined {
  if (!url.username && !url.password) return undefined;
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  url.username = "";
  url.password = "";
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function dateToEpoch(value: string): string {
  return String(Math.floor(new Date(`${value}T00:00:00Z`).getTime() / 1000));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function summarizePayload(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object") {
    return JSON.stringify(payload).slice(0, 500);
  }

  return fallback.slice(0, 500);
}
