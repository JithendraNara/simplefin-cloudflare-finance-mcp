import type { Env, ToolAuth } from "./types.js";

export async function saveHttpEvent(env: Env, data: {
  path: string;
  method: string;
  status: number;
  durationMs: number;
}): Promise<void> {
  await saveOperationalEvent(env, {
    eventType: "http_request",
    path: data.path,
    method: data.method,
    status: data.status,
    durationMs: data.durationMs
  });
}

export async function saveMcpEvent(env: Env, data: {
  operation: string;
  auth: ToolAuth;
  status: number;
  durationMs: number;
}): Promise<void> {
  await saveOperationalEvent(env, {
    eventType: "mcp_request",
    path: "/mcp",
    method: "POST",
    operation: data.operation,
    authType: data.auth.authType ?? "unknown",
    isAdmin: data.auth.isAdmin,
    status: data.status,
    durationMs: data.durationMs
  });
}

export async function saveScheduledSyncEvent(env: Env, data: {
  status: "ok" | "error";
  durationMs: number;
  result?: Record<string, unknown>;
  error?: unknown;
}): Promise<void> {
  await saveOperationalEvent(env, {
    eventType: "scheduled_sync",
    path: "cron",
    method: "SCHEDULED",
    status: data.status === "ok" ? 200 : 500,
    durationMs: data.durationMs,
    details: {
      outcome: data.status,
      account_count: numberField(data.result?.account_count),
      transaction_count: numberField(data.result?.transaction_count),
      error_code: data.error ? errorCode(data.error) : undefined
    }
  });
}

export async function saveWorkerErrorEvent(env: Env, data: {
  path: string;
  method: string;
  durationMs: number;
  error: unknown;
}): Promise<void> {
  await saveOperationalEvent(env, {
    eventType: "worker_error",
    path: data.path,
    method: data.method,
    status: 500,
    durationMs: data.durationMs,
    details: {
      error_code: errorCode(data.error)
    }
  });
}

export async function purgeOperationalEvents(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - (30 * 24 * 60 * 60 * 1000)).toISOString();
  await env.DB.prepare("DELETE FROM operational_events WHERE created_at < ?").bind(cutoff).run();
}

async function saveOperationalEvent(env: Env, data: {
  eventType: string;
  path?: string;
  method?: string;
  operation?: string;
  authType?: string;
  isAdmin?: boolean;
  status: number;
  durationMs: number;
  details?: Record<string, unknown>;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO operational_events
     (id, created_at, event_type, path, method, operation, auth_type, is_admin, status, duration_ms, details_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      crypto.randomUUID(),
      new Date().toISOString(),
      data.eventType,
      data.path ?? null,
      data.method ?? null,
      data.operation ?? null,
      data.authType ?? null,
      data.isAdmin === undefined ? null : data.isAdmin ? 1 : 0,
      data.status,
      data.durationMs,
      JSON.stringify(data.details ?? {})
    )
    .run();
}

export function errorCode(error: unknown): string {
  if (error instanceof Error) {
    if (error.name) return error.name;
    return "Error";
  }
  return "unknown_error";
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
