import { createNotionJobKeyring } from "./notion-job-keys.ts";

/** Disabled by default. Provisioning/rotation is an operator action, never a migration. */
export function notionJobSettings(env: NodeJS.ProcessEnv = process.env) {
  const enabled = env.NOTION_IMPORT_JOBS_ENABLED;
  if (enabled !== undefined && enabled !== "false" && enabled !== "true") throw new RangeError("NOTION_IMPORT_JOBS_ENABLED must be true or false.");
  if (enabled !== "true") return null;
  return Object.freeze({ keyring: createNotionJobKeyring(env) });
}

/** Bound the one-shot worker before acquiring a pool or media storage. */
export function notionDrainSettings(env: NodeJS.ProcessEnv = process.env) {
  function integer(name: string, fallback: number, min: number, max: number): number {
    const raw = env[name];
    if (raw === undefined) return fallback;
    if (!/^[1-9][0-9]*$/.test(raw)) throw new RangeError(`${name} must be a bounded positive integer.`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} must be between ${min} and ${max}.`);
    return value;
  }
  return Object.freeze({ maxJobs: integer("NOTION_IMPORT_DRAIN_MAX_JOBS", 1, 1, 10),
    deadlineMs: integer("NOTION_IMPORT_DRAIN_DEADLINE_MS", 300_000, 1000, 900_000) });
}
