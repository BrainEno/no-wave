import { runNotionJobCheck } from "../application/notion-job-check.ts";
import { createNotionJobKeyring } from "../infrastructure/notion-job-keys.ts";
import { createApplicationServices } from "../application/services.ts";
import { createNotionJobService } from "../application/notion-job-service.ts";
import { NotionJobError } from "../application/notion-durable-jobs.ts";
import { runNotionJobDrain } from "../application/notion-job-drain.ts";
import { createMediaAssetService } from "../application/media-assets.ts";
import { createMediaObjectStorage } from "../infrastructure/media-storage.ts";
import { createPersistenceRuntime } from "../infrastructure/persistence-runtime.ts";
import { notionDrainSettings, notionJobSettings } from "../infrastructure/notion-job-settings.ts";
import { fetchNotionImage } from "../infrastructure/notion-image-fetch.ts";
import { isMainModule } from "../infrastructure/entrypoint.ts";
import { safeErrorClass } from "../application/background-tasks.ts";
import { accessIssuerConfiguration } from "../security/authentication.ts";

const HELP = `Usage: pnpm --filter @bot-thk/api jobs:notion [drain|inspect|check|sweep|--help]

drain    Run at most NOTION_IMPORT_DRAIN_MAX_JOBS (1..10, default 1) sequentially.
         Requires explicit NOTION_IMPORT_JOBS_ENABLED=true, the external encryption
         key and the API authentication configuration. No Notion credential.
check    Read-only decryption/signature/generation check of at most 32 active inputs.
         Requires external keys and authentication settings, not enablement.
         Quiesce admissions and drain processes first; emits only aggregate facts.
inspect  Read aggregate queue counts/age/bytes only; no key or authentication setup.
sweep    Expire queued/running input and delete old statuses; no decryption key.
         An expired running lease is interrupted, NEVER retried.

All operations use the configured API database and require current migrations.
No migration, key generation/rotation, deployment or media deletion is automatic.
Default cooperative drain deadline: 300000ms (1000..900000). Cancellation stops
admitting work and waits for physical operations; it is not a hard process kill.
Keep a separately bounded host termination budget and inspect interrupted jobs.
`;
export function parseNotionJobCommand(argv: readonly string[]): { command: "drain" | "inspect" | "check" | "sweep" | "help" } {
  if (argv.length > 1) throw new RangeError("Supply exactly one Notion jobs command.");
  const command = argv[0] ?? "drain";
  if (command === "--help" || command === "-h") return { command: "help" };
  if (command !== "drain" && command !== "inspect" && command !== "check" && command !== "sweep") throw new RangeError("Unknown Notion jobs command. Use --help.");
  return { command };
}

/** Independent operator process, not an API timer or a public drain endpoint. */
export async function runNotionJobCommand(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { command } = parseNotionJobCommand(argv);
  if (command === "help") { process.stdout.write(HELP); return 0; }
  const bounds = command === "drain" ? notionDrainSettings(env) : null;
  const checkKeys = command === "check" ? createNotionJobKeyring(env) : null;
  if (command === "check") accessIssuerConfiguration(env);
  if (command === "drain") {
    if (!notionJobSettings(env)) throw new NotionJobError("IMPORT_JOBS_DISABLED");
    accessIssuerConfiguration(env);
  }
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  let runtime: Awaited<ReturnType<typeof createPersistenceRuntime>> | null = null;
  let storage: ReturnType<typeof createMediaObjectStorage> = null;
  function log(event: string, facts: object): void {
    process.stdout.write(JSON.stringify({ event, component: "notion-import-jobs", ...facts }) + "\n");
  }
  try {
    runtime = await createPersistenceRuntime({ env });
    await runtime.adapter.health();
    if (controller.signal.aborted) return 130;
    if (command === "inspect") {
      log("notion_jobs_inspected", await runtime.adapter.notionImportJobBacklog());
      return 0;
    }
    if (command === "sweep") {
      await runtime.adapter.sweepNotionImportJobs();
      log("notion_jobs_swept", await runtime.adapter.notionImportJobBacklog());
      return 0;
    }
    if (command === "check" && checkKeys) {
      const deps = createApplicationServices({ persistence: runtime.adapter, env });
      const result = await runNotionJobCheck({ store: runtime.adapter, deps, keyring: checkKeys, signal: controller.signal });
      log("notion_job_inputs_checked", result);
      if (controller.signal.aborted) return 130;
      return result.stopReason !== "complete" || result.checked !== result.inputs.ready ? 1 : 0;
    }
    storage = createMediaObjectStorage(env);
    const media = storage ? createMediaAssetService({ store: runtime.adapter, storage }) : null;
    const deps = createApplicationServices({ persistence: runtime.adapter, env });
    const jobs = createNotionJobService({ store: runtime.adapter, deps, env });
    if (!jobs || !bounds) throw new NotionJobError("IMPORT_JOBS_DISABLED");
    const result = await runNotionJobDrain({ jobs, store: runtime.adapter, deps, ...bounds, signal: controller.signal,
      copyImage: async (url, previousSrc, ownerId) => {
        if (controller.signal.aborted) throw new NotionJobError("IMPORT_JOB_LEASE_LOST");
        if (!media) return { ok: false, reason: "media storage is not configured" };
        const fetched = await fetchNotionImage(url);
        if (controller.signal.aborted) throw new NotionJobError("IMPORT_JOB_LEASE_LOST");
        if (!fetched.ok) return fetched;
        try {
          const reuseId = /^\/api\/media\/([0-9a-f-]{36})$/i.exec(previousSrc ?? "")?.[1];
          const asset = await media.upload({ ownerId, bytes: fetched.bytes, contentType: fetched.contentType,
            ...(reuseId ? { reuseId } : {}) });
          return { ok: true, src: asset.src };
        } catch { return { ok: false, reason: "image could not be validated or stored" }; }
      },
    });
    log("notion_jobs_drained", result);
    if (controller.signal.aborted) return 130;
    return result.failed || result.interrupted || result.unavailable || result.stopReason === "deadline" ? 1 : 0;
  } finally {
    try {
      // runNotionJobDrain physically settles before either resource may close.
      await storage?.close();
    } finally {
      try { await runtime?.close(); }
      finally { process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal); }
    }
  }
}

if (isMainModule(import.meta.url)) {
  runNotionJobCommand(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    // Never print driver/URL/payload/environment messages, even for startup errors.
    process.stderr.write(JSON.stringify({ event: "notion_jobs_command_failed", errorName: safeErrorClass(error) }) + "\n");
    process.exitCode = 1;
  });
}
