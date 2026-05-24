import type { Enrichment, Env, TransactionRow } from "./types.js";
import { FinanceRepository, transactionText } from "./repository.js";

const DAILY_AI_ITEM_LIMIT = 500;
const MAX_BRIEFING_ATTEMPTS = 2;
const CATEGORIZATION_BATCH_SIZE = 1;

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

  let aiEnriched = 0;
  let fallbackEnriched = 0;
  const failures: string[] = [];

  for (let index = 0; index < transactions.length; index += CATEGORIZATION_BATCH_SIZE) {
    const batch = transactions.slice(index, index + CATEGORIZATION_BATCH_SIZE);
    try {
      const prompt = buildCategorizationPrompt(batch);
      const output = await env.AI.run(model, {
        messages: [
          {
            role: "system",
            content: "You categorize bank transactions. Return only the JSON object requested by the schema. No markdown, no comments, no extra text."
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
      const parsed = parseJsonObject(extractText(output));
      const enrichments = normalizeEnrichments(parsed, batch, model);
      await repo.saveEnrichments(enrichments);
      await repo.saveAiUsage("categorize_transactions", model, batch.length, "ok");
      aiEnriched += enrichments.filter((enrichment) => !enrichment.ai_reason.startsWith("Deterministic fallback")).length;
      fallbackEnriched += enrichments.filter((enrichment) => enrichment.ai_reason.startsWith("Deterministic fallback")).length;
    } catch (error) {
      const enrichments = batch.map((transaction) => deterministicEnrichment(transaction, model, error));
      await repo.saveEnrichments(enrichments);
      await repo.saveAiUsage("categorize_transactions", model, batch.length, "error", error);
      fallbackEnriched += enrichments.length;
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    enriched: aiEnriched + fallbackEnriched,
    ai_enriched: aiEnriched,
    fallback_enriched: fallbackEnriched,
    model,
    failures: failures.slice(0, 5)
  };
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
  const periodDays = inclusiveDaySpan(periodStart, periodEnd);
  const priorEnd = daysBefore(periodStart, 1);
  const priorStart = daysBefore(priorEnd, periodDays - 1);
  const trailing30Start = daysBefore(periodEnd, 29);
  const priorSummary = await repo.summarizeCashflow({ startDate: priorStart, endDate: priorEnd });
  const trailing30Summary = await repo.summarizeCashflow({ startDate: trailing30Start, endDate: periodEnd });
  const subscriptions = await repo.detectSubscriptions();
  const healthIssues = briefingHealthIssues(await repo.healthIssues());
  const compactSubscriptions = {
    subscriptions: Array.isArray(subscriptions.subscriptions) ? subscriptions.subscriptions.slice(0, 5) : []
  };
  const trailing30Transactions = await repo.getTransactions({ startDate: trailing30Start, endDate: periodEnd, limit: 1000 });
  const currentWeekTransactions = trailing30Transactions.filter((transaction) => {
    const epoch = transaction.posted_at ?? transaction.transacted_at ?? 0;
    return epoch >= dateToEpoch(periodStart);
  });
  const largeTransactions = currentWeekTransactions
    .filter((transaction) => Math.abs(transaction.amount) >= 100)
    .slice(0, 10)
    .map((transaction) => ({
      amount: transaction.amount,
      description: transaction.description,
      payee: transaction.payee,
      posted_at: transaction.posted_at,
      category: transaction.category
    }));

  const feeTransactions = currentWeekTransactions
    .filter((transaction) => transaction.amount < 0 && isFeeLike(transaction))
    .sort((left, right) => Math.abs(right.amount) - Math.abs(left.amount))
    .slice(0, 5)
    .map((transaction) => ({
      merchant: displayMerchant(transaction),
      amount: Math.abs(transaction.amount),
      category: transaction.category,
      posted_at: transaction.posted_at,
      description: transaction.description
    }));
  const trailing30Fees = summarizeFeeTransactions(trailing30Transactions)
    .slice(0, 8);

  const briefingData = {
    summary,
    trailing_30_days: {
      start_date: trailing30Start,
      end_date: periodEnd,
      summary: trailing30Summary,
      top_fees: trailing30Fees
    },
    prior_period: { start_date: priorStart, end_date: priorEnd, summary: priorSummary },
    subscriptions: compactSubscriptions,
    health_issues: healthIssues,
    fees: feeTransactions,
    largeTransactions
  };
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
      summaryJson: {
        summary,
        trailing_30_days: { start_date: trailing30Start, end_date: periodEnd, summary: trailing30Summary, top_fees: trailing30Fees },
        prior_period: { start_date: priorStart, end_date: priorEnd, summary: priorSummary },
        subscriptions,
        health_issues: healthIssues,
        fees: feeTransactions,
        largeTransactions
      },
      summaryText: "Workers AI briefing generation failed; deterministic finance summary is available in summary_json.",
      model
    }),
    error: lastError instanceof Error ? lastError.message : String(lastError)
  };
}

export async function explainUnusualTransactions(env: Env, repo: FinanceRepository, limit = 10): Promise<Record<string, unknown>> {
  const model = env.AI_MODEL ?? "@cf/meta/llama-3.1-8b-instruct";
  const transactions = await repo.getTransactions({ limit: 1000 });
  const subscriptions = await repo.detectSubscriptions();
  const subscriptionKeys = new Set(
    (Array.isArray(subscriptions.subscriptions) ? subscriptions.subscriptions : [])
      .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
      .map((row) => normalizeKey(String(row.merchant ?? "")))
  );
  const unusual = unusualCandidates(transactions, subscriptionKeys).slice(0, limit);

  if (unusual.length === 0) return { unusual_transactions: [] };

  try {
    const output = await env.AI.run(model, {
      messages: [
        { role: "system", content: "Explain why transactions may be unusual using only the supplied data. Return strict JSON only." },
        { role: "user", content: JSON.stringify({ transactions: unusual }) }
      ],
      response_format: {
        type: "json_schema",
        json_schema: unusualTransactionsSchema
      }
    } as AiTextGenerationInput);
    await repo.saveAiUsage("find_unusual_transactions", model, unusual.length, "ok");
    return { unusual_transactions: unusual, explanation: parseJsonObject(extractText(output)), explanation_status: "ai" };
  } catch (error) {
    await repo.saveAiUsage("find_unusual_transactions", model, unusual.length, "error", error);
    return {
      unusual_transactions: unusual,
      explanation_status: "deterministic",
      explanation_note: "Workers AI explanation failed; unusual transactions were selected by deterministic baseline."
    };
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
    insights: {
      type: "array",
      items: {
        type: "object",
        properties: {
          merchant: { type: "string" },
          amount: { type: "number" },
          insight: { type: "string" },
          action: { type: "string" }
        },
        required: ["merchant", "amount", "insight", "action"]
      }
    }
  },
  required: ["summary_text", "insights"]
};

function buildBriefingPrompt(
  periodStart: string,
  periodEnd: string,
  data: Record<string, unknown>,
  attempt: number
): string {
  const instruction = attempt === 1
    ? "Write a weekly money briefing"
    : "The prior response failed JSON validation. Retry and return exactly one JSON object with string summary_text and an insights array";
  return `${instruction} for ${periodStart} through ${periodEnd}.

Return this exact shape:
{"summary_text":"one concise paragraph","insights":[{"merchant":"specific merchant or account","amount":0,"insight":"specific observation with amount","action":"specific next action"}]}

Rules:
- Return exactly 3 insights.
- Every insight must name a specific merchant/account and amount from the data.
- Prefer trailing_30_days.top_fees, health_issues, unusual one-off purchases, and subscription changes over generic category summaries.
- Do not choose tiny interest/fee items when a larger avoidable fee or interest item is present in trailing_30_days.top_fees.
- Mention active data coverage issues, such as Apple Card or SimpleFIN errlist warnings, when health_issues includes them.
- Do not mention internal tool names or agent instructions in human prose.
- Describe subscription insights by dollar impact and concrete action, not by active duration.
- Compare to the prior period when useful.
- Do not say "review spending" unless the action names a concrete merchant/account behavior.

Data:
${JSON.stringify(data)}`;
}

function validateBriefing(value: Record<string, unknown>): Record<string, unknown> {
  if (typeof value.summary_text !== "string") {
    throw new Error("Workers AI briefing response missing summary_text");
  }
  if (!Array.isArray(value.insights) || value.insights.some((item) => !isInsight(item))) {
    throw new Error("Workers AI briefing response missing insights");
  }
  value.insights = value.insights.slice(0, 3);
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
  return `Categorize these transactions into one of: income, housing, groceries, dining, dining_offset, transport, subscriptions, health, utilities, transfers, shopping, taxes, fees, entertainment, uncategorized.

Return this exact JSON shape:
{"transactions":[{"transaction_id":"...","category":"...","merchant_normalized":"...","is_subscription_candidate":false,"confidence":0.0,"ai_reason":"..."}]}

Transactions:
${JSON.stringify(transactions.map((transaction) => ({
    transaction_id: transaction.id,
    amount: transaction.amount,
    payee: transaction.payee,
    description: transaction.description,
    memo: transaction.memo,
    account: transaction.account_name,
    institution: transaction.org_name,
    posted_at: transaction.posted_at
  })), null, 2)}`;
}

function normalizeEnrichments(parsed: Record<string, unknown>, transactions: TransactionRow[], model: string): Enrichment[] {
  const validIds = new Set(transactions.map((transaction) => transaction.id));
  const transactionById = new Map(transactions.map((transaction) => [transaction.id, transaction]));
  const rows = Array.isArray(parsed.transactions) ? parsed.transactions : [];
  const byId = new Map<string, Enrichment>();

  for (const enrichment of rows
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    .filter((row) => typeof row.transaction_id === "string" && validIds.has(row.transaction_id))
    .map((row) => {
      const transactionId = String(row.transaction_id);
      const base = {
        transaction_id: transactionId,
        category: typeof row.category === "string" ? row.category : "uncategorized",
        merchant_normalized: normalizeMerchant(typeof row.merchant_normalized === "string" ? row.merchant_normalized : "unknown"),
        is_subscription_candidate: Boolean(row.is_subscription_candidate),
        confidence: clamp(Number(row.confidence), 0, 1),
        ai_reason: typeof row.ai_reason === "string" ? row.ai_reason.slice(0, 500) : "",
        model
      };
      const transaction = transactionById.get(transactionId);
      return transaction ? applyCategoryGuards(transaction, base) : base;
    })) {
    byId.set(enrichment.transaction_id, enrichment);
  }

  for (const transaction of transactions) {
    if (!byId.has(transaction.id)) {
      byId.set(transaction.id, deterministicEnrichment(transaction, model));
    }
  }

  return Array.from(byId.values());
}

function applyCategoryGuards(transaction: TransactionRow, enrichment: Enrichment): Enrichment {
  const text = transactionText(transaction).toLowerCase();
  const payee = String(transaction.payee ?? "").toLowerCase();
  const category = guardedCategory(text, payee, transaction.amount);
  const merchant = normalizeTransactionMerchant(transaction, enrichment.merchant_normalized);
  if (!category || category === enrichment.category) {
    const confidence = enrichment.confidence <= 0 ? 0.7 : enrichment.confidence;
    return {
      ...enrichment,
      merchant_normalized: merchant,
      confidence,
      ai_reason: normalizeAiReason(enrichment.ai_reason, enrichment.category, confidence)
    };
  }
  return {
    ...enrichment,
    category,
    merchant_normalized: merchant,
    is_subscription_candidate: category === "subscriptions" ? enrichment.is_subscription_candidate : false,
    confidence: Math.max(enrichment.confidence, 0.8),
    ai_reason: guardrailReason(enrichment.category, category, guardrailReasonFor(text, category))
  };
}

function briefingHealthIssues(issues: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return issues.map((issue) => {
    const { actionable_hint: _agentOnlyHint, ...humanSafeIssue } = issue;
    return humanSafeIssue;
  });
}

function normalizeAiReason(reason: string, category: string, confidence: number): string {
  const trimmed = reason.trim();
  if (!trimmed || trimmed.length < 12 || /^[a-z_ -]+$/i.test(trimmed)) {
    return `AI categorized transaction as '${category}' with confidence ${Math.round(confidence * 100)}%.`;
  }
  return trimmed.slice(0, 500);
}

function guardedCategory(text: string, payee: string, amount: number): string | null {
  if (amount > 0 && /\b(dining credit|restaurant credit|uber cash)\b/.test(text)) return "dining_offset";
  if (amount > 0) return null;
  if (/\b(apple online store|apple store)\b/.test(text)) return "shopping";
  if (/\b(uber eats|doordash|grubhub|restaurant|cafe|coffee|starbucks|chipotle|mcdonald|dunkin|taco|pizza)\b/.test(text)) return "dining";
  if (/\b(cbankus\.com|continental bank zolve)\b/.test(text)) return "uncategorized";
  if (/\b(fee|interest charge|purchase interest|late fee|returned payment|return payment|annual fee|credit protect)\b/.test(text)) return "fees";
  if (/\b(uber one|netflix|spotify|google fi|claude\.ai subscription|openai|subscription|monthly|membership)\b/.test(text)) return "subscriptions";
  if (/\b(payment|credit card|autopay|ach pmt|e-payment|epayment|applecard gsbank|american express ach|discover e-payment|zolve pmt|adjustment-payments|adjustment payments)\b/.test(text)) return "transfers";
  if (/\b(geico|gas|shell|bp|exxon|parking|transit|uber|lyft)\b/.test(text) && !/\beats\b/.test(payee)) return "transport";
  return null;
}

function guardrailReason(modelCategory: string, finalCategory: string, repairReason: string): string {
  return `Guardrail repaired category from '${modelCategory || "unknown"}' to '${finalCategory}': ${repairReason}.`;
}

function guardrailReasonFor(text: string, finalCategory: string): string {
  if (finalCategory === "shopping" && /\b(apple online store|apple store)\b/.test(text)) return "Apple Store purchase";
  if (finalCategory === "dining") return "restaurant or delivery merchant";
  if (finalCategory === "fees") return "fee or interest wording";
  if (finalCategory === "subscriptions") return "known recurring subscription merchant";
  if (finalCategory === "transfers") return "card payment or transfer wording";
  if (finalCategory === "transport") return "transport, gas, insurance, or rideshare wording";
  if (finalCategory === "uncategorized") return "irregular merchant requiring review";
  return "high-confidence deterministic rule";
}

function deterministicEnrichment(transaction: TransactionRow, model: string, error?: unknown): Enrichment {
  const text = transactionText(transaction);
  const preferredMerchant = displayMerchant(transaction);
  const lower = text.toLowerCase();
  const payeeLower = String(transaction.payee ?? "").toLowerCase();
  const merchant = normalizeMerchant(preferredMerchant);
  const category =
    transaction.amount > 0 && /\b(dining credit|restaurant credit|uber cash|credit)\b/.test(lower) ? "dining_offset" :
    transaction.amount > 0 ? "income" :
    /\b(payment|transfer|credit card|autopay|zelle|venmo|cash app|ach pmt|e-payment|epayment)\b/.test(lower) ? "transfers" :
    /\b(fee|interest charge|purchase interest|late fee|returned payment|return payment)\b/.test(lower) ? "fees" :
    /\b(rent|mortgage|apartment|lease)\b/.test(lower) ? "housing" :
    /\b(costco|walmart|target|kroger|whole foods|aldi|trader joe|grocery)\b/.test(lower) ? "groceries" :
    /\b(uber eats|doordash|grubhub|restaurant|cafe|coffee|starbucks|chipotle|mcdonald|dunkin|taco|pizza)\b/.test(lower) ? "dining" :
    /\b(uber one|netflix|spotify|google fi|apple\.com\/bill|subscription|monthly)\b/.test(lower) ? "subscriptions" :
    /\b(uber|lyft|gas|shell|bp|exxon|parking|transit)\b/.test(lower) && !/\beats\b/.test(payeeLower) ? "transport" :
    /\b(pharmacy|doctor|health|medical|dental)\b/.test(lower) ? "health" :
    /\b(electric|water|utility|internet|phone|wireless)\b/.test(lower) ? "utilities" :
    /\b(cinema|movie|game|steam|hulu|disney)\b/.test(lower) ? "entertainment" :
    "shopping";

  return {
    transaction_id: transaction.id,
    category,
    merchant_normalized: merchant,
    is_subscription_candidate: /\b(uber one|subscription|monthly|google fi|netflix|spotify|hulu|disney)\b/.test(lower),
    confidence: error ? 0.35 : 0.55,
    ai_reason: error ? `Deterministic fallback after AI error: ${String(error).slice(0, 180)}` : "Deterministic fallback category.",
    model
  };
}

function normalizeMerchant(text: string): string {
  const normalized = text
    .replace(/[^a-zA-Z0-9\s.'&/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .toLowerCase();
  return normalized || "unknown";
}

function normalizeTransactionMerchant(transaction: TransactionRow, fallback: string): string {
  const preferred = transaction.payee ?? fallback ?? transaction.description ?? "unknown";
  return normalizeMerchant(String(preferred));
}

function parseJsonObject(text: string): Record<string, unknown> {
  const candidates = jsonCandidates(text);
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as Record<string, unknown>;
    } catch (error) {
      lastError = error;
      try {
        return JSON.parse(repairJson(candidate)) as Record<string, unknown>;
      } catch (repairError) {
        lastError = repairError;
      }
    }
  }
  const detail = lastError instanceof Error ? lastError.message : "unknown parse error";
  throw new Error(`Workers AI did not return parseable JSON: ${detail}; raw_preview=${text.slice(0, 600)}`);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function jsonCandidates(text: string): string[] {
  const stripped = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const candidates = [stripped];
  const objectStart = stripped.indexOf("{");
  const objectEnd = stripped.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) candidates.push(stripped.slice(objectStart, objectEnd + 1));
  return [...new Set(candidates)];
}

function repairJson(text: string): string {
  let repaired = text
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/[\u0000-\u001F]+/g, " ");
  const openCurly = (repaired.match(/{/g) ?? []).length;
  const closeCurly = (repaired.match(/}/g) ?? []).length;
  const openSquare = (repaired.match(/\[/g) ?? []).length;
  const closeSquare = (repaired.match(/]/g) ?? []).length;
  if (closeSquare < openSquare) repaired += "]".repeat(openSquare - closeSquare);
  if (closeCurly < openCurly) repaired += "}".repeat(openCurly - closeCurly);
  return repaired;
}

