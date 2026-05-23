import { oauthProviderFor } from "./oauth.js";
import { errorJson } from "./http.js";
import { syncSimpleFin } from "./sync.js";
import { purgeOperationalEvents, saveHttpEvent, saveScheduledSyncEvent, saveWorkerErrorEvent } from "./telemetry.js";
import type { Env } from "./types.js";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const startedAt = Date.now();
    const url = new URL(request.url);
    try {
      const registrationError = await validateClientRegistration(request);
      const response = registrationError ?? await oauthProviderFor(env, request).fetch(request, env, ctx);
      if (shouldAuditHttp(url.pathname, response.status)) {
        ctx.waitUntil(
          saveHttpEvent(env, {
            path: url.pathname,
            method: request.method,
            status: response.status,
            durationMs: Date.now() - startedAt
          })
        );
      }
      return response;
    } catch (error) {
      ctx.waitUntil(saveWorkerErrorEvent(env, {
        path: url.pathname,
        method: request.method,
        durationMs: Date.now() - startedAt,
        error
      }));
      return new Response(JSON.stringify({ error: "internal_error" }), {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduledSync(env));
    ctx.waitUntil(oauthProviderFor(env).purgeExpiredData(env, { batchSize: 100 }));
    ctx.waitUntil(purgeOperationalEvents(env));
  }
} satisfies ExportedHandler<Env>;

async function runScheduledSync(env: Env): Promise<void> {
  const startedAt = Date.now();
  try {
    const result = await syncSimpleFin(env, { trigger: "scheduled", pending: true });
    await saveScheduledSyncEvent(env, { status: "ok", durationMs: Date.now() - startedAt, result });
  } catch (error) {
    await saveScheduledSyncEvent(env, { status: "error", durationMs: Date.now() - startedAt, error });
    throw error;
  }
}

function shouldAuditHttp(path: string, status: number): boolean {
  if (path === "/mcp") return status >= 400;
  return new Set([
    "/health",
    "/ready",
    "/authorize",
    "/callback",
    "/token",
    "/register",
    "/admin/sync",
    "/admin/debug/accounts",
    "/admin/debug/transactions",
    "/admin/debug/events",
    "/admin/oauth/grants",
    "/admin/oauth/revoke"
  ]).has(path);
}

async function validateClientRegistration(request: Request): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== "/register" || request.method !== "POST") return undefined;

  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return errorJson("invalid_client_registration_json", 400, {
      code: "invalid_client_registration_json"
    });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorJson("invalid_client_registration_body", 400, {
      code: "invalid_client_registration_body"
    });
  }

  const metadata = body as Record<string, unknown>;
  const redirectUris = metadata.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length < 1 || redirectUris.length > 5) {
    return errorJson("invalid_redirect_uris", 400, {
      code: "invalid_redirect_uris",
      reason: "redirect_uris must contain 1 to 5 URI strings"
    });
  }

  for (const redirectUri of redirectUris) {
    if (typeof redirectUri !== "string" || !isAllowedRedirectUri(redirectUri)) {
      return errorJson("invalid_redirect_uri", 400, {
        code: "invalid_redirect_uri",
        reason: "redirect URIs must be https URLs or loopback http URLs"
      });
    }
  }

  const authMethod = typeof metadata.token_endpoint_auth_method === "string"
    ? metadata.token_endpoint_auth_method
    : "client_secret_basic";
  if (!["none", "client_secret_basic", "client_secret_post"].includes(authMethod)) {
    return errorJson("invalid_token_endpoint_auth_method", 400, {
      code: "invalid_token_endpoint_auth_method"
    });
  }

  const responseTypes = Array.isArray(metadata.response_types) ? metadata.response_types : ["code"];
  if (responseTypes.some((responseType) => responseType !== "code")) {
    return errorJson("unsupported_response_type", 400, {
      code: "unsupported_response_type",
      reason: "only authorization_code flow is supported"
    });
  }

  const grantTypes = Array.isArray(metadata.grant_types) ? metadata.grant_types : ["authorization_code"];
  const allowedGrantTypes = new Set(["authorization_code", "refresh_token"]);
  if (grantTypes.some((grantType) => typeof grantType !== "string" || !allowedGrantTypes.has(grantType))) {
    return errorJson("unsupported_grant_type", 400, {
      code: "unsupported_grant_type",
      reason: "only authorization_code and refresh_token grants are supported"
    });
  }

  return undefined;
}

function isAllowedRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  return ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
}
