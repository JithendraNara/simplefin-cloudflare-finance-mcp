import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { SimpleFinClient } from "./simplefin.js";
import { FinanceStore } from "./store.js";
import { registerTools } from "./tools.js";

export type SimpleFinMcpServer = {
  server: McpServer;
  close: () => void;
};

export function createServer(config: Config): SimpleFinMcpServer {
  const server = new McpServer(
    {
      name: "simplefin-mcp",
      version: "0.1.0"
    },
    {
      capabilities: {
        logging: {}
      }
    }
  );

  const store = new FinanceStore(config.dbPath);
  registerTools(server, new SimpleFinClient(config.accessUrl), store);
  return {
    server,
    close: () => {
      server.close();
      store.close();
    }
  };
}
