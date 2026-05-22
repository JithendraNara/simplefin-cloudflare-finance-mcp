import { createMcpHandler } from "agents/mcp";
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  getOAuthApi,
  OAuthProvider,
  type AuthRequest,
  type OAuthProviderOptions
} from "@cloudflare/workers-oauth-provider";
import { authForStaticBearerToken, authorizeAdmin } from "./auth.js";
import { errorJson, json, parseNumber } from "./http.js";
import { createFinanceMcpServer } from "./mcp.js";
import { FinanceRepository } from "./repository.js";
import { syncSimpleFin } from "./sync.js";
import type { Env, ToolAuth } from "./types.js";

const DEFAULT_ORIGIN = "https://your-finance-domain.example.com";
const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const GITHUB_STATE_TTL_SECONDS = 600;
const OAUTH_SCOPES = ["finance:read", "finance:admin"];

export type OAuthMcpProps = ToolAuth & {
  githubId?: number;
};

class FinanceMcpApiHandler extends WorkerEntrypoint<Env, OAuthMcpProps> {
  async fetch(request: Request): Promise<Response> {
    const props = this.ctx.props;
    const auth: ToolAuth = {
      isAdmin: props?.isAdmin === true,
      login: props?.login,
      authType: props?.authType
    };
    const server = createFinanceMcpServer(this.env, auth);
    return createMcpHandler(server, { route: "/mcp" })(request, this.env, this.ctx);
  }
}

const defaultHandler: ExportedHandler<Env> = {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/authorize") {
      return handleAuthorize(request, env);
    }

    if (url.pathname === "/callback") {
      return handleCallback(request, env);
    }

    if (url.pathname === "/health") {
      return json(await new FinanceRepository(env).status());
    }

    if (url.pathname === "/ready") {
      const operational = await new FinanceRepository(env).operationalStatus();
      const readiness = operational.readiness as { ready?: boolean };
      return json(operational, readiness.ready ? 200 : 503);
    }

    if (url.pathname === "/admin/sync" && request.method === "POST") {
      const unauthorized = await authorizeAdmin(request, env);
      if (unauthorized) return unauthorized;
      const body = await readJsonBody(request);
      const requestedDays = url.searchParams.get("days");
      const bodyDays = typeof body.days === "number" ? body.days : undefined;
      const startDate = typeof body.startDate === "string" ? body.startDate : url.searchParams.get("startDate") ?? undefined;
      const endDate = typeof body.endDate === "string" ? body.endDate : url.searchParams.get("endDate") ?? undefined;
      return json(await syncSimpleFin(env, {
        startDate,
        endDate,
        days: requestedDays ? parseNumber(requestedDays, 1, 1, 90) : bodyDays,
        pending: typeof body.pending === "boolean" ? body.pending : url.searchParams.get("pending") !== "0",
        force: body.force === true || url.searchParams.get("force") === "1",
        trigger: "manual"
      }));
    }

    if (url.pathname === "/admin/debug/accounts") {
      const unauthorized = await authorizeAdmin(request, env);
      if (unauthorized) return unauthorized;
      return json(await new FinanceRepository(env).listAccounts());
    }

    if (url.pathname === "/admin/debug/transactions") {
      const unauthorized = await authorizeAdmin(request, env);
      if (unauthorized) return unauthorized;
      const repo = new FinanceRepository(env);
      const transactions = await repo.getTransactions({
        accountId: url.searchParams.get("account_id") ?? undefined,
        limit: parseNumber(url.searchParams.get("limit"), 200, 1, 1000)
      });
      return json({ transactions, count: transactions.length });
    }

    return errorJson("not_found", 404);
  }
};

export function oauthProviderFor(env: Env, request?: Request): OAuthProvider<Env> {
  return new OAuthProvider<Env>(oauthOptionsFor(env, request));
}

async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const missing = missingGitHubConfig(env);
  if (missing.length > 0) {
    return errorJson("github_oauth_not_configured", 500, { missing });
  }

  const oauthOptions = oauthOptionsFor(env, request);
  const oauth = getOAuthApi(oauthOptions, env);
  const authRequest = await oauth.parseAuthRequest(request);
  const client = await oauth.lookupClient(authRequest.clientId);
  if (!client) return errorJson("unknown_oauth_client", 400);

  const state = crypto.randomUUID();
  await env.OAUTH_KV.put(githubStateKey(state), JSON.stringify(authRequest), {
    expirationTtl: GITHUB_STATE_TTL_SECONDS
  });

  const redirect = new URL(GITHUB_AUTHORIZE_URL);
  redirect.searchParams.set("client_id", env.GITHUB_CLIENT_ID ?? "");
  redirect.searchParams.set("redirect_uri", `${publicOrigin(env, request)}/callback`);
  redirect.searchParams.set("scope", "read:user");
  redirect.searchParams.set("state", state);
  return Response.redirect(redirect.toString(), 302);
}

