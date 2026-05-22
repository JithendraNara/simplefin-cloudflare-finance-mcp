#!/usr/bin/env node
import "dotenv/config";
import { loadConfig } from "./config.js";
import { startHttpServer } from "./http.js";
import { startStdioServer } from "./stdio.js";

const transport = readTransport();
const config = loadConfig();

if (transport === "http") {
  startHttpServer(config);
} else {
  await startStdioServer(config);
}

function readTransport(): "http" | "stdio" {
  const index = process.argv.indexOf("--transport");
  const value = index >= 0 ? process.argv[index + 1] : process.env.SIMPLEFIN_MCP_TRANSPORT;

  if (value === "http" || value === "stdio") return value;
  return "stdio";
}
