import process from "node:process";

export type Config = {
  accessUrl?: string;
  host: string;
  port: number;
  dbPath: string;
  bearerToken?: string;
};

export function loadConfig(): Config {
  const port = Number.parseInt(process.env.SIMPLEFIN_MCP_PORT ?? "3344", 10);

  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error("SIMPLEFIN_MCP_PORT must be a valid TCP port");
  }

  return {
    accessUrl: clean(process.env.SIMPLEFIN_ACCESS_URL),
    host: process.env.SIMPLEFIN_MCP_HOST ?? "127.0.0.1",
    port,
    dbPath: process.env.SIMPLEFIN_DB_PATH ?? "data/simplefin.sqlite",
    bearerToken: clean(process.env.SIMPLEFIN_MCP_BEARER_TOKEN)
  };
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
