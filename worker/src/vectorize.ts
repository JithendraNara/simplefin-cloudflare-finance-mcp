import type { Env, TransactionRow } from "./types.js";
import { FinanceRepository, transactionText } from "./repository.js";

export async function indexTransactions(env: Env, repo: FinanceRepository, limit = 50): Promise<Record<string, unknown>> {
  const embeddingModel = env.EMBEDDING_MODEL ?? "@cf/baai/bge-m3";
  const transactions = await repo.unindexedTransactions(limit);
  if (transactions.length === 0) return { indexed: 0 };

  let indexed = 0;
  for (const transaction of transactions) {
    try {
      const vector = await embedText(env, embeddingModel, transactionText(transaction));
      const vectorId = vectorIdForTransaction(transaction.id);
      await env.VECTOR_INDEX.upsert([
        {
          id: vectorId,
          values: vector,
          metadata: {
            transaction_id: transaction.id,
            account_id: transaction.account_id,
            category: transaction.category ?? "uncategorized"
          }
        }
      ]);
      await repo.saveSemanticIndexJob(transaction.id, vectorId, embeddingModel);
      indexed += 1;
    } catch (error) {
      await repo.saveAiUsage("semantic_index_transaction", embeddingModel, 1, "error", error);
    }
  }

  if (indexed > 0) {
    await repo.saveAiUsage("semantic_index_transaction", embeddingModel, indexed, "ok");
  }

  return { indexed, model: embeddingModel };
}

export async function semanticSearch(
  env: Env,
  repo: FinanceRepository,
  options: { query: string; limit: number; accountId?: string; startDate?: string; endDate?: string }
): Promise<Record<string, unknown>> {
  const embeddingModel = env.EMBEDDING_MODEL ?? "@cf/baai/bge-m3";
  const vector = await embedText(env, embeddingModel, options.query);
  const matches = await env.VECTOR_INDEX.query(vector, {
    topK: options.limit,
    returnMetadata: "all"
  });

  const ids = matches.matches
    .map((match) => {
      const metadata = match.metadata as Record<string, unknown> | undefined;
      return typeof metadata?.transaction_id === "string" ? metadata.transaction_id : undefined;
    })
    .filter((id): id is string => Boolean(id));

  const rows = await repo.transactionsByIds(ids);
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const start = options.startDate ? dateToEpoch(options.startDate) : undefined;
  const end = options.endDate ? dateToEpoch(addOneDay(options.endDate)) : undefined;
  const transactions = ids
    .map((id) => rowById.get(id))
    .filter((row): row is TransactionRow => Boolean(row))
    .filter((row) => !options.accountId || row.account_id === options.accountId)
    .filter((row) => start === undefined || (row.posted_at ?? row.transacted_at ?? 0) >= start)
    .filter((row) => end === undefined || (row.posted_at ?? row.transacted_at ?? 0) < end);

  return {
    query: options.query,
    matches: transactions,
    count: transactions.length
  };
}

async function embedText(env: Env, model: string, text: string): Promise<number[]> {
  const output = await env.AI.run(model, { text, truncate_inputs: true });
  if (output && typeof output === "object") {
    const record = output as Record<string, unknown>;
    const data = record.data;
    if (Array.isArray(data) && Array.isArray(data[0])) return data[0] as number[];
    const response = record.response;
    if (Array.isArray(response) && Array.isArray(response[0])) return response[0] as number[];
  }

  throw new Error("Workers AI embedding response did not include a vector");
}

function vectorIdForTransaction(transactionId: string): string {
  return `tx:${stableHash(transactionId)}`;
}

function stableHash(value: string): string {
  let first = 0xdeadbeef;
  let second = 0x41c6ce57;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 2654435761);
    second = Math.imul(second ^ code, 1597334677);
  }

  first = Math.imul(first ^ (first >>> 16), 2246822507) ^ Math.imul(second ^ (second >>> 13), 3266489909);
  second = Math.imul(second ^ (second >>> 16), 2246822507) ^ Math.imul(first ^ (first >>> 13), 3266489909);

  return `${(second >>> 0).toString(16).padStart(8, "0")}${(first >>> 0).toString(16).padStart(8, "0")}`;
}

function dateToEpoch(value: string): number {
  return Math.floor(new Date(`${value}T00:00:00Z`).getTime() / 1000);
}

function addOneDay(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
