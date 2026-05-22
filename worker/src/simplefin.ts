import type { SimpleFinPayload, SimpleFinTransaction } from "./types.js";

export async function claimSetupToken(setupToken: string): Promise<string> {
  const claimUrl = decodeSetupToken(setupToken);

  if (!claimUrl.startsWith("https://")) {
    throw new Error("SimpleFIN claim URL must be HTTPS");
  }

  const response = await fetch(claimUrl, {
    method: "POST",
    headers: {
      "content-length": "0",
      "user-agent": "simplefin-finance-mcp/0.1.0"
    }
  });

  const body = await response.text();
  if (response.status === 403) {
    throw new Error("SimpleFIN setup token was rejected or already claimed");
  }
  if (!response.ok) {
    throw new Error(`SimpleFIN claim failed with HTTP ${response.status}`);
  }
  if (!body.startsWith("https://")) {
    throw new Error("SimpleFIN claim did not return an HTTPS Access URL");
  }

  return body.trim();
}

export async function fetchSimpleFinAccounts(
  accessUrl: string,
  options: { startDate?: string; endDate?: string; pending?: boolean; accountIds?: string[]; balancesOnly?: boolean }
): Promise<SimpleFinPayload> {
  const url = new URL(`${accessUrl.replace(/\/+$/, "")}/accounts`);
  const authorization = basicAuthHeader(url);
  url.searchParams.set("version", "2");

  if (options.startDate) url.searchParams.set("start-date", dateToEpoch(options.startDate));
  if (options.endDate) url.searchParams.set("end-date", dateToEpoch(options.endDate));
  if (options.pending) url.searchParams.set("pending", "1");
  if (options.balancesOnly) url.searchParams.set("balances-only", "1");
  for (const accountId of options.accountIds ?? []) {
    url.searchParams.append("account", accountId);
  }

  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      ...(authorization ? { authorization } : {}),
      "user-agent": "simplefin-finance-mcp/0.1.0"
    }
  });

  const text = await response.text();
  const payload = text ? safeJson(text) : {};

  if (response.status === 403) {
    throw new Error("SimpleFIN access was rejected or revoked");
  }
  if (!response.ok) {
    throw new Error(`SimpleFIN returned HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  return payload as SimpleFinPayload;
}

export function transactionPostedAt(transaction: SimpleFinTransaction): number | null {
  return transaction.posted_at ?? transaction.posted ?? null;
}

export function transactionTransactedAt(transaction: SimpleFinTransaction): number | null {
  return transaction.transacted_at ?? transaction.transacted ?? null;
}

export function transactionAmount(transaction: SimpleFinTransaction): number {
  return toNumber(transaction.amount);
}

export function stableTransactionId(accountId: string, transaction: SimpleFinTransaction): string {
  if (transaction.id) return `${accountId}:${transaction.id}`;
  const timestamp = transactionPostedAt(transaction) ?? transactionTransactedAt(transaction) ?? "unknown";
  const label = transaction.description ?? transaction.payee ?? transaction.memo ?? "";
  return `${accountId}:${timestamp}:${transaction.amount}:${label}`;
}

export function dateToEpoch(value: string): string {
  return String(Math.floor(new Date(`${value}T00:00:00Z`).getTime() / 1000));
}

export function toNumber(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function nullableNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function decodeSetupToken(setupToken: string): string {
  try {
    return atob(setupToken.trim());
  } catch {
    throw new Error("SimpleFIN setup token is not valid base64");
  }
}

function basicAuthHeader(url: URL): string | undefined {
  if (!url.username && !url.password) return undefined;
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  url.username = "";
  url.password = "";
  return `Basic ${btoa(`${username}:${password}`)}`;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
