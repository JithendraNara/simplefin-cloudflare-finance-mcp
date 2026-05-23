import type { Enrichment, Env, TransactionRow } from "./types.js";
import { FinanceRepository, transactionText } from "./repository.js";

const DAILY_AI_ITEM_LIMIT = 500;
const MAX_BRIEFING_ATTEMPTS = 2;

export async function categorizeTransactions(env: Env, repo: FinanceRepository, limit = 20): Promise<Record<string, unknown>> {
  const model = env.AI_MODEL ?? "@cf/meta/llama-3.1-8b-instruct";
  const usedToday = await repo.dailyAiUsageCount();
  if (usedToday >= DAILY_AI_ITEM_LIMIT) {
    const transactions = await repo.unenrichedTransactions(limit);
    const enrichments = transactions.map((transaction) =>
      deterministicEnrichment(transaction, model, "daily_ai_item_limit_reached")
    );
    await repo.saveEnrichments(enrichments);
    return {
      enriched: enrichments.length,
      fallback: "deterministic",
      reason: "daily_ai_item_limit_reached",
      used_today: usedToday
    };
  }

  const transactions = await repo.unenrichedTransactions(Math.min(limit, DAILY_AI_ITEM_LIMIT - usedToday));
  if (transactions.length === 0) {
    return { enriched: 0 };
  }

  try {
    const prompt = buildCategorizationPrompt(transactions);
    const output = await env.AI.run(model, {
      messages: [
        {
          role: "system",
          content: "You categorize bank transactions. Return strict JSON only. Do not use markdown."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      response_format: {
        type: "json_schema",
        json_schema: categorizationSchema
      }
    } as AiTextGenerationInput);
    const text = extractText(output);
    const parsed = parseJsonObject(text);
    const enrichments = normalizeEnrichments(parsed, transactions, model);
    await repo.saveEnrichments(enrichments);
    await repo.saveAiUsage("categorize_transactions", model, transactions.length, "ok");
    return { enriched: enrichments.length, model };
  } catch (error) {
    const enrichments = transactions.map((transaction) => deterministicEnrichment(transaction, model, error));
    await repo.saveEnrichments(enrichments);
    await repo.saveAiUsage("categorize_transactions", model, transactions.length, "error", error);
    return {
      enriched: enrichments.length,
      fallback: "deterministic",
      model,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function generateBriefing(
  env: Env,
  repo: FinanceRepository,
  periodStart: string,
  periodEnd: string,
  force = false
): Promise<Record<string, unknown>> {
  const cached = force ? null : await repo.latestBriefing(periodStart, periodEnd, "weekly");
  if (cached) return { cached: true, briefing: cached };

  const model = env.AI_MODEL ?? "@cf/meta/llama-3.1-8b-instruct";
  const summary = await repo.summarizeCashflow({ startDate: periodStart, endDate: periodEnd });
  const subscriptions = await repo.detectSubscriptions();
  const compactSubscriptions = {
    subscriptions: Array.isArray(subscriptions.subscriptions) ? subscriptions.subscriptions.slice(0, 10) : []
  };
  const largeTransactions = (await repo.getTransactions({ startDate: periodStart, endDate: periodEnd, limit: 1000 }))
    .filter((transaction) => Math.abs(transaction.amount) >= 100)
    .slice(0, 10)
    .map((transaction) => ({
      amount: transaction.amount,
      description: transaction.description,
      payee: transaction.payee,
      posted_at: transaction.posted_at,
      category: transaction.category
    }));

  const briefingData = { summary, subscriptions: compactSubscriptions, largeTransactions };
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_BRIEFING_ATTEMPTS; attempt += 1) {
    try {
      const output = await env.AI.run(model, {
        messages: [
          {
            role: "system",
            content: "You write concise personal finance briefings from structured data. Return one valid JSON object only. Do not invent facts."
          },
          {
            role: "user",
            content: buildBriefingPrompt(periodStart, periodEnd, briefingData, attempt)
          }
        ],
        response_format: {
          type: "json_schema",
          json_schema: briefingSchema
        }
      } as AiTextGenerationInput);
      const parsed = validateBriefing(parseJsonObject(extractText(output)));
      const briefing = await repo.saveBriefing({
        periodStart,
        periodEnd,
        kind: "weekly",
        summaryJson: parsed,
        summaryText: parsed.summary_text as string,
        model
      });
      await repo.saveAiUsage("generate_weekly_money_briefing", model, 1, "ok");
      return { cached: false, attempts: attempt, briefing };
    } catch (error) {
      lastError = error;
      await repo.saveAiUsage("generate_weekly_money_briefing", model, 1, "error", error);
    }
  }

  return {
    cached: false,
    attempts: MAX_BRIEFING_ATTEMPTS,
    fallback: "deterministic",
    briefing: await repo.saveBriefing({
      periodStart,
      periodEnd,
      kind: "weekly",
      summaryJson: { summary, subscriptions, largeTransactions },
      summaryText: "Workers AI briefing generation failed; deterministic finance summary is available in summary_json.",
      model
    }),
    error: lastError instanceof Error ? lastError.message : String(lastError)
  };
}

export async function explainUnusualTransactions(env: Env, repo: FinanceRepository, limit = 10): Promise<Record<string, unknown>> {
  const model = env.AI_MODEL ?? "@cf/meta/llama-3.1-8b-instruct";
  const transactions = await repo.getTransactions({ limit: 500 });
  const amounts = transactions.filter((transaction) => transaction.amount < 0).map((transaction) => Math.abs(transaction.amount));
  const average = amounts.length ? amounts.reduce((sum, amount) => sum + amount, 0) / amounts.length : 0;
  const unusual = transactions
    .filter((transaction) => transaction.amount < 0 && Math.abs(transaction.amount) >= Math.max(100, average * 2))
    .slice(0, limit);

  if (unusual.length === 0) return { unusual_transactions: [] };

  try {
    const output = await env.AI.run(model, {
      messages: [
        { role: "system", content: "Explain why transactions may be unusual using only the supplied data. Return strict JSON only." },
        { role: "user", content: JSON.stringify({ average_spend: average, transactions: unusual }) }
      ],
      response_format: {
        type: "json_schema",
        json_schema: unusualTransactionsSchema
      }
    } as AiTextGenerationInput);
    await repo.saveAiUsage("find_unusual_transactions", model, unusual.length, "ok");
    return { unusual_transactions: unusual, explanation: parseJsonObject(extractText(output)) };
  } catch (error) {
    await repo.saveAiUsage("find_unusual_transactions", model, unusual.length, "error", error);
    return { unusual_transactions: unusual, error: error instanceof Error ? error.message : String(error) };
  }
}

export function extractText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const record = output as Record<string, unknown>;
    if (typeof record.response === "string") return record.response;
    if (record.response && typeof record.response === "object") return JSON.stringify(record.response);
    if (typeof record.result === "string") return record.result;
    if (record.result && typeof record.result === "object") return JSON.stringify(record.result);
    if (typeof record.text === "string") return record.text;
  }
  return JSON.stringify(output);
}

const categorizationSchema = {
  type: "object",
  properties: {
    transactions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          transaction_id: { type: "string" },
          category: { type: "string" },
          merchant_normalized: { type: "string" },
          is_subscription_candidate: { type: "boolean" },
          confidence: { type: "number" },
          ai_reason: { type: "string" }
        },
        required: ["transaction_id", "category", "merchant_normalized", "is_subscription_candidate", "confidence", "ai_reason"]
      }
    }
  },
  required: ["transactions"]
};

