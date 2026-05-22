import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Config } from "./config.js";
import { createServer } from "./server.js";

export async function startStdioServer(config: Config): Promise<void> {
  const mcp = createServer(config);
  const transport = new StdioServerTransport();
  await mcp.server.connect(transport);
}
