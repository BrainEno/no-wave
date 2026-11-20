import { writingRecord } from "./writing-document.ts";
import { COLLECTION_BYTE_LIMIT } from "./writing-collection.ts";
import {
  validateVaultPassword,
  type VaultOpened,
  type WritingVaultCryptography,
} from "./writing-vault-crypto.ts";
import {
  VAULT_FILE_LIMIT,
  VaultError,
  vaultFailure,
  vaultSize,
  type VaultBytes,
  type VaultFailureCode,
} from "./writing-vault-format.ts";
import type {
  VaultReview,
  VaultVerification,
} from "./writing-vault-payload.ts";

export const VAULT_WORKER_PROTOCOL = "no-wave-writing-vault-worker-v1";
export const VAULT_WORKER_STAGES = [
  "validating",
  "deriving",
  "encrypting",
  "self-checking",
  "decrypting",
] as const;
export type VaultWorkerAction =
  "inspect" | "seal" | "open" | "rotate" | "verify";
export type VaultWorkerPort = EventTarget & {
  postMessage(message: unknown, transfer: Transferable[]): void;
  terminate(): void;
};
export type VaultWorkerScope = EventTarget & {
  postMessage(message: unknown, transfer?: Transferable[]): void;
};
type WorkerEngine = Pick<
  WritingVaultCryptography,
  "inspect" | "seal" | "open" | "rotate" | "verify"
>;
type Request = {
  id: number;
  action: VaultWorkerAction;
  input: VaultBytes;
  password: string;
  replacement: string;
};