const briefingSchema = {
  type: "object",
  properties: {
    summary_text: { type: "string" },
    highlights: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    next_actions: { type: "array", items: { type: "string" } }
  },
  required: ["summary_text", "highlights", "risks", "next_actions"]
};

function buildBriefingPrompt(
  periodStart: string,
  periodEnd: string,
  data: Record<string, unknown>,
  attempt: number
): string {
  const instruction = attempt === 1
    ? "Write a weekly money briefing"
    : "The prior response failed JSON validation. Retry and return exactly one JSON object with string summary_text and string arrays highlights, risks, and next_actions";
  return `${instruction} for ${periodStart} through ${periodEnd}.\n\nData:\n${JSON.stringify(data)}`;
}

function validateBriefing(value: Record<string, unknown>): Record<string, unknown> {
  const arrayFields = ["highlights", "risks", "next_actions"] as const;
  if (typeof value.summary_text !== "string") {
    throw new Error("Workers AI briefing response missing summary_text");
  }
  for (const field of arrayFields) {
    if (!Array.isArray(value[field]) || value[field].some((item) => typeof item !== "string")) {
      throw new Error(`Workers AI briefing response missing ${field}`);
    }
  }
  return value;
}

const unusualTransactionsSchema = {
  type: "object",
  properties: {
    explanation: { type: "string" },
    transactions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          transaction_id: { type: "string" },
          reason: { type: "string" }
        },
        required: ["transaction_id", "reason"]
      }
    }
  },
  required: ["explanation", "transactions"]
};

