import { oauthProviderFor } from "./oauth.js";
import { errorJson } from "./http.js";
import { syncSimpleFin } from "./sync.js";
import type { Env } from "./types.js";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
	      const registrationError = await validateClientRegistration(request);
	      if (registrationError) return registrationError;
	      return oauthProviderFor(env, request).fetch(request, env, ctx);
    } catch (error) {
      const url = new URL(request.url);
      console.error(JSON.stringify({
        event: "worker_error",
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error)
      }));
      return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "internal_error" }), {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    }
  },

	  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
	    ctx.waitUntil(syncSimpleFin(env, { trigger: "scheduled", pending: true }));
	    ctx.waitUntil(oauthProviderFor(env).purgeExpiredData(env, { batchSize: 100 }));
	  }
} satisfies ExportedHandler<Env>;

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
