import { resolveTombstoneRetentionDays } from "./services.ts";
import { runReportedTask, type BackgroundFailure, type BackgroundFailureReporter } from "./background-tasks.ts";

/**
 * The scheduled maintenance run (audit F-22).
 *
 * Two bounded sweeps already existed — expired identity state (sessions, their
 * tokens, closed rate-limit windows, spent revocations) and expired tombstones —
 * but both only ever ran as a side effect of *something else writing*: every 128
 * rate-limit operations and every 32 article writes. On a quiet instance that is
 * close to never. A single-author site can go days without a write, so expired
 * sessions sat in the table and deleted works waited in the recycle bin for
 * traffic that never came.
 *
 * This module is the explicit trigger: one call that runs both sweeps, repeatedly
 * but boundedly, and *reports* what happened. It is deliberately not a long-lived
 * scheduler. A timer inside the API process would add one more lifetime to reason
 * about (startup, shutdown, overlapping instances, a stalled event loop) for work
 * that a cron entry does better. The entry point is
 * `src/persistence/maintenance.ts`, and the runbook is
 * `docs/operations/scheduled-maintenance.md`.
 *
 * What it does not do: it never touches object storage, never purges a work that
 * is still inside its retention window, never deletes anything a user asked to
 * keep, and never loops without a cap. Both sweeps are already bounded per call
 * by their stores (100 sessions and 512 rows per sweep; 100–500 works), which is
 * why draining a large backlog takes passes rather than one unbounded query.
 *
 * A failing sweep ends the run after the pass it failed in. The other sweep still
 * runs first, so one broken query cannot hide the rest of the batch, but a second
 * pass would only hammer a database that has already said no — and a run that
 * cannot complete a sweep cannot honestly claim convergence.
 */

export const DEFAULT_MAINTENANCE_MAX_PASSES = 5;
export const MAXIMUM_MAINTENANCE_PASSES = 20;
export const DEFAULT_MAINTENANCE_ARTICLE_LIMIT = 100;
export const MAXIMUM_MAINTENANCE_ARTICLE_LIMIT = 500;

export type MaintenanceRemoved = {
  sessions: number;
  rateLimits: number;
  revokedSessions: number;
  identityTokens: number;
  articles: number;
};

export type MaintenanceFailure = BackgroundFailure;

export type MaintenanceReport = {
  /** Passes actually executed. */
  passes: number;
  removed: MaintenanceRemoved;
  failures: MaintenanceFailure[];
  /** True when a pass completed with both sweeps succeeding and nothing left to remove. */
  converged: boolean;
  /** True when no sweep failed. A capped run that removed rows is still `ok`. */
  ok: boolean;
};

/**
 * The part of the store this run needs.
 *
 * Both methods are optional because the two adapters and the test doubles do not
 * all implement both; a missing method is simply not a sweep, not a failure.
 */
export type MaintenanceStore = {
  pruneExpiredIdentityState?: () => Promise<unknown>;
  purgeExpiredArticles?: (input: { retentionDays: number; now: Date; limit: number }) => Promise<unknown>;
};

function boundedInteger(name: string, value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function countOf(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

/** Counts from an identity sweep: the port types the result as `unknown`. */
function identityCounts(value: unknown): Omit<MaintenanceRemoved, "articles"> {
  const record: Record<string, unknown> = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  return {
    sessions: countOf(record.sessions),
    rateLimits: countOf(record.rateLimits),
    revokedSessions: countOf(record.revokedSessions),
    identityTokens: countOf(record.identityTokens),
  };
}

export async function runMaintenance({
  store,
  env = process.env,
  now = new Date(),
  maxPasses,
  articleLimit,
  onBackgroundFailure = null,
}: {
  store: MaintenanceStore;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  maxPasses?: number;
  articleLimit?: number;
  onBackgroundFailure?: BackgroundFailureReporter;
}): Promise<MaintenanceReport> {
  // Bounds are validated before anything runs: a scheduler entry with a typo must
  // fail loudly, not quietly sweep an unbounded amount or exit successfully
  // having done nothing.
  const passes = boundedInteger("maxPasses", maxPasses, DEFAULT_MAINTENANCE_MAX_PASSES, MAXIMUM_MAINTENANCE_PASSES);
  const limit = boundedInteger("articleLimit", articleLimit, DEFAULT_MAINTENANCE_ARTICLE_LIMIT, MAXIMUM_MAINTENANCE_ARTICLE_LIMIT);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new RangeError("now must be a valid date.");
  const retentionDays = resolveTombstoneRetentionDays(env);

  const removed: MaintenanceRemoved = { sessions: 0, rateLimits: 0, revokedSessions: 0, identityTokens: 0, articles: 0 };
  const failures: BackgroundFailure[] = [];
  let executed = 0;
  let converged = false;

  for (let pass = 0; pass < passes; pass += 1) {
    executed += 1;
    let removedThisPass = 0;
    let bothSucceeded = true;

    const identitySweep = async (): Promise<unknown> => store.pruneExpiredIdentityState!();
    if (typeof store.pruneExpiredIdentityState === "function") {
      const outcome = await runReportedTask({ task: "identity-prune", work: identitySweep, report: onBackgroundFailure });
      if (!outcome.failure) {
        const counts = identityCounts(outcome.value);
        removed.sessions += counts.sessions;
        removed.rateLimits += counts.rateLimits;
        removed.revokedSessions += counts.revokedSessions;
        removed.identityTokens += counts.identityTokens;
        removedThisPass += counts.sessions + counts.rateLimits + counts.revokedSessions + counts.identityTokens;
      } else {
        failures.push(outcome.failure);
        bothSucceeded = false;
      }
    }

    const tombstoneSweep = async (): Promise<unknown> =>
      store.purgeExpiredArticles!({ retentionDays, now, limit });
    if (typeof store.purgeExpiredArticles === "function") {
      const outcome = await runReportedTask({ task: "tombstone-purge", work: tombstoneSweep, report: onBackgroundFailure });
      if (!outcome.failure) {
        const result = typeof outcome.value === "object" && outcome.value !== null
          ? outcome.value as { purged?: unknown }
          : {};
        const count = countOf(result.purged);
        removed.articles += count;
        removedThisPass += count;
      } else {
        failures.push(outcome.failure);
        bothSucceeded = false;
      }
    }

    // Stops after the pass a sweep failed in, and stops as soon as a pass that
    // ran to completion removed nothing — that is what convergence means here.
    if (!bothSucceeded) break;
    if (removedThisPass === 0) {
      converged = true;
      break;
    }
  }

  return { passes: executed, removed, failures, converged, ok: failures.length === 0 };
}
