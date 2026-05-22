import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  SimpleFinClient
} from "./simplefin.js";
import { FinanceStore } from "./store.js";

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .optional();

export function registerTools(server: McpServer, client: SimpleFinClient, store: FinanceStore): void {
  server.registerTool(
    "connection_status",
    {
      title: "Connection Status",
      description: "Report whether the SimpleFIN access URL is configured. Does not expose the secret.",
      inputSchema: {}
    },
    async () => {
      const output = {
        simplefin_configured: client.isConfigured(),
        mode: "read-only",
        secret: client.isConfigured() ? "configured" : "missing",
        cache: store.getStatus()
      };

      return result(output);
    }
  );

  server.registerTool(
    "sync_simplefin",
    {
      title: "Sync SimpleFIN",
      description: "Fetch SimpleFIN data once and update the local SQLite cache. Use before analysis when fresh data matters.",
      inputSchema: {
        startDate: dateSchema,
        endDate: dateSchema,
        pending: z.boolean().optional()
      }
    },
    async ({ startDate, endDate, pending }) => {
      const payload = await client.fetchAccounts({ startDate, endDate, pending });
      return result(store.saveSimpleFinPayload(payload));
    }
  );

  server.registerTool(
    "list_accounts",
    {
      title: "List Accounts",
      description: "List SimpleFIN accounts with balances and institutions.",
      inputSchema: {
        includeTransactions: z.boolean().default(false)
      }
    },
    async ({ includeTransactions }) => {
      return result({ accounts: store.listAccounts(includeTransactions) });
    }
  );

  server.registerTool(
    "get_account",
    {
      title: "Get Account",
      description: "Fetch one account by SimpleFIN account id.",
      inputSchema: {
        accountId: z.string().min(1)
      }
    },
    async ({ accountId }) => {
      const account = store.getAccount(accountId);

      if (!account) {
        return errorResult(`No account found for id ${accountId}`);
      }

      return result({ account });
    }
  );

  server.registerTool(
    "get_transactions",
    {
      title: "Get Transactions",
      description: "Fetch transactions, optionally scoped by account and date range. Keep ranges at 90 days or less.",
      inputSchema: {
        accountId: z.string().min(1).optional(),
        startDate: dateSchema,
        endDate: dateSchema,
        pending: z.boolean().optional(),
        limit: z.number().int().min(1).max(1000).default(200)
      }
    },
    async ({ accountId, startDate, endDate, pending, limit }) => {
      const transactions = store.getTransactions({ accountId, startDate, endDate, pending, limit });
      return result({ transactions, count: transactions.length });
    }
  );

  server.registerTool(
    "search_transactions",
    {
      title: "Search Transactions",
      description: "Search transaction description, payee, memo, institution, and account name.",
      inputSchema: {
        query: z.string().min(1),
        accountId: z.string().min(1).optional(),
        startDate: dateSchema,
        endDate: dateSchema,
        limit: z.number().int().min(1).max(500).default(100)
      }
    },
    async ({ query, accountId, startDate, endDate, limit }) => {
      const transactions = store.searchTransactions({ query, accountId, startDate, endDate, limit });
      return result({ transactions, count: transactions.length });
    }
  );

  server.registerTool(
    "summarize_cashflow",
    {
      title: "Summarize Cashflow",
      description: "Summarize income, spending, and net cashflow over a date range.",
      inputSchema: {
        accountId: z.string().min(1).optional(),
        startDate: dateSchema,
        endDate: dateSchema
      }
    },
    async ({ accountId, startDate, endDate }) => {
      return result({
        ...store.summarizeCashflow({ accountId, startDate, endDate }),
        currency_note: "SimpleFIN reports currency per account; mixed-currency totals are not converted."
      });
    }
  );

  server.registerTool(
    "detect_subscriptions",
    {
      title: "Detect Subscriptions",
      description: "Find repeated outgoing merchants in the local cache as likely subscriptions or recurring bills.",
      inputSchema: {
        minOccurrences: z.number().int().min(2).max(24).default(2),
        limit: z.number().int().min(1).max(100).default(50)
      }
    },
    async ({ minOccurrences, limit }) => result(store.detectSubscriptions({ minOccurrences, limit }))
  );

  server.registerTool(
    "weekly_money_briefing",
    {
      title: "Weekly Money Briefing",
      description: "Summarize the last seven days from the local cache for agent-friendly review.",
      inputSchema: {
        endDate: dateSchema
      }
    },
    async ({ endDate }) => {
      const end = endDate ?? new Date().toISOString().slice(0, 10);
      const start = daysBefore(end, 6);
      const summary = store.summarizeCashflow({ startDate: start, endDate: end });
      const largeTransactions = store
        .getTransactions({ startDate: start, endDate: end, limit: 1000 })
        .filter((transaction) => Math.abs(transaction.amount) >= 100)
        .slice(0, 20);

      return result({
        period: { start_date: start, end_date: end },
        summary,
        likely_subscriptions: store.detectSubscriptions({ minOccurrences: 2, limit: 10 }),
        large_transactions: largeTransactions
      });
    }
  );
}

function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true
  };
}

function result(output: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
    structuredContent: output
  };
}

function daysBefore(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}
