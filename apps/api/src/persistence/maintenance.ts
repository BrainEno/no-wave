import { createPersistenceRuntime } from "../infrastructure/persistence-runtime.ts";
import { runMaintenance, DEFAULT_MAINTENANCE_ARTICLE_LIMIT, DEFAULT_MAINTENANCE_MAX_PASSES, MAXIMUM_MAINTENANCE_ARTICLE_LIMIT, MAXIMUM_MAINTENANCE_PASSES } from "../application/maintenance.ts";
import { safeErrorClass } from "../application/background-tasks.ts";

/**
 * One-shot maintenance run (audit F-22).
 *
 *     pnpm --filter @bot-thk/api maintenance
 *
 * The cleanup sweeps — expired sessions and their tokens, closed rate-limit
 * windows, spent revocations, and article tombstones past their retention window
 * — used to run only when something else wrote. Every 128 rate-limit checks and
 * every 32 article writes, a quiet instance cleaned up nothing at all.
 *
 * This process is the explicit trigger: an external scheduler (cron, a scheduled
 * GitHub Action, systemd timer) starts it, it sweeps what is due, and it exits.
 * There is no long-lived worker and no HTTP endpoint, so nothing new has to be
 * protected and no maintenance secret has to exist. The runbook, including a cron
 * line and the meaning of every exit code, is
 * `docs/operations/scheduled-maintenance.md`.
 *
 * It is safe to overlap with a running API: both sweeps are bounded per statement
 * and the providers serialize their own writes, so a second run cannot double
 * delete or double count — it finds less to do. It is also idempotent: run it twice
 * and the second run is a no-op that says so.
 *
 * Safety: every setting is validated and bounded before the pool is opened, the
 * number of passes is capped, and failures are logged as an error *class* only —
 * driver messages can contain connection strings and bind parameters.
 */

function integerSetting(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    // `RangeError` rather than `Error`: it is our own text, so it is safe to print
    // in full, and the catch below prints it only for this class.
    throw new RangeError(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

/**
 * Read the two bounds.
 *
 * Called from inside the run, not at module scope: a top-level throw exits before
 * the promise below can format it, and a scheduler would get a stack trace
 * instead of one JSON line saying which variable was wrong.
 */
function readSettings() {
  return {
    maxPasses: integerSetting("MAINTENANCE_MAX_PASSES", DEFAULT_MAINTENANCE_MAX_PASSES, 1, MAXIMUM_MAINTENANCE_PASSES),
    articleLimit: integerSetting(
      "MAINTENANCE_ARTICLE_LIMIT",
      DEFAULT_MAINTENANCE_ARTICLE_LIMIT,
      1,
      MAXIMUM_MAINTENANCE_ARTICLE_LIMIT,
    ),
  };
}

type LogFields = Record<string, unknown>;

function writeMaintenanceLog(level: "info" | "warn" | "error", event: string, fields: LogFields = {}): void {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    component: "maintenance",
    event,
    ...fields,
  }) + "\n";
  if (level === "info") process.stdout.write(line);
  else process.stderr.write(line);
}

async function runMaintenanceProcess(): Promise<boolean> {
  // Validated first, so a typo in the cron entry never opens a pool.
  const { maxPasses, articleLimit } = readSettings();
  // Resolved through the same runtime as the API, so `DATABASE_PROVIDER`,
  // `DATABASE_PATH` and `DATABASE_URL` mean here exactly what they mean there —
  // SQLite is the default, not an afterthought.
  const runtime = await createPersistenceRuntime({ env: process.env });
  try {
    await runtime.adapter.health();
    writeMaintenanceLog("info", "maintenance_started", {
      provider: runtime.provider,
      maxPasses,
      articleLimit,
    });

    const report = await runMaintenance({
      store: runtime.adapter,
      maxPasses,
      articleLimit,
      // Reported as it happens so a scheduler's log shows *which* sweep broke, not
      // only that the run was unhappy.
      onBackgroundFailure: (failure) => writeMaintenanceLog("warn", "background_task_failed", failure),
    });

    // A run that removed nothing is the normal case on a quiet instance: it is
    // `info`, not a warning, or every scheduled run would look like an incident.
    const removedNothing = report.removed.sessions === 0
      && report.removed.rateLimits === 0
      && report.removed.revokedSessions === 0
      && report.removed.identityTokens === 0
      && report.removed.articles === 0;
    writeMaintenanceLog(
      report.ok ? "info" : "error",
      report.ok ? "maintenance_completed" : "maintenance_failed",
      { ...report, removedNothing },
    );
    return report.ok;
  } finally {
    await runtime.close();
  }
}

runMaintenanceProcess().then(
  (ok) => {
    process.exitCode = ok ? 0 : 1;
  },
  (error) => {
    // Two failure shapes get here: an invalid setting (a typo in the cron entry)
    // and a database that cannot be reached or is not migrated. Both must be
    // loud, and neither may echo the message of a driver error.
    const message = error instanceof Error && error.name === "RangeError" ? error.message : null;
    writeMaintenanceLog("error", "maintenance_failed_to_start", {
      errorName: safeErrorClass(error),
      ...(message ? { errorMessage: message.slice(0, 200) } : {}),
    });
    process.exitCode = 1;
  },
);
