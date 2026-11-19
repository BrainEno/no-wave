import { createNotionJobPayloadCipher } from "../application/notion-import-job-payload.ts";
import { validNotionJobKeyId, type NotionJobPayload } from "../application/notion-durable-jobs.ts";

const invalidConfiguration = () => new RangeError("Configure exactly one canonical 32-byte NOTION_IMPORT_JOB_KEY, or at most three distinct id:base64 entries in NOTION_IMPORT_JOB_KEYS with an explicit NOTION_IMPORT_JOB_ACTIVE_KEY.");
type Context = { jobId: string; ownerId: string; expiresAt: number };

/** Key bytes remain outside the database. Merely loading a ring never rotates/re-encrypts a row. */
export function createNotionJobKeyring(env: NodeJS.ProcessEnv) {
  const single = env.NOTION_IMPORT_JOB_KEY;
  const multiple = env.NOTION_IMPORT_JOB_KEYS;
  const active = env.NOTION_IMPORT_JOB_ACTIVE_KEY;
  const ciphers = new Map<string, ReturnType<typeof createNotionJobPayloadCipher>>();
  let activeId: string;
  function add(id: string, encoded: string): void {
    if (!validNotionJobKeyId(id) || ciphers.has(id) || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw invalidConfiguration();
    const bytes = Buffer.from(encoded, "base64");
    try {
      if (bytes.length !== 32 || bytes.toString("base64") !== encoded) throw invalidConfiguration();
      ciphers.set(id, createNotionJobPayloadCipher(bytes));
    } finally { bytes.fill(0); }
  }
  if (single !== undefined) {
    if (multiple !== undefined || active !== undefined) throw invalidConfiguration();
    activeId = "primary";
    add(activeId, single);
  } else {
    if (typeof multiple !== "string" || multiple.length > 240 || typeof active !== "string" || !validNotionJobKeyId(active)) throw invalidConfiguration();
    const entries = multiple.split(",");
    if (!entries.length || entries.length > 3) throw invalidConfiguration();
    for (const entry of entries) {
      const pair = entry.split(":");
      if (pair.length !== 2) throw invalidConfiguration();
      add(pair[0]!, pair[1]!);
    }
    if (!ciphers.has(active)) throw invalidConfiguration();
    activeId = active;
  }
  function context(input: Context, keyId: string, kind: "bundle" | "plan"): Context {
    // Authenticating the id prevents alias changes even if two key ids share bytes.
    return { jobId: `${input.jobId}:${kind}:${keyId}`, ownerId: input.ownerId, expiresAt: input.expiresAt };
  }
  return Object.freeze({
    activeId,
    seal(input: Context & { bundle: Uint8Array; plan: Uint8Array; now: number }): NotionJobPayload {
      const cipher = ciphers.get(activeId)!;
      return { keyId: activeId,
        bundle: cipher.seal(input.bundle, context(input, activeId, "bundle"), input.now),
        plan: cipher.seal(input.plan, context(input, activeId, "plan"), input.now) };
    },
    open(input: NotionJobPayload, expected: Context, now: number): { bundle: Buffer; plan: Buffer } {
      let bundle: Buffer | undefined;
      try {
        if (!input || !validNotionJobKeyId(input.keyId)) throw new Error();
        const cipher = ciphers.get(input.keyId);
        if (!cipher || input.bundle.expiresAt !== expected.expiresAt || input.plan.expiresAt !== expected.expiresAt) throw new Error();
        bundle = cipher.open(input.bundle, context(expected, input.keyId, "bundle"), now);
        const plan = cipher.open(input.plan, context(expected, input.keyId, "plan"), now);
        return { bundle, plan };
      } catch {
        bundle?.fill(0);
        throw new Error("Encrypted job payload unavailable or invalid");
      }
    },
  });
}