function isInsight(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.merchant === "string" &&
    typeof record.amount === "number" &&
    typeof record.insight === "string" &&
    typeof record.action === "string";
}

function displayMerchant(transaction: TransactionRow): string {
  return String(transaction.payee ?? transaction.merchant_normalized ?? transaction.description ?? "unknown").trim() || "unknown";
}

function isFeeLike(transaction: TransactionRow): boolean {
  const text = transactionText(transaction).toLowerCase();
  return transaction.category === "fees" || /\b(fee|interest charge|purchase interest|late fee|returned payment)\b/.test(text);
}

function summarizeFeeTransactions(transactions: TransactionRow[]): Array<Record<string, unknown>> {
  const groups = new Map<string, { merchant: string; total: number; count: number; examples: string[] }>();
  for (const transaction of transactions.filter((row) => row.amount < 0 && isFeeLike(row))) {
    const merchant = canonicalMerchant(displayMerchant(transaction));
    const key = normalizeKey(merchant);
    const existing = groups.get(key) ?? { merchant, total: 0, count: 0, examples: [] };
    existing.total += Math.abs(transaction.amount);
    existing.count += 1;
    if (transaction.description && existing.examples.length < 2) existing.examples.push(transaction.description);
    groups.set(key, existing);
  }
  return [...groups.values()]
    .map((group) => ({
      merchant: group.merchant,
      total: roundMoney(group.total),
      count: group.count,
      examples: group.examples
    }))
    .sort((left, right) => Number(right.total) - Number(left.total));
}

