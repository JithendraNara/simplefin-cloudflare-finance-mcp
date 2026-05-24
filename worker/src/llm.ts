import type { Env } from "./types.js";
import type { FinanceRepository } from "./repository.js";

export type AiTextTask =
  | "categorize_transactions"
  | "find_unusual_transactions"
  | "generate_weekly_money_briefing"
  | "query_finance"
  | "review_uncategorized_suggestions"
  | "recategorize_low_confidence"
  | "generate_correction_rule_text";

type GenerateTextOptions = {
  task: AiTextTask;
  system: string;
  prompt: string;
  workerModel?: string;
  maxTokens?: number;
  jsonSchema?: Record<string, unknown>;
};

type GenerateTextResult = {
  text: string;
  provider: "workers_ai" | "minimax_gateway";
  model: string;
};

export async function generateAiText(
  env: Env,
  repo: FinanceRepository,
  options: GenerateTextOptions
): Promise<GenerateTextResult> {
  const provider = providerForTask(env, options.task);
  if (provider === "minimax_gateway") {
    const rateLimit = await minimaxRateLimitStatus(env, repo, options.task);
    if (!rateLimit.allowed) {
      await repo.saveAiTokenUsage({
        task: options.task,
        provider: "minimax_gateway",
        model: env.MINIMAX_MODEL ?? "MiniMax-M2.7",
        status: "rate_limited",
        error: rateLimit.reason
      });
      return await generateWorkersAiText(env, options);
    }
    return await generateMiniMaxText(env, repo, options);
  }
  return await generateWorkersAiText(env, options);
}

export function providerForTask(env: Env, task: AiTextTask): "workers_ai" | "minimax_gateway" {
  const explicit = routeValue(env, task);
  return explicit === "minimax_gateway" ? "minimax_gateway" : "workers_ai";
}

function routeValue(env: Env, task: AiTextTask): string {
  if (task === "generate_weekly_money_briefing") return env.AI_ROUTE_GENERATE_WEEKLY_MONEY_BRIEFING ?? env.AI_TEXT_PROVIDER ?? "workers_ai";
  if (task === "find_unusual_transactions") return env.AI_ROUTE_FIND_UNUSUAL_TRANSACTIONS ?? env.AI_TEXT_PROVIDER ?? "workers_ai";
  if (task === "categorize_transactions") return env.AI_ROUTE_CATEGORIZE_TRANSACTIONS ?? "workers_ai";
  if (task === "query_finance") return env.AI_ROUTE_QUERY_FINANCE ?? env.AI_TEXT_PROVIDER ?? "workers_ai";
  if (task === "review_uncategorized_suggestions") return env.AI_ROUTE_REVIEW_UNCATEGORIZED_SUGGESTIONS ?? env.AI_TEXT_PROVIDER ?? "workers_ai";
  if (task === "recategorize_low_confidence") return env.AI_ROUTE_RECATEGORIZE_LOW_CONFIDENCE ?? env.AI_TEXT_PROVIDER ?? "workers_ai";
  if (task === "generate_correction_rule_text") return env.AI_ROUTE_GENERATE_CORRECTION_RULE_TEXT ?? env.AI_TEXT_PROVIDER ?? "workers_ai";
  return "workers_ai";
}

async function minimaxRateLimitStatus(
  env: Env,
  repo: FinanceRepository,
  task: AiTextTask
): Promise<{ allowed: boolean; reason?: string }> {
  const since = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
  const rows = await repo.aiTokenRequestCountsSince(since, "minimax_gateway");
  const totalUsed = rows.reduce((sum, row) => sum + Number(row.requests ?? 0), 0);
  const taskUsed = rows
    .filter((row) => row.task === task)
    .reduce((sum, row) => sum + Number(row.requests ?? 0), 0);
  const totalCap = envNumber(env.MINIMAX_TOTAL_PER_5HOURS, 500);
  const taskCap = minimaxTaskCap(env, task);
  if (totalUsed >= totalCap) {
    return { allowed: false, reason: `minimax_total_per_5hours_exceeded:${totalUsed}/${totalCap}` };
  }
  if (taskUsed >= taskCap) {
    return { allowed: false, reason: `minimax_task_per_5hours_exceeded:${task}:${taskUsed}/${taskCap}` };
  }
  return { allowed: true };
}