function exactMessage(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> | null {
  const raw = writingRecord(value);
  return raw &&
    Object.keys(raw).length === fields.length &&
    fields.every((field) => Object.hasOwn(raw, field))
    ? raw
    : null;
}
export function vaultWorkerId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
export function wipeVaultMessage(value: unknown): void {
  const raw = writingRecord(value);
  if (raw?.input instanceof Uint8Array) raw.input.fill(0);
  const result = writingRecord(raw?.result);
  if (result?.bytes instanceof Uint8Array) result.bytes.fill(0);
  if (raw && Object.hasOwn(raw, "password")) raw.password = "";
  if (raw && Object.hasOwn(raw, "replacement")) raw.replacement = "";
}
function request(value: unknown): Request {
  const raw = exactMessage(value, [
    "protocol",
    "kind",
    "id",
    "action",
    "input",
    "password",
    "replacement",
  ]);
  if (
    !raw ||
    raw.protocol !== VAULT_WORKER_PROTOCOL ||
    raw.kind !== "run" ||
    !vaultWorkerId(raw.id) ||
    !["inspect", "seal", "open", "rotate", "verify"].includes(
      String(raw.action),
    ) ||
    !(raw.input instanceof Uint8Array) ||
    !(raw.input.buffer instanceof ArrayBuffer) ||
    raw.input.byteOffset !== 0 ||
    raw.input.byteLength !== raw.input.buffer.byteLength ||
    typeof raw.password !== "string" ||
    typeof raw.replacement !== "string"
  )
    throw new VaultError("format");
  const action = raw.action as VaultWorkerAction;
  vaultSize(
    raw.input.byteLength,
    action === "inspect" || action === "seal"
      ? COLLECTION_BYTE_LIMIT
      : VAULT_FILE_LIMIT,
  );
  if (action === "inspect") {
    if (raw.password !== "" || raw.replacement !== "")
      throw new VaultError("format");
  } else validateVaultPassword(raw.password);
  if (action === "rotate") validateVaultPassword(raw.replacement);
  else if (raw.replacement !== "") throw new VaultError("format");
  return {
    id: raw.id,
    action,
    input: raw.input as VaultBytes,
    password: raw.password,
    replacement: raw.replacement,
  };
}

/** Shape guard on a trusted same-origin worker response, not a replacement for its full input validators. */
export function vaultWorkerReview(value: unknown): value is VaultReview {
  const raw = exactMessage(value, [
    "kind",
    "bytes",
    "digest",
    "documents",
    "plan",
  ]);
  if (
    !raw ||
    !["backup", "collection", "merge-plan"].includes(String(raw.kind)) ||
    !Number.isSafeInteger(raw.bytes) ||
    Number(raw.bytes) < 1 ||
    Number(raw.bytes) > COLLECTION_BYTE_LIMIT ||
    typeof raw.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(raw.digest) ||
    !Array.isArray(raw.documents) ||
    raw.documents.length > 20
  )
    return false;
  if (raw.kind === "merge-plan")
    return (
      raw.documents.length === 0 &&
      writingRecord(raw.plan)?.format === "no-wave-writing-merge-plan"
    );
  if (
    raw.plan !== null ||
    !raw.documents.length ||
    (raw.kind === "backup" && raw.documents.length !== 1)
  )
    return false;
  return raw.documents.every((item) => {
    const document = exactMessage(item, ["id", "group", "backup"]);
    const backup = writingRecord(document?.backup),
      draft = writingRecord(backup?.draft);
    return (
      document &&
      /^d(?:[1-9]|1\d|20)$/.test(String(document.id)) &&
      /^w(?:[1-9]|1\d|20)$/.test(String(document.group)) &&
      backup?.format === "no-wave-writing-backup" &&
      backup.version === 1 &&
      typeof draft?.title === "string" &&
      typeof draft.summary === "string"
    );
  });
}
export function vaultWorkerVerification(
  value: unknown,
): value is VaultVerification {
  const raw = exactMessage(value, [
    "kind",
    "documents",
    "decisions",
    "bytes",
    "digest",
  ]);
  if (
    !raw ||
    !Number.isSafeInteger(raw.bytes) ||
    Number(raw.bytes) < 1 ||
    Number(raw.bytes) > COLLECTION_BYTE_LIMIT ||
    !Number.isSafeInteger(raw.documents) ||
    !Number.isSafeInteger(raw.decisions) ||
    typeof raw.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(raw.digest)
  )
    return false;
  if (raw.kind === "backup") return raw.documents === 1 && raw.decisions === 0;
  if (raw.kind === "collection")
    return (
      Number(raw.documents) >= 1 &&
      Number(raw.documents) <= 20 &&
      raw.decisions === 0
    );
  return (
    raw.kind === "merge-plan" &&
    raw.documents === 0 &&
    Number(raw.decisions) >= 0 &&
    Number(raw.decisions) <= 406
  );
}
export function vaultWorkerFailure(value: unknown): VaultError {
  const known: VaultFailureCode[] = [
    "format",
    "size",
    "password",
    "payload",
    "authentication",
    "unavailable",
    "busy",
    "crypto",
    "self-check",
    "stale",
    "read",
    "consent",
    "confirmation",
    "worker",
  ];
  return new VaultError(
    known.includes(value as VaultFailureCode)
      ? (value as VaultFailureCode)
      : "worker",
  );
}

/** Reject protocol drift and hidden payloads before even treating a message as a terminal acknowledgement. */
export function vaultWorkerReply(value: unknown): boolean {
  const raw = writingRecord(value);
  if (raw?.protocol !== VAULT_WORKER_PROTOCOL) return false;
  if (raw.kind === "ready") return !!exactMessage(raw, ["protocol", "kind"]);
  if (!vaultWorkerId(raw.id)) return false;
  if (raw.kind === "stage")
    return (
      !!exactMessage(raw, ["protocol", "kind", "id", "stage"]) &&
      VAULT_WORKER_STAGES.includes(
        raw.stage as (typeof VAULT_WORKER_STAGES)[number],
      )
    );
  if (raw.kind === "cancelled")
    return !!exactMessage(raw, ["protocol", "kind", "id"]);
  if (raw.kind === "failed")
    return (
      !!exactMessage(raw, ["protocol", "kind", "id", "code"]) &&
      vaultWorkerFailure(raw.code).code === raw.code
    );
  if (
    raw.kind !== "complete" ||
    !exactMessage(raw, ["protocol", "kind", "id", "result"])
  )
    return false;
  const result = writingRecord(raw.result);
  if (!result) return false;
  if (Object.hasOwn(result, "verification"))
    return !!exactMessage(result, ["verification"]);
  return result.selfChecked === true
    ? !!exactMessage(result, ["bytes", "review", "selfChecked"])
    : !!exactMessage(result, ["bytes", "review"]);
}

/** The worker has no fetch, storage, FileReader, account, log or network adapter. */
export function installVaultWorker(
  scope: VaultWorkerScope,
  engine: WorkerEngine,
): void {
  let active: { id: number; abort: AbortController } | null = null;
  const send = (
    kind: string,
    id: number,
    fields: Record<string, unknown> = {},
  ) =>
    scope.postMessage({ protocol: VAULT_WORKER_PROTOCOL, kind, id, ...fields });
  async function run(raw: unknown, job: Request): Promise<void> {
    const abort = new AbortController();
    active = { id: job.id, abort };
    const stage = (value: string) => {
      if (!abort.signal.aborted) send("stage", job.id, { stage: value });
    };
    let result: (VaultOpened & { selfChecked?: true }) | null = null;
    let failure: VaultError | null = null;
    let verification: VaultVerification | null = null;
    try {
      if (job.action === "verify") {
        const work = engine.verify(
          job.input,
          job.password,
          abort.signal,
          stage,
        );
        job.password = "";
        const record = writingRecord(raw);
        if (record) record.password = "";
        verification = await work;
      } else {
        const work =
          job.action === "inspect"
            ? engine.inspect(job.input, abort.signal, stage)
            : job.action === "seal"
              ? engine.seal(job.input, job.password, abort.signal, stage)
              : job.action === "rotate"
                ? engine.rotate(
                    job.input,
                    job.password,
                    job.replacement,
                    abort.signal,
                    stage,
                  )
                : engine.open(job.input, job.password, abort.signal, stage);
        job.password = "";
        job.replacement = "";
        const record = writingRecord(raw);
        if (record) {
          record.password = "";
          record.replacement = "";
        }
        result = await work;
      }
    } catch (error) {
      failure = vaultFailure(error);
    } finally {
      wipeVaultMessage(raw);
      job.password = "";
      job.replacement = "";
      if (active?.id === job.id) active = null;
    }
    if (abort.signal.aborted) {
      result?.bytes.fill(0);
      send("cancelled", job.id);
      return;
    }
    if (verification && !failure) {
      send("complete", job.id, { result: { verification } });
      return;
    }
    if (!result || failure) {
      result?.bytes.fill(0);
      send("failed", job.id, { code: failure?.code ?? "crypto" });
      return;
    }
    try {
      scope.postMessage(
        {
          protocol: VAULT_WORKER_PROTOCOL,
          kind: "complete",
          id: job.id,
          result,
        },
        [result.bytes.buffer],
      );
    } catch {
      result.bytes.fill(0);
      send("failed", job.id, { code: "worker" });
    }
  }
  scope.addEventListener("message", (event) => {
    if (!(event instanceof MessageEvent)) return;
    const raw = writingRecord(event.data);
    if (raw?.protocol !== VAULT_WORKER_PROTOCOL) {
      wipeVaultMessage(event.data);
      return;
    }
    if (raw.kind === "cancel") {
      const live = active;
      if (
        exactMessage(raw, ["protocol", "kind", "id"]) &&
        live &&
        vaultWorkerId(raw.id) &&
        live.id === raw.id
      )
        live.abort.abort();
      return;
    }
    let job: Request;
    try {
      job = request(raw);
    } catch (error) {
      wipeVaultMessage(raw);
      if (vaultWorkerId(raw.id))
        send("failed", raw.id, { code: vaultFailure(error).code });
      return;
    }
    if (active) {
      wipeVaultMessage(raw);
      send("failed", job.id, { code: "busy" });
      return;
    }
    // Rejections are channel failures only; never echo an exception or retry a secret-bearing job.
    void run(raw, job).catch(() => send("failed", job.id, { code: "worker" }));
  });
  scope.postMessage({ protocol: VAULT_WORKER_PROTOCOL, kind: "ready" });
}