function buildCategorizationPrompt(transactions: TransactionRow[]): string {
  return `Categorize these transactions into one of: income, housing, groceries, dining, transport, subscriptions, health, utilities, transfers, shopping, taxes, fees, entertainment, uncategorized.

Return this exact JSON shape:
{"transactions":[{"transaction_id":"...","category":"...","merchant_normalized":"...","is_subscription_candidate":false,"confidence":0.0,"ai_reason":"..."}]}

Transactions:
${JSON.stringify(transactions.map((transaction) => ({
    transaction_id: transaction.id,
    amount: transaction.amount,
    text: transactionText(transaction),
    posted_at: transaction.posted_at
  })), null, 2)}`;
}

function normalizeEnrichments(parsed: Record<string, unknown>, transactions: TransactionRow[], model: string): Enrichment[] {
  const validIds = new Set(transactions.map((transaction) => transaction.id));
  const rows = Array.isArray(parsed.transactions) ? parsed.transactions : [];
  const byId = new Map<string, Enrichment>();

  for (const enrichment of rows
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    .filter((row) => typeof row.transaction_id === "string" && validIds.has(row.transaction_id))
    .map((row) => ({
      transaction_id: String(row.transaction_id),
      category: typeof row.category === "string" ? row.category : "uncategorized",
      merchant_normalized: typeof row.merchant_normalized === "string" ? row.merchant_normalized : "unknown",
      is_subscription_candidate: Boolean(row.is_subscription_candidate),
      confidence: clamp(Number(row.confidence), 0, 1),
      ai_reason: typeof row.ai_reason === "string" ? row.ai_reason.slice(0, 500) : "",
      model
    }))) {
    byId.set(enrichment.transaction_id, enrichment);
  }

  for (const transaction of transactions) {
    if (!byId.has(transaction.id)) {
      byId.set(transaction.id, deterministicEnrichment(transaction, model));
    }
  }

  return Array.from(byId.values());
}

function deterministicEnrichment(transaction: TransactionRow, model: string, error?: unknown): Enrichment {
  const text = transactionText(transaction);
  const lower = text.toLowerCase();
  const merchant = normalizeMerchant(text);
  const category =
    transaction.amount > 0 ? "income" :
    /\b(rent|mortgage|apartment|lease)\b/.test(lower) ? "housing" :
    /\b(costco|walmart|target|kroger|whole foods|aldi|trader joe|grocery)\b/.test(lower) ? "groceries" :
    /\b(doordash|restaurant|cafe|coffee|starbucks|chipotle|mcdonald|taco|pizza)\b/.test(lower) ? "dining" :
    /\b(uber|lyft|gas|shell|bp|exxon|parking|transit)\b/.test(lower) ? "transport" :
    /\b(netflix|spotify|google fi|apple\.com\/bill|subscription|monthly)\b/.test(lower) ? "subscriptions" :
    /\b(pharmacy|doctor|health|medical|dental)\b/.test(lower) ? "health" :
    /\b(electric|water|utility|internet|phone|wireless)\b/.test(lower) ? "utilities" :
    /\b(payment|transfer|credit card|autopay|zelle|venmo|cash app)\b/.test(lower) ? "transfers" :
    /\b(fee|interest charge|late fee)\b/.test(lower) ? "fees" :
    /\b(cinema|movie|game|steam|hulu|disney)\b/.test(lower) ? "entertainment" :
    "shopping";

  return {
    transaction_id: transaction.id,
    category,
    merchant_normalized: merchant,
    is_subscription_candidate: /\b(subscription|monthly|google fi|netflix|spotify|hulu|disney)\b/.test(lower),
    confidence: error ? 0.35 : 0.55,
    ai_reason: error ? `Deterministic fallback after AI error: ${String(error).slice(0, 180)}` : "Deterministic fallback category.",
    model
  };
}

function normalizeMerchant(text: string): string {
  return text
    .replace(/[^a-zA-Z0-9\s.'&/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "unknown";
}

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
    }
    throw new Error("Workers AI did not return parseable JSON");
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