function minimaxTaskCap(env: Env, task: AiTextTask): number {
  if (task === "generate_weekly_money_briefing") return envNumber(env.MINIMAX_LIMIT_GENERATE_WEEKLY_MONEY_BRIEFING, 20);
  if (task === "find_unusual_transactions") return envNumber(env.MINIMAX_LIMIT_FIND_UNUSUAL_TRANSACTIONS, 100);
  if (task === "query_finance") return envNumber(env.MINIMAX_LIMIT_QUERY_FINANCE, 200);
  if (task === "recategorize_low_confidence") return envNumber(env.MINIMAX_LIMIT_RECATEGORIZE_LOW_CONFIDENCE, 50);
  if (task === "generate_correction_rule_text") return envNumber(env.MINIMAX_LIMIT_GENERATE_CORRECTION_RULE_TEXT, 100);
  if (task === "review_uncategorized_suggestions") return envNumber(env.MINIMAX_LIMIT_REVIEW_UNCATEGORIZED_SUGGESTIONS, 100);
  return 100;
}

function envNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function generateWorkersAiText(env: Env, options: GenerateTextOptions): Promise<GenerateTextResult> {
  const model = options.workerModel ?? env.AI_MODEL ?? "@cf/meta/llama-3.1-8b-instruct";
  const payload: Record<string, unknown> = {
    messages: [
      { role: "system", content: options.system },
      { role: "user", content: options.prompt }
    ]
  };
  if (options.jsonSchema) {
    payload.response_format = {
      type: "json_schema",
      json_schema: options.jsonSchema
    };
  }
  const output = await env.AI.run(model, payload as AiTextGenerationInput);
  return {
    text: extractText(output),
    provider: "workers_ai",
    model
  };
}

async function generateMiniMaxText(
  env: Env,
  repo: FinanceRepository,
  options: GenerateTextOptions
): Promise<GenerateTextResult> {
  const accountId = requiredEnv(env.AI_GATEWAY_ACCOUNT_ID, "AI_GATEWAY_ACCOUNT_ID");
  const gatewayId = env.AI_GATEWAY_ID ?? "default";
  const provider = env.AI_GATEWAY_PROVIDER ?? "custom-minimax";
  const token = requiredEnv(env.AI_GATEWAY_TOKEN, "AI_GATEWAY_TOKEN");
  const model = env.MINIMAX_MODEL ?? "MiniMax-M2.7";
  const url = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/${provider}/v1/chat/completions`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-aig-authorization": `Bearer ${token}`
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: options.maxTokens ?? 1500,
      messages: [
        { role: "system", content: `${options.system}\nReturn the final answer as parseable JSON after any reasoning. Do not include markdown fences.` },
        { role: "user", content: options.prompt }
      ]
    })
  });

  const body = await response.json().catch(async () => ({ error: await response.text() })) as Record<string, unknown>;
  const text = extractMiniMaxText(body);
  const usage = body.usage && typeof body.usage === "object" ? body.usage as Record<string, unknown> : {};
  const totalTokens = Number(usage.total_tokens ?? 0);
  const inputTokens = Number(usage.prompt_tokens ?? 0);
  const outputTokens = Number(usage.completion_tokens ?? 0);
  await repo.saveAiTokenUsage({
    task: options.task,
    provider: "minimax_gateway",
    model,
    inputTokens,
    outputTokens,
    totalTokens,
    status: response.ok ? "ok" : "error",
    error: response.ok ? undefined : JSON.stringify(body).slice(0, 500)
  });

  if (!response.ok) {
    throw new Error(`MiniMax AI Gateway request failed with ${response.status}: ${JSON.stringify(body).slice(0, 500)}`);
  }

  return {
    text,
    provider: "minimax_gateway",
    model: `minimax_gateway:${model}`
  };
}

function extractMiniMaxText(body: Record<string, unknown>): string {
  const choices = body.choices;
  if (Array.isArray(choices)) {
    const first = choices[0];
    if (first && typeof first === "object") {
      const message = (first as Record<string, unknown>).message;
      if (message && typeof message === "object") {
        const content = (message as Record<string, unknown>).content;
        if (typeof content === "string") return content;
      }
      const text = (first as Record<string, unknown>).text;
      if (typeof text === "string") return text;
    }
  }
  return extractText(body);
}

function extractText(output: unknown): string {
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

function requiredEnv(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required for MiniMax AI Gateway routing`);
  return value.trim();
}
