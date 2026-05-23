import type { Env, SyncOptions } from "./types.js";
import { fetchSimpleFinAccounts } from "./simplefin.js";
import { FinanceRepository } from "./repository.js";
import { categorizeTransactions, generateBriefing } from "./ai.js";
import { indexTransactions } from "./vectorize.js";
import { daysAfter, daysBefore, maxDate, today } from "./http.js";

const MAX_SIMPLEFIN_WINDOW_DAYS = 90;
const DEFAULT_INCREMENTAL_OVERLAP_DAYS = 3;
const MAX_AUTO_BACKFILL_ACCOUNTS_PER_SYNC = 5;

export class ManualSyncRateLimitError extends Error {
  constructor() {
    super("manual sync rate limit reached; use force=true with admin token if you really need another sync");
    this.name = "ManualSyncRateLimitError";
  }
}

export async function syncSimpleFin(env: Env, options: SyncOptions): Promise<Record<string, unknown>> {
  const repo = new FinanceRepository(env);
  const endDate = options.endDate ?? today();
  const { startDate, mode, overlapDays } = await resolveSyncWindow(env, repo, options, endDate);
  const normalized = { startDate, endDate, trigger: options.trigger };

  if (options.trigger === "manual" && !options.force) {
    const recentManualSyncs = await repo.recentManualSyncCount();
    if (recentManualSyncs >= 3) {
      throw new ManualSyncRateLimitError();
    }
  }

  try {
    const knownAccountIds = new Set(await repo.accountIds());
    const payload = await fetchSimpleFinAccounts(env.SIMPLEFIN_ACCESS_URL, {
      startDate,
      endDate,
      pending: options.pending ?? true
    });
    const sync = await repo.saveSyncPayload(payload, normalized);
    const syncedAccountIds = (payload.accounts ?? []).map((account) => account.id);
    const newAccountIds = syncedAccountIds.filter((accountId) => !knownAccountIds.has(accountId));
    const coverage = await repo.refreshAccountCoverage({
      accountIds: syncedAccountIds,
      newAccountIds,
      syncRunId: sync.sync_run_id as string | undefined,
      startDate,
      endDate,
      trigger: options.trigger,
      errlist: sync.errlist as unknown[] | undefined
    });
    const accountBackfills = await backfillAccounts(env, repo, {
      accountIds: coverage.candidates as string[] | undefined,
      endDate,
      pending: options.pending ?? true
    });
    const categorization = await categorizeTransactions(env, repo, 20);
    const indexing = await indexTransactions(env, repo, 50);
    const briefing = await generateBriefing(env, repo, daysBefore(endDate, 6), endDate, true);

    return {
      ...sync,
      sync_mode: mode,
      overlap_days: overlapDays,
      account_coverage: coverage.summary,
      account_backfills: accountBackfills,
      enrichment: categorization,
      indexing,
      briefing
    };
  } catch (error) {
    await repo.saveFailedSync(normalized, error);
    throw error;
  }
}

async function resolveSyncWindow(
  env: Env,
  repo: FinanceRepository,
  options: SyncOptions,
  endDate: string
): Promise<{ startDate: string; mode: "explicit" | "initial" | "incremental"; overlapDays: number }> {
  if (options.startDate) {
    return {
      startDate: clampWindow(options.startDate, endDate),
      mode: "explicit",
      overlapDays: 0
    };
  }

  if (options.days !== undefined) {
    const days = Math.max(1, Math.min(options.days, MAX_SIMPLEFIN_WINDOW_DAYS));
    return {
      startDate: daysBefore(endDate, days),
      mode: "explicit",
      overlapDays: 0
    };
  }

  const lastSync = await repo.latestSuccessfulSync();
  if (!lastSync) {
    const days = Math.max(1, Math.min(Number(env.SYNC_DAYS ?? "45"), MAX_SIMPLEFIN_WINDOW_DAYS));
    return {
      startDate: daysBefore(endDate, days),
      mode: "initial",
      overlapDays: 0
    };
  }

  const overlapDays = Math.max(0, Math.min(Number(env.INCREMENTAL_OVERLAP_DAYS ?? DEFAULT_INCREMENTAL_OVERLAP_DAYS), 14));
  const overlapStart = daysBefore(lastSync.end_date, overlapDays);
  const nextUnseenDate = daysAfter(lastSync.end_date, 1);
  const incrementalStart = overlapDays > 0 ? overlapStart : nextUnseenDate;

  return {
    startDate: clampWindow(maxDate(incrementalStart, daysBefore(endDate, MAX_SIMPLEFIN_WINDOW_DAYS)), endDate),
    mode: "incremental",
    overlapDays
  };
}

function clampWindow(startDate: string, endDate: string): string {
  return maxDate(startDate, daysBefore(endDate, MAX_SIMPLEFIN_WINDOW_DAYS));
}

async function backfillAccounts(
  env: Env,
  repo: FinanceRepository,
  options: { accountIds?: string[]; endDate: string; pending: boolean }
): Promise<Record<string, unknown>> {
  const accountIds = [...new Set(options.accountIds ?? [])].slice(0, MAX_AUTO_BACKFILL_ACCOUNTS_PER_SYNC);
  const skipped = Math.max(0, (options.accountIds?.length ?? 0) - accountIds.length);
  if (accountIds.length === 0) return { attempted: 0, completed: 0, skipped };

  const startDate = daysBefore(options.endDate, MAX_SIMPLEFIN_WINDOW_DAYS);
  const results: Record<string, unknown>[] = [];
  for (const accountId of accountIds) {
    try {
      const payload = await fetchSimpleFinAccounts(env.SIMPLEFIN_ACCESS_URL, {
        startDate,
        endDate: options.endDate,
        pending: options.pending,
        accountIds: [accountId]
      });
      const sync = await repo.saveSyncPayload(payload, {
        startDate,
        endDate: options.endDate,
        trigger: "auto_backfill"
      });
      const accountCoverage = await repo.refreshAccountCoverage({
        accountIds: [accountId],
        syncRunId: sync.sync_run_id as string | undefined,
        startDate,
        endDate: options.endDate,
        trigger: "auto_backfill",
        isBackfill: true,
        backfillDays: MAX_SIMPLEFIN_WINDOW_DAYS,
        errlist: sync.errlist as unknown[] | undefined
      });
      results.push({
        account_id: accountId,
        status: "ok",
        sync_run_id: sync.sync_run_id,
        transaction_count_returned: sync.transaction_count,
        coverage: accountCoverage.summary
      });
    } catch (error) {
      results.push({
        account_id: accountId,
        status: "error",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    attempted: accountIds.length,
    completed: results.filter((result) => result.status === "ok").length,
    skipped,
    start_date: startDate,
    end_date: options.endDate,
    results
  };
}
