/**
 * How a background task reports a failure (audit F-22).
 *
 * Three things in the API do work nobody asked for at request time: the expired
 * identity prune, the expired tombstone purge, and the inbox rows that tell
 * commenters their words are about to go. All three used to `catch {}`. A
 * database that had stopped accepting deletes looked exactly like a database with
 * nothing to delete — forever, and silently. A swallowed failure is not a safety
 * feature, it is a backlog nobody can see.
 *
 * The rule this module encodes is the one the notification drain already follows:
 * a background failure is *reported*, never rethrown into the request that
 * happens to be carrying it, and the report carries the error **class only**.
 * Driver messages can contain connection strings, SQL and bind parameters, and
 * this report ends up in an operator's log line.
 */

export type BackgroundTaskName =
  /** `pruneExpiredIdentityState`: expired sessions, tokens, revocations, windows. */
  | "identity-prune"
  /** `purgeExpiredArticles`: works that have been in the recycle bin too long. */
  | "tombstone-purge"
  /** The inbox rows written while a work is deleted, one per commenter. */
  | "tombstone-notifications";

export type BackgroundFailure = {
  task: BackgroundTaskName;
  /** The error class only, reduced to `[A-Za-z][A-Za-z0-9_]{0,63}`. */
  errorName: string;
  /** Failed units of work, when the task can count them. Absent for one-off tasks. */
  failed?: number;
};

export type BackgroundFailureReporter = ((failure: BackgroundFailure) => void) | null;

/**
 * Reduce an unknown throw to a class name that is safe to log.
 *
 * `error.name` is used rather than `error.message`: the class is what classifies
 * an incident ("the pool is exhausted" vs "the table is locked") and it cannot
 * carry credentials. Anything that is not an identifier — a `Symbol`, a name with
 * spaces, a 10 KB driver string dropped into the name field — collapses to
 * `Error`, because a truncated class name is a wrong one.
 */
export function safeErrorClass(error: unknown): string {
  if (!(error instanceof Error)) return "NonErrorThrow";
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : "Error";
}

/**
 * One shape, not a discriminated union: the API compiles with
 * `strict: false`, where a literal-discriminant union cannot be narrowed by an
 * `if`. `failure` is the field to test, and its absence means the task ran.
 */
export type TaskOutcome<Value> = {
  ok: boolean;
  value?: Value;
  failure?: BackgroundFailure;
};

/**
 * Run one background task, reporting a failure instead of throwing it.
 *
 * `report` is optional so a test or an embedded host that supplies its own
 * observability can leave it out. The failure is still a returned value rather
 * than an exception, which is what keeps a broken cleanup from failing the user's
 * save.
 */
export async function runReportedTask<Value>({
  task,
  work,
  report = null,
  failed,
}: {
  task: BackgroundTaskName;
  work: () => Promise<Value>;
  report?: BackgroundFailureReporter;
  /** A pre-computed failure count, for a task that swallows its own inner errors. */
  failed?: number;
}): Promise<TaskOutcome<Value>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    const failure: BackgroundFailure = { task, errorName: safeErrorClass(error) };
    if (typeof failed === "number" && Number.isInteger(failed) && failed > 0) failure.failed = failed;
    // The reporter itself may not fail the task: a custom sink that throws would
    // otherwise re-open the hole this module exists to close.
    try {
      report?.(failure);
    } catch {
      // Nothing sensible to do here, and rethrowing would defeat the contract.
    }
    return { ok: false, failure };
  }
}
