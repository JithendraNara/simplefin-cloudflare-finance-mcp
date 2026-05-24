import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { requireAdmin } from "./auth.js";
import {
  generateBriefing,
  categorizeTransactions,
  explainUnusualTransactions,
  generateCorrectionRulesForCorrections,
  queryFinance,
  recategorizeLowConfidence
} from "./ai.js";
import { claimSetupToken } from "./simplefin.js";
import { daysBefore, today } from "./http.js";
import { FinanceRepository } from "./repository.js";
import { syncSimpleFin } from "./sync.js";
import type { Env, ToolAuth } from "./types.js";
import { indexTransactions, reindexTransaction, semanticSearch } from "./vectorize.js";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();

export function createFinanceMcpServer(env: Env, auth: ToolAuth): McpServer {
  const server = new McpServer({
    name: "simplefin-finance-mcp",
    version: "0.1.0"
  });
  const repo = new FinanceRepository(env);

  server.registerTool(
    "agent_guidance",
    {
      title: "Agent Guidance",
      description: "Return compact instructions for using this finance MCP safely and efficiently.",
      inputSchema: {}
    },
    async () => result(agentGuidance(auth))
  );

  server.registerTool(
    "auth_context",
    {
      title: "Auth Context",
      description: "Return the current caller's safe MCP auth mode and permission level.",
      inputSchema: {}
    },
    async () => result(authContext(auth))
  );

  server.registerTool(
    "connection_status",
    {
      title: "Connection Status",
      description: "Return auth-safe SimpleFIN finance cache and caller permission status.",
      inputSchema: {}
    },
    async () => result({
      ...await repo.status(),
      auth: authContext(auth)
    })
  );

  if (auth.isAdmin) {
    server.registerTool(
      "sync_simplefin",
      {
        title: "Sync SimpleFIN",
        description: "Admin-only. Sync SimpleFIN into D1 and refresh cached AI insights.",
        inputSchema: {
          startDate: dateSchema,
          endDate: dateSchema,
          days: z.number().int().min(1).max(90).optional(),
          pending: z.boolean().optional(),
          force: z.boolean().optional()
        }
      },
      async ({ startDate, endDate, days, pending, force }) => {
        requireAdmin(auth);
        return result(await syncSimpleFin(env, { startDate, endDate, days, pending, force, trigger: "manual" }));
      }
    );

    server.registerTool(
      "claim_setup_token",
      {
        title: "Claim Setup Token",
        description: "Admin-only. Claim a SimpleFIN setup token and return instructions for storing the Access URL as a Worker secret.",
        inputSchema: {
          setupToken: z.string().min(1)
        }
      },
      async ({ setupToken }) => {
        requireAdmin(auth);
        const accessUrl = await claimSetupToken(setupToken);
        return result({
          claimed: true,
          access_url_preview: redactAccessUrl(accessUrl),
          next_step: "Store the full Access URL with: npx wrangler secret put SIMPLEFIN_ACCESS_URL --config worker/wrangler.toml"
        });
      }
    );
  }

  server.registerTool(
    "worker_operational_status",
    {
      title: "Worker Operational Status",
      description: "Return sync, enrichment, index, and AI usage health for this finance MCP Worker.",
      inputSchema: {}
    },
    async () => result(await repo.operationalStatus())
  );

  server.registerTool(
    "list_accounts",
    {
      title: "List Accounts",
      description: "List cached SimpleFIN accounts from D1.",
      inputSchema: {}
    },
    async () => result(await repo.listAccounts())
  );

	  server.registerTool(
	    "finance_overview",
    {
      title: "Finance Overview",
      description: "Return a compact read-only financial overview for agents: balances, cashflow, categories, top merchants, fee signals, and data quality.",
      inputSchema: {
        days: z.number().int().min(1).max(90).default(30)
      }
    },
	    async ({ days }) => result(await repo.financeOverview({ days }))
	  );

	  server.registerTool(
	    "simplefin_data_coverage",
	    {
	      title: "SimpleFIN Data Coverage",
	      description: "Show per-account SimpleFIN cache coverage, transaction ranges, freshness, warnings, and backfill status.",
	      inputSchema: {
	        accountId: z.string().optional()
	      }
	    },
	    async ({ accountId }) => result(await repo.simpleFinDataCoverage(accountId))
	  );

	  server.registerTool(
	    "simplefin_account_gaps",
	    {
	      title: "SimpleFIN Account Gaps",
	      description: "List SimpleFIN account-level coverage gaps such as new account backfills, balance-only accounts, stale balances, errlist mappings, and transaction count drops.",
	      inputSchema: {
	        limit: z.number().int().min(1).max(100).default(50)
	      }
	    },
	    async ({ limit }) => result(await repo.simpleFinAccountGaps({ limit }))
	  );

	  server.registerTool(
	    "simplefin_raw_account",
	    {
	      title: "SimpleFIN Raw Account",
	      description: "Account-scoped raw SimpleFIN diagnostics. Requires accountId and caps transaction output to avoid whole-cache dumps.",
	      inputSchema: {
	        accountId: z.string().min(1),
	        includeRawJson: z.boolean().optional(),
	        includeTransactions: z.boolean().optional(),
	        limit: z.number().int().min(1).max(500).default(100)
	      }
	    },
	    async (args) => result(await repo.simpleFinRawAccount(args))
	  );

	  server.registerTool(
	    "simplefin_sync_history",
	    {
	      title: "SimpleFIN Sync History",
	      description: "Return recent global sync runs plus account-level SimpleFIN sync events.",
	      inputSchema: {
	        accountId: z.string().optional(),
	        limit: z.number().int().min(1).max(50).default(20)
	      }
	    },
	    async (args) => result(await repo.simpleFinSyncHistory(args))
	  );

	  server.registerTool(
	    "get_transactions",
    {
      title: "Get Transactions",
      description: "Read cached transactions from D1.",
      inputSchema: {
        accountId: z.string().optional(),
        startDate: dateSchema,
        endDate: dateSchema,
        pending: z.boolean().optional(),
        category: z.string().optional(),
        limit: z.number().int().min(1).max(1000).default(200)
      }
    },
    async (args) => {
      const transactions = await repo.getTransactions(args);
      return result({ transactions, count: transactions.length });
    }
  );

  server.registerTool(
    "search_transactions",
    {
      title: "Search Transactions",
      description: "Text search cached transactions.",
      inputSchema: {
        query: z.string().min(1),
        accountId: z.string().optional(),
        startDate: dateSchema,
        endDate: dateSchema,
        limit: z.number().int().min(1).max(500).default(100)
      }
    },
    async (args) => {
      const transactions = await repo.searchTransactions(args);
      return result({ transactions, count: transactions.length });
    }
  );

  server.registerTool(
    "semantic_transaction_search",
    {
      title: "Semantic Transaction Search",
      description: "Search transactions using Workers AI embeddings and Vectorize.",
      inputSchema: {
        query: z.string().min(1),
        accountId: z.string().optional(),
        startDate: dateSchema,
        endDate: dateSchema,
        limit: z.number().int().min(1).max(50).default(10)
      }
    },
    async (args) => result(await semanticSearch(env, repo, args))
  );

  server.registerTool(
    "summarize_cashflow",
    {
      title: "Summarize Cashflow",
      description: "Summarize deterministic cashflow totals from cached transactions.",
      inputSchema: {
        accountId: z.string().optional(),
        startDate: dateSchema,
        endDate: dateSchema
      }
    },
    async (args) => result(await repo.summarizeCashflow(args))
  );

  server.registerTool(
    "detect_subscriptions",
    {
      title: "Detect Subscriptions",
      description: "Find recurring outgoing merchants from cached transactions and AI merchant normalization.",
      inputSchema: {}
    },
    async () => result(await repo.detectSubscriptions())
  );

  server.registerTool(
    "detect_recurring_obligations",
    {
      title: "Detect Recurring Obligations",
      description: "Find recurring subscriptions plus recurring fees and other obligation-like spend such as BNPL or utilities.",
      inputSchema: {}
    },
    async () => result(await repo.detectRecurringObligations())
  );

  server.registerTool(
    "merchant_summary",
    {
      title: "Merchant Summary",
      description: "Summarize spending, trends, account distribution, categories, and outliers for one merchant.",
      inputSchema: {
        merchant: z.string().min(1),
        days: z.number().int().min(1).max(365).default(90)
      }
    },
    async ({ merchant, days }) => result(await repo.merchantSummary({ merchant, days }))
  );

  server.registerTool(
    "query_finance",
    {
      title: "Query Finance",
      description: "Answer a natural-language finance question from compact cached SimpleFIN summaries and narrow transaction matches using the configured reasoning provider.",
      inputSchema: {
        question: z.string().min(3).max(1000),
        days: z.number().int().min(1).max(90).default(30)
      }
    },
    async ({ question, days }) => result(await queryFinance(env, repo, { question, days }))
  );

  if (auth.isAdmin) {
    server.registerTool(
      "categorize_uncategorized_transactions",
      {
        title: "Categorize Uncategorized Transactions",
        description: "Admin-only. Use Workers AI to enrich uncategorized transactions.",
        inputSchema: {
          limit: z.number().int().min(1).max(100).default(20)
        }
      },
      async ({ limit }) => {
        requireAdmin(auth);
        return result(await categorizeTransactions(env, repo, limit));
      }
    );

    server.registerTool(
      "correct_transaction",
      {
        title: "Correct Transaction",
        description: "Admin-only. Correct a transaction category, merchant key, or subscription flag; logs the correction and refreshes its semantic index vector.",
        inputSchema: {
          transactionId: z.string().min(1),
          corrections: z.object({
            category: z.string().optional(),
            merchant_normalized: z.string().optional(),
            is_subscription_candidate: z.boolean().optional()
          }),
          note: z.string().optional()
        }
      },
      async ({ transactionId, corrections, note }) => {
        requireAdmin(auth);
        const corrected = await repo.correctTransaction({
          transactionId,
          corrections,
          note,
          correctedBy: auth.login ?? auth.authType ?? "admin"
        });
        const correctionRules = await generateCorrectionRulesForCorrections(
          env,
          repo,
          Array.isArray(corrected.corrections) ? corrected.corrections as Array<Record<string, unknown>> : []
        );
        const indexing = await reindexTransaction(env, repo, transactionId);
        return result({ ...corrected, correction_rules: correctionRules, indexing });
      }
    );

    server.registerTool(
      "recategorize_low_confidence",
      {
        title: "Recategorize Low Confidence",
        description: "Admin-only. Review low-confidence Workers AI categorization rows with the configured AI Gateway fallback route; applying changes requires ENABLE_GATEWAY_CATEGORIZER_FALLBACK=true.",
        inputSchema: {
          limit: z.number().int().min(1).max(50).default(20),
          apply: z.boolean().default(false),
          threshold: z.number().min(0).max(1).default(0.75)
        }
      },
      async ({ limit, apply, threshold }) => {
        requireAdmin(auth);
        const review = await recategorizeLowConfidence(env, repo, { limit, apply, threshold });
        const appliedIds = Array.isArray(review.applied_transaction_ids)
          ? review.applied_transaction_ids.filter((id): id is string => typeof id === "string")
          : [];
        const indexing = [];
        for (const transactionId of appliedIds) {
          indexing.push(await reindexTransaction(env, repo, transactionId));
        }
        return result({ ...review, indexing });
      }
    );

    server.registerTool(
      "undo_correction",
      {
        title: "Undo Correction",
        description: "Admin-only. Undo one prior correction and log the undo as a new correction event.",
        inputSchema: {
          correctionId: z.string().min(1)
        }
      },
      async ({ correctionId }) => {
        requireAdmin(auth);
        const undone = await repo.undoCorrection(correctionId, auth.login ?? auth.authType ?? "admin");
        const transaction = undone.updated_transaction as Record<string, unknown> | undefined;
        const indexing = typeof transaction?.id === "string"
          ? await reindexTransaction(env, repo, transaction.id)
          : null;
        return result({ ...undone, indexing });
      }
    );

    server.registerTool(
      "label_eval_transaction",
      {
        title: "Label Eval Transaction",
        description: "Admin-only. Add or update a hand-labeled eval row for calibration.",
        inputSchema: {
          transactionId: z.string().min(1),
          correctCategory: z.string().min(1),
          correctMerchantNormalized: z.string().min(1),
          correctIsSubscription: z.boolean(),
          split: z.enum(["train", "holdout", "rolling_holdout"]).default("train"),
          notes: z.string().optional()
        }
      },
      async (args) => {
        requireAdmin(auth);
        return result(await repo.labelEvalTransaction({ ...args, labeledBy: auth.login ?? auth.authType ?? "admin" }));
      }
    );

    server.registerTool(
      "run_eval",
      {
        title: "Run Eval",
        description: "Admin-only. Run split-aware calibration metrics against hand-labeled eval rows.",
        inputSchema: {
          modelVersion: z.string().optional(),
          split: z.enum(["train", "holdout", "rolling_holdout"]).optional()
        }
      },
      async ({ modelVersion, split }) => {
        requireAdmin(auth);
        return result(await repo.runEval({ modelVersion, split }));
      }
    );
  }

  server.registerTool(
    "list_corrections",
    {
      title: "List Corrections",
      description: "List recent user corrections that teach the categorizer.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(50),
        since: dateSchema
      }
    },
    async (args) => result(await repo.listCorrections(args))
  );

  server.registerTool(
    "get_eval_history",
    {
      title: "Get Eval History",
      description: "Return recent categorization calibration eval runs.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(10)
      }
    },
    async (args) => result(await repo.getEvalHistory(args))
  );

  server.registerTool(
    "find_unusual_transactions",
    {
      title: "Find Unusual Transactions",
      description: "Find and explain unusual transactions using deterministic baselines plus the configured AI reasoning provider.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(10)
      }
    },
    async ({ limit }) => result(await explainUnusualTransactions(env, repo, limit))
  );

  server.registerTool(
    "generate_weekly_money_briefing",
    {
      title: "Generate Weekly Money Briefing",
      description: "Generate or return a cached weekly finance briefing using the configured AI reasoning provider.",
      inputSchema: {
        endDate: dateSchema,
        force: z.boolean().optional()
      }
    },
    async ({ endDate, force }) => {
      const end = endDate ?? today();
      return result(await generateBriefing(env, repo, daysBefore(end, 6), end, Boolean(force)));
    }
  );

  if (auth.isAdmin) {
    server.registerTool(
      "worker_audit_events",
      {
        title: "Worker Audit Events",
        description: "Admin-only. Read sanitized Worker route and MCP tool audit events retained in D1.",
        inputSchema: {
          limit: z.number().int().min(1).max(200).default(50)
        }
      },
      async ({ limit }) => {
        requireAdmin(auth);
        return result(await repo.operationalEvents({ limit }));
      }
    );

    server.registerTool(
      "refresh_insights",
      {
        title: "Refresh Insights",
        description: "Admin-only. Refresh AI categorization, semantic index, and current weekly briefing.",
        inputSchema: {}
      },
      async () => {
        requireAdmin(auth);
        const end = today();
        const categorization = await categorizeTransactions(env, repo, 20);
        const indexing = await indexTransactions(env, repo, 100);
        const briefing = await generateBriefing(env, repo, daysBefore(end, 6), end, true);
        return result({ categorization, indexing, briefing });
      }
    );
  }

  return server;
}