async function handleCallback(request: Request, env: Env): Promise<Response> {
  const missing = missingGitHubConfig(env);
  if (missing.length > 0) {
    return errorJson("github_oauth_not_configured", 500, { missing });
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return errorJson("missing_github_oauth_callback_params", 400);

  const storedRequest = await env.OAUTH_KV.get(githubStateKey(state), { type: "json" });
  await env.OAUTH_KV.delete(githubStateKey(state));
  if (!isAuthRequest(storedRequest)) return errorJson("expired_or_invalid_oauth_state", 400);

  const githubAccessToken = await exchangeGitHubCode(code, env);
  const githubUser = await fetchGitHubUser(githubAccessToken);
  const allowedLogin = env.GITHUB_ALLOWED_LOGIN ?? "";
  if (!allowedLogin) return errorJson("github_allowed_login_not_configured", 500);
  if (githubUser.login !== allowedLogin) {
    return errorJson("github_login_not_allowed", 403, { login: githubUser.login });
  }

  const oauth = getOAuthApi(oauthOptionsFor(env, request), env);
  const { redirectTo } = await oauth.completeAuthorization({
    request: storedRequest,
    userId: `github-${githubUser.id}`,
    metadata: {
      provider: "github",
      login: githubUser.login
    },
    scope: grantScopes(storedRequest.scope),
    props: {
      isAdmin: true,
      login: githubUser.login,
      githubId: githubUser.id,
      authType: "github-oauth"
    } satisfies OAuthMcpProps
  });

  return Response.redirect(redirectTo, 302);
}

async function exchangeGitHubCode(code: string, env: Env): Promise<string> {
  const response = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      "accept": "application/json",
      "content-type": "application/json",
      "user-agent": "simplefin-finance-mcp"
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${publicOrigin(env)}/callback`
    })
  });

  const payload = await response.json() as { access_token?: string; error?: string; error_description?: string };
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description ?? payload.error ?? "github_token_exchange_failed");
  }
  return payload.access_token;
}

async function fetchGitHubUser(accessToken: string): Promise<{ id: number; login: string }> {
  const response = await fetch(GITHUB_USER_URL, {
    headers: {
      "accept": "application/vnd.github+json",
      "authorization": `Bearer ${accessToken}`,
      "user-agent": "simplefin-finance-mcp"
    }
  });
  const payload = await response.json() as { id?: number; login?: string; message?: string };
  if (!response.ok || typeof payload.id !== "number" || typeof payload.login !== "string") {
    throw new Error(payload.message ?? "github_user_fetch_failed");
  }
  return { id: payload.id, login: payload.login };
}

function grantScopes(requestedScopes: string[]): string[] {
  const requested = requestedScopes.length > 0 ? requestedScopes : OAUTH_SCOPES;
  const allowed = requested.filter((scope) => OAUTH_SCOPES.includes(scope));
  return allowed.length > 0 ? allowed : OAUTH_SCOPES;
}

function missingGitHubConfig(env: Env): string[] {
  const missing: string[] = [];
  if (!env.GITHUB_CLIENT_ID) missing.push("GITHUB_CLIENT_ID");
  if (!env.GITHUB_CLIENT_SECRET) missing.push("GITHUB_CLIENT_SECRET");
  return missing;
}

function oauthOptionsFor(env: Env, request?: Request): OAuthProviderOptions<Env> {
  const origin = publicOrigin(env, request);
  const mcpUrl = env.PUBLIC_MCP_URL ?? `${origin}/mcp`;
  return {
    apiRoute: "/mcp",
    apiHandler: FinanceMcpApiHandler,
    defaultHandler,
    authorizeEndpoint: `${origin}/authorize`,
    tokenEndpoint: `${origin}/token`,
    clientRegistrationEndpoint: `${origin}/register`,
    accessTokenTTL: 60 * 60,
    refreshTokenTTL: 60 * 60 * 24 * 30,
    clientRegistrationTTL: 60 * 60 * 24 * 90,
    scopesSupported: OAUTH_SCOPES,
    allowPlainPKCE: false,
    resourceMetadata: {
      resource: mcpUrl,
      authorization_servers: [origin],
      scopes_supported: OAUTH_SCOPES,
      bearer_methods_supported: ["header"],
      resource_name: "SimpleFIN Finance MCP"
    },
    resolveExternalToken: async ({ token, env }) => {
      const auth = await authForStaticBearerToken(token, env as Env);
      return auth ? { props: auth, audience: mcpUrl } : null;
    },
    onError: (error) => {
      console.error(JSON.stringify({
        event: "oauth_error",
        code: error.code,
        status: error.status,
        description: error.description,
        internal: error.internal
      }));
    }
  };
}

function publicOrigin(env: Env, request?: Request): string {
  if (env.PUBLIC_ORIGIN) return env.PUBLIC_ORIGIN.replace(/\/+$/, "");
  if (request) return new URL(request.url).origin;
  return DEFAULT_ORIGIN;
}

function githubStateKey(state: string): string {
  return `github-oauth-state:${state}`;
}

function isAuthRequest(value: unknown): value is AuthRequest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AuthRequest>;
  return typeof candidate.responseType === "string"
    && typeof candidate.clientId === "string"
    && typeof candidate.redirectUri === "string"
    && Array.isArray(candidate.scope)
    && typeof candidate.state === "string";
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.includes("application/json")) return {};
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
