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
  AI_TEXT_PROVIDER?: string;
  AI_ROUTE_CATEGORIZE_TRANSACTIONS?: string;
  AI_ROUTE_FIND_UNUSUAL_TRANSACTIONS?: string;
  AI_ROUTE_GENERATE_WEEKLY_MONEY_BRIEFING?: string;
  AI_ROUTE_QUERY_FINANCE?: string;
  AI_ROUTE_REVIEW_UNCATEGORIZED_SUGGESTIONS?: string;
  AI_ROUTE_RECATEGORIZE_LOW_CONFIDENCE?: string;
  AI_ROUTE_GENERATE_CORRECTION_RULE_TEXT?: string;
  AI_GATEWAY_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
  AI_GATEWAY_PROVIDER?: string;
  AI_GATEWAY_TOKEN?: string;
  MINIMAX_MODEL?: string;
  MINIMAX_TOTAL_PER_5HOURS?: string;
  MINIMAX_LIMIT_GENERATE_WEEKLY_MONEY_BRIEFING?: string;
  MINIMAX_LIMIT_FIND_UNUSUAL_TRANSACTIONS?: string;
  MINIMAX_LIMIT_QUERY_FINANCE?: string;
  MINIMAX_LIMIT_RECATEGORIZE_LOW_CONFIDENCE?: string;
  MINIMAX_LIMIT_GENERATE_CORRECTION_RULE_TEXT?: string;
  MINIMAX_LIMIT_REVIEW_UNCATEGORIZED_SUGGESTIONS?: string;
  ENABLE_MINIMAX_CATEGORIZER_FALLBACK?: string;
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
  model?: string | null;
  enrichment_source?: string | null;
  prior_enrichment_json?: string | null;
  last_minimax_review_at?: string | null;
  minimax_review_status?: string | null;
  manual_review_suggested?: number | null;
};

export type Enrichment = {
  transaction_id: string;
  category: string;
  merchant_normalized: string;
  is_subscription_candidate: boolean;
  confidence: number;
  ai_reason: string;
  model: string;
  enrichment_source?: string;
  prior_enrichment_json?: string | null;
  last_minimax_review_at?: string | null;
  minimax_review_status?: string | null;
  manual_review_suggested?: boolean;
};

export type SyncOptions = {
  startDate?: string;
  endDate?: string;
  days?: number;
  pending?: boolean;
  trigger: "scheduled" | "manual" | "auto_backfill";
  force?: boolean;
};