function authContext(auth: ToolAuth): Record<string, unknown> {
  return {
    authenticated: true,
    auth_type: auth.authType ?? "unknown",
    login: auth.login ?? null,
    is_admin: auth.isAdmin,
    permissions: {
      read_finance: true,
      sync_finance: auth.isAdmin,
      manage_simplefin: auth.isAdmin,
      refresh_ai_insights: auth.isAdmin
    },
    tool_visibility: auth.isAdmin ? "admin_and_read_tools" : "read_only_tools"
  };
}

function agentGuidance(auth: ToolAuth): Record<string, unknown> {
  return {
    purpose: "Private finance MCP for cached SimpleFIN data. Use compact overview tools before raw transaction tools.",
	    recommended_first_calls: [
	      "auth_context",
	      "worker_operational_status",
	      "connection_status",
	      "simplefin_data_coverage",
	      "finance_overview"
	    ],
    context_budgeting: {
	      default_tool: "finance_overview",
	      coverage_rule: "Call simplefin_data_coverage before trusting per-account conclusions; call simplefin_account_gaps if coverage is not healthy.",
	      raw_account_rule: "Use simplefin_raw_account only for one accountId at a time; keep transaction limits narrow.",
	      raw_transaction_rule: "Call get_transactions only for a narrow account/date/category question; prefer limit <= 100.",
	      search_rule: "Use search_transactions or semantic_transaction_search for merchant/topic followups instead of loading all transactions.",
	      natural_language_rule: "Use query_finance for multi-step natural-language questions that need synthesis across compact summaries and narrow transaction matches.",
	      merchant_rule: "Use merchant_summary for merchant-specific questions instead of manually aggregating search results.",
	      recurring_rule: "Use detect_recurring_obligations when the user asks about recurring monthly commitments beyond subscriptions.",
	      learning_rule: "Use list_corrections and get_eval_history when judging categorization quality; admins can call correct_transaction, recategorize_low_confidence, and run_eval to improve and measure the system.",
	      sync_rule: "Do not sync before every question. The Worker syncs daily with a 3-day overlap; new/problem accounts get account-specific 90-day backfill."
	    },
    permissions: authContext(auth),
    admin_only_tools_visible: auth.isAdmin,
    safety_notes: [
      "Never expose SimpleFIN access URLs or bearer tokens.",
      "Treat transfers as debt movement unless transaction details prove new spending.",
      "Finance data can be sensitive; summarize before quoting transaction rows."
    ]
  };
}

function result(output: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
    structuredContent: output
  };
}

function redactAccessUrl(accessUrl: string): string {
  const url = new URL(accessUrl);
  if (url.username) url.username = "redacted";
  if (url.password) url.password = "redacted";
  return url.toString();
}