function canonicalMerchant(value: string): string {
  const normalized = normalizeKey(value);
  if (normalized === "interest" || normalized === "interest charge") return "Interest Charge";
  if (normalized.includes("returned payment")) return "Returned Payment Fee";
  if (normalized.includes("apple credit card")) return "Payment: Apple Card";
  if (normalized.includes("american express credit card")) return "Payment: American Express";
  if (normalized.includes("chase credit card")) return "Payment: Chase";
  if (normalized === "doordash") return "DoorDash";
  if (normalized === "openai") return "OpenAI";
  return value;
}

function unusualCandidates(transactions: TransactionRow[], subscriptionKeys: Set<string>): Array<Record<string, unknown>> {
  const spend = transactions.filter((transaction) =>
    transaction.amount < 0 &&
    transaction.category !== "transfers" &&
    transaction.category !== "fees" &&
    !Boolean(transaction.is_subscription_candidate) &&
    !subscriptionKeys.has(normalizeKey(displayMerchant(transaction)))
  );
  const merchantGroups = groupAmounts(spend, (transaction) => normalizeKey(displayMerchant(transaction)));
  const categoryGroups = groupAmounts(spend, (transaction) => String(transaction.category ?? "uncategorized"));

  return spend
    .map((transaction) => {
      const amount = Math.abs(transaction.amount);
      const merchantStats = stats(merchantGroups.get(normalizeKey(displayMerchant(transaction))) ?? []);
      const categoryStats = stats(categoryGroups.get(String(transaction.category ?? "uncategorized")) ?? []);
      const baseline = merchantStats.count >= 2 ? merchantStats : categoryStats;
      const zScore = baseline.stddev > 0 ? (amount - baseline.average) / baseline.stddev : amount >= baseline.average * 2 ? 2 : 0;
      const oneOffScore = merchantStats.count <= 1 && amount >= 150 ? 1.5 : 0;
      const merchantAmounts = merchantGroups.get(normalizeKey(displayMerchant(transaction))) ?? [];
      const smallGroupSpike = merchantAmounts.length > 1 &&
        amount === Math.max(...merchantAmounts) &&
        amount >= 100 &&
        amount >= Math.max(1, Math.min(...merchantAmounts)) * 3
        ? 1.6
        : 0;
      const score = Math.max(zScore, oneOffScore, smallGroupSpike);
      return {
        ...transaction,
        merchant: displayMerchant(transaction),
        amount_abs: amount,
        baseline_average: roundMoney(baseline.average),
        z_score: Math.round(score * 100) / 100,
        deterministic_reason: merchantStats.count <= 1
          ? "Large one-off merchant in current cache."
          : "Above merchant/category baseline."
      };
    })
    .filter((transaction) => Number(transaction.z_score) >= 1.5 && Number(transaction.amount_abs) >= 75)
    .sort((left, right) => Number(right.z_score) - Number(left.z_score) || Number(right.amount_abs) - Number(left.amount_abs));
}

function groupAmounts(rows: TransactionRow[], keyFn: (transaction: TransactionRow) => string): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (const row of rows) {
    const key = keyFn(row);
    const values = groups.get(key) ?? [];
    values.push(Math.abs(row.amount));
    groups.set(key, values);
  }
  return groups;
}

function stats(values: number[]): { count: number; average: number; stddev: number } {
  if (values.length === 0) return { count: 0, average: 0, stddev: 0 };
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
  return { count: values.length, average, stddev: Math.sqrt(variance) };
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function inclusiveDaySpan(startDate: string, endDate: string): number {
  const start = new Date(`${startDate}T00:00:00Z`).getTime();
  const end = new Date(`${endDate}T00:00:00Z`).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 1;
  return Math.floor((end - start) / (24 * 60 * 60 * 1000)) + 1;
}

function daysBefore(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

function dateToEpoch(date: string): number {
  return Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
}
