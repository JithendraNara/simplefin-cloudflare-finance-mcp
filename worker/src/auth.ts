import type { Env, ToolAuth } from "./types.js";
import { errorJson } from "./http.js";

export async function authorizeMcp(request: Request, env: Env): Promise<ToolAuth | Response> {
  const header = request.headers.get("authorization") ?? "";

  if (await timingSafeBearerEquals(header, env.ADMIN_TOKEN)) {
    return { isAdmin: true };
  }

  if (await timingSafeBearerEquals(header, env.MCP_BEARER_TOKEN)) {
    return { isAdmin: false };
  }

  return errorJson("unauthorized", 401);
}

export async function authorizeAdmin(request: Request, env: Env): Promise<Response | undefined> {
  const header = request.headers.get("authorization") ?? "";
  if (await timingSafeBearerEquals(header, env.ADMIN_TOKEN)) return undefined;
  return errorJson("unauthorized", 401);
}

export async function authForStaticBearerToken(token: string, env: Env): Promise<ToolAuth | undefined> {
  if (await timingSafeEquals(token, env.ADMIN_TOKEN)) {
    return { isAdmin: true, login: "legacy-admin", authType: "bearer-admin" };
  }

  if (await timingSafeEquals(token, env.MCP_BEARER_TOKEN)) {
    return { isAdmin: false, login: "legacy-reader", authType: "bearer-readonly" };
  }

  return undefined;
}

export function requireAdmin(auth: ToolAuth): void {
  if (!auth.isAdmin) {
    throw new Error("admin token required for this tool");
  }
}

async function timingSafeBearerEquals(header: string, secret: string | undefined): Promise<boolean> {
  if (!secret) return false;
  return timingSafeEquals(header, `Bearer ${secret}`);
}

async function timingSafeEquals(left: string, right: string | undefined): Promise<boolean> {
  if (!right) return false;
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);

  if (leftBytes.length !== rightBytes.length) {
    await crypto.subtle.digest("SHA-256", leftBytes);
    return false;
  }

  const leftDigest = await crypto.subtle.digest("SHA-256", leftBytes);
  const rightDigest = await crypto.subtle.digest("SHA-256", rightBytes);
  const leftView = new Uint8Array(leftDigest);
  const rightView = new Uint8Array(rightDigest);

  let diff = 0;
  for (let index = 0; index < leftView.length; index += 1) {
    diff |= leftView[index] ^ rightView[index];
  }

  return diff === 0;
}
