import { oauthProviderFor } from "./oauth.js";
import { errorJson } from "./http.js";
import { syncSimpleFin } from "./sync.js";
import { purgeOperationalEvents, saveHttpEvent, saveScheduledSyncEvent, saveWorkerErrorEvent } from "./telemetry.js";
import type { Env } from "./types.js";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const startedAt = performance.now();
    const url = new URL(request.url);
    try {
      const compatibilityResponse = oauthCompatibilityResponse(request, env);
      if (compatibilityResponse) {
        if (shouldAuditHttp(url.pathname, compatibilityResponse.status)) {
          ctx.waitUntil(
            saveHttpEvent(env, {
              path: url.pathname,
              method: request.method,
              status: compatibilityResponse.status,
              durationMs: elapsedMs(startedAt)
            })
          );
        }
        return compatibilityResponse;
      }

      const registrationError = await validateClientRegistration(request);
      const response = registrationError ?? await maybeNormalizeRegistrationResponse(
        request,
        await oauthProviderFor(env, request).fetch(request, env, ctx)
      );
      if (shouldAuditHttp(url.pathname, response.status)) {
        ctx.waitUntil(
          saveHttpEvent(env, {
            path: url.pathname,
            method: request.method,
            status: response.status,
            durationMs: elapsedMs(startedAt)
          })
        );
      }
      return response;
    } catch (error) {
      ctx.waitUntil(saveWorkerErrorEvent(env, {
        path: url.pathname,
        method: request.method,
        durationMs: elapsedMs(startedAt),
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
  const startedAt = performance.now();
  try {
    const result = await syncSimpleFin(env, { trigger: "scheduled", pending: true });
    await saveScheduledSyncEvent(env, { status: "ok", durationMs: elapsedMs(startedAt), result });
  } catch (error) {
    await saveScheduledSyncEvent(env, { status: "error", durationMs: elapsedMs(startedAt), error });
    throw error;
  }
}

function elapsedMs(startedAt: number): number {
  return Math.max(1, Math.round(performance.now() - startedAt));
}

function shouldAuditHttp(path: string, status: number): boolean {
  if (path === "/mcp") return status >= 400;
  return path.startsWith("/register") || path.startsWith("/.well-known/") || new Set([
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

function oauthCompatibilityResponse(request: Request, env: Env): Response | undefined {
  const url = new URL(request.url);
  const corsPaths = new Set([
    "/register",
    "/authorize",
    "/callback",
    "/token",
    "/mcp",
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/mcp",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp"
  ]);

  if (request.method === "OPTIONS" && corsPaths.has(url.pathname)) {
    return new Response(null, {
      status: 204,
      headers: oauthCorsHeaders()
    });
  }

  if (request.method !== "GET") return undefined;

  const origin = publicOrigin(env, request);
  const mcpUrl = env.PUBLIC_MCP_URL ?? `${origin}/mcp`;

  if (
    url.pathname === "/.well-known/oauth-authorization-server" ||
    url.pathname === "/.well-known/oauth-authorization-server/mcp"
  ) {
    return oauthJson({
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      scopes_supported: ["finance:read", "finance:admin"],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
      revocation_endpoint: `${origin}/token`,
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: false
    });
  }

  if (
    url.pathname === "/.well-known/oauth-protected-resource" ||
    url.pathname === "/.well-known/oauth-protected-resource/mcp"
  ) {
    return oauthJson({
      resource: mcpUrl,
      authorization_servers: [origin],
      scopes_supported: ["finance:read", "finance:admin"],
      bearer_methods_supported: ["header"],
      resource_name: "SimpleFIN Finance MCP"
    });
  }

  return undefined;
}

async function maybeNormalizeRegistrationResponse(request: Request, response: Response): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/register" || request.method !== "POST" || response.status !== 201) {
    return response;
  }

  const body = await response.clone().json() as Record<string, unknown>;
  delete body.registration_client_uri;
  return new Response(JSON.stringify(body), {
    status: response.status,
    headers: {
      ...oauthCorsHeaders(),
      "content-type": "application/json"
    }
  });
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
  if (!Array.isArray(redirectUris) || redirectUris.length < 1 || redirectUris.length > 20) {
    return errorJson("invalid_redirect_uris", 400, {
      code: "invalid_redirect_uris",
      reason: "redirect_uris must contain 1 to 20 URI strings"
    });
  }

  for (const redirectUri of redirectUris) {
    if (typeof redirectUri !== "string" || !isAllowedRedirectUri(redirectUri)) {
      return errorJson("invalid_redirect_uri", 400, {
        code: "invalid_redirect_uri",
        reason: "redirect URIs must be valid and must not use dangerous browser-executable schemes"
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
  const normalized = value.trim();
  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index);
    if ((code >= 0 && code <= 31) || (code >= 127 && code <= 159)) return false;
  }
  const colonIndex = normalized.indexOf(":");
  if (colonIndex <= 0) {
    return false;
  }
  const scheme = normalized.slice(0, colonIndex + 1).toLowerCase();
  return !new Set(["javascript:", "data:", "vbscript:", "file:", "mailto:", "blob:"]).has(scheme);
}

function oauthJson(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...oauthCorsHeaders(),
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function oauthCorsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,mcp-protocol-version",
    "access-control-max-age": "86400",
    "vary": "origin"
  };
}

function publicOrigin(env: Env, request: Request): string {
  if (env.PUBLIC_ORIGIN) return env.PUBLIC_ORIGIN.replace(/\/+$/, "");
  return new URL(request.url).origin;
}
