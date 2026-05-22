export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  AI: Ai;
  VECTOR_INDEX: VectorizeIndex;
  SIMPLEFIN_ACCESS_URL: string;
  MCP_BEARER_TOKEN: string;
  ADMIN_TOKEN: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  COOKIE_ENCRYPTION_KEY?: string;
  GITHUB_ALLOWED_LOGIN?: string;
  PUBLIC_ORIGIN?: string;
  PUBLIC_MCP_URL?: string;
  SYNC_DAYS?: string;
  INCREMENTAL_OVERLAP_DAYS?: string;
  DATA_MAX_STALENESS_HOURS?: string;
  AI_MODEL?: string;
  EMBEDDING_MODEL?: string;
}

export type ToolAuth = {
  isAdmin: boolean;
  login?: string;
  authType?: "bearer-admin" | "bearer-readonly" | "github-oauth";
};

export type SimpleFinTransaction = {
  id?: string;
  amount: string;
  description?: string;
  payee?: string;
  memo?: string;
  posted?: number;
  transacted?: number;
  posted_at?: number;
  transacted_at?: number;
  pending?: boolean;
  extra?: Record<string, unknown>;
  [key: string]: unknown;
};

export type SimpleFinConnection = {
  conn_id: string;
  name?: string;
  org_name?: string;
  org_url?: string;
  sfin_url?: string;
  [key: string]: unknown;
};

export type SimpleFinAccount = {
  id: string;
  name?: string;
  conn_id?: string;
  conn_name?: string;
  org?: {
    name?: string;
    domain?: string;
    [key: string]: unknown;
  };
  currency?: string;
  balance?: string;
  "available-balance"?: string;
  "balance-date"?: number;
  transactions?: SimpleFinTransaction[];
  [key: string]: unknown;
};

export type SimpleFinPayload = {
  accounts?: SimpleFinAccount[];
  connections?: SimpleFinConnection[];
  errlist?: unknown[];
  errors?: unknown[];
  [key: string]: unknown;
};

export type TransactionRow = {
  id: string;
  account_id: string;
  account_name?: string | null;
  conn_id?: string | null;
  conn_name?: string | null;
  org_name?: string | null;
  amount: number;
  description?: string | null;
  payee?: string | null;
  memo?: string | null;
  posted_at?: number | null;
  transacted_at?: number | null;
  pending: number;
  category?: string | null;
  merchant_normalized?: string | null;
  is_subscription_candidate?: number | null;
  confidence?: number | null;
  ai_reason?: string | null;
};

export type Enrichment = {
  transaction_id: string;
  category: string;
  merchant_normalized: string;
  is_subscription_candidate: boolean;
  confidence: number;
  ai_reason: string;
  model: string;
};

export type SyncOptions = {
  startDate?: string;
  endDate?: string;
  days?: number;
  pending?: boolean;
  trigger: "scheduled" | "manual" | "auto_backfill";
  force?: boolean;
};
