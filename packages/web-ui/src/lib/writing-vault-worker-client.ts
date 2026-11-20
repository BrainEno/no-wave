import { writingRecord } from "./writing-document.ts";
import { COLLECTION_BYTE_LIMIT } from "./writing-collection.ts";
import {
  validateVaultPassword,
  type VaultCryptoStage,
  type VaultOpened,
  type VaultSealed,
} from "./writing-vault-crypto.ts";
import {
  parseVaultEnvelope,
  VAULT_FILE_LIMIT,
  VaultError,
  vaultActive,
  vaultSize,
  type VaultBytes,
} from "./writing-vault-format.ts";
import {
  VAULT_WORKER_PROTOCOL,
  VAULT_WORKER_STAGES,
  vaultWorkerFailure,
  vaultWorkerReview,
  vaultWorkerVerification,
  vaultWorkerReply,
  wipeVaultMessage,
  type VaultWorkerAction,
  type VaultWorkerPort,
} from "./writing-vault-worker-protocol.ts";

import type { VaultVerification } from "./writing-vault-payload.ts";
type Status = "cold" | "starting" | "idle" | "busy" | "failed";
type Completed = VaultOpened & { selfChecked?: true };
type Reply = Completed | { verification: VaultVerification };
function wipeReply(result?: Reply) {
  if (result && "bytes" in result) result.bytes.fill(0);
}
type Progress = (stage: VaultCryptoStage) => void;
type Pending = {
  id: number;
  action: VaultWorkerAction;
  signal: AbortSignal;
  started: boolean;
  resolve: (result: Reply) => void;
  reject: (error: Error) => void;
  progress: Progress;
  abort: () => void;
};
type Options = {
  create?: () => VaultWorkerPort;
  later?: (
    work: () => void,
    milliseconds: number,
  ) => ReturnType<typeof setTimeout>;
  cancelTimer?: (timer: ReturnType<typeof setTimeout>) => void;
};

/** One same-origin dedicated worker, one live job, zero queue, no automatic restart/replay/fallback. */
export class WritingVaultWorkerClient {
  private status: Status = "cold";
  private worker: VaultWorkerPort | null = null;
  private pending: Pending | null = null;
  private listeners = new Set<() => void>();
  private serial = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private detach: (() => void) | null = null;
  private options: Required<Options>;
  constructor(options: Options = {}) {
    this.options = {
      create:
        options.create ??
        (() =>
          new Worker(new URL("./writing-vault-worker.ts", import.meta.url), {
            type: "module",
            name: "no-wave-local-writing-vault",
          })),
      later:
        options.later ??
        ((work, milliseconds) => setTimeout(work, milliseconds)),
      cancelTimer: options.cancelTimer ?? ((timer) => clearTimeout(timer)),
    };
  }
  getSnapshot = (): Status => this.status;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(status: Status): void {
    this.status = status;
    for (const listener of this.listeners) listener();
  }
  private clearTimer(): void {
    if (this.timer !== null) this.options.cancelTimer(this.timer);
    this.timer = null;
  }
  warm(): void {
    if (this.status !== "cold") return;
    this.publish("starting");
    if (this.getSnapshot() !== "starting") return;
    try {
      const worker = this.options.create();
      this.worker = worker;
      const message = (event: Event) => {
        if (!(event instanceof MessageEvent)) return;
        if (this.worker !== worker) {
          wipeVaultMessage(event.data);
          return;
        }
        this.message(event.data);
      };
      const failed = () => {
        if (this.worker === worker) this.fault();
      };
      worker.addEventListener("message", message);
      worker.addEventListener("error", failed);
      worker.addEventListener("messageerror", failed);
      this.detach = () => {
        worker.removeEventListener("message", message);
        worker.removeEventListener("error", failed);
        worker.removeEventListener("messageerror", failed);
      };
      this.timer = this.options.later(() => {
        if (this.worker === worker && this.status === "starting") this.fault();
      }, 10000);
    } catch {
      this.fault();
    }
  }
  private fault(): void {
    const pending = this.pending;
    this.pending = null;
    this.clearTimer();
    this.detach?.();
    this.detach = null;
    const worker = this.worker;
    this.worker = null;
    worker?.terminate();
    pending?.signal.removeEventListener("abort", pending.abort);
    this.publish("failed");
    pending?.reject(
      pending.signal.aborted
        ? new DOMException("操作已取消。", "AbortError")
        : new VaultError("worker"),
    );
  }
  dispose(): void {
    this.fault();
  }
  private finish(pending: Pending, error: Error | null, result?: Reply): void {
    if (this.pending !== pending) {
      wipeReply(result);
      return;
    }
    this.pending = null;
    this.clearTimer();
    pending.signal.removeEventListener("abort", pending.abort);
    // Publish the vacant slot only after removing every old terminal/abort fence.
    this.publish("idle");
    if (pending.signal.aborted) {
      wipeReply(result);
      pending.reject(new DOMException("操作已取消。", "AbortError"));
    } else if (error || !result) {
      wipeReply(result);
      pending.reject(error ?? new VaultError("worker"));
    } else pending.resolve(result);
  }
  private message(value: unknown): void {
    const raw = writingRecord(value);
    if (!raw || !vaultWorkerReply(raw)) {
      wipeVaultMessage(value);
      if (this.pending || this.status === "starting") this.fault();
      return;
    }
    if (
      this.status === "starting" &&
      raw.kind === "ready" &&
      Object.keys(raw).length === 2
    ) {
      this.clearTimer();
      this.publish("idle");
      return;
    }
    const pending = this.pending;
    if (!pending || raw.id !== pending.id) {
      wipeVaultMessage(value);
      return;
    }
    if (
      raw.kind === "stage" &&
      VAULT_WORKER_STAGES.includes(raw.stage as VaultCryptoStage)
    ) {
      if (!pending.signal.aborted) {
        try {
          pending.progress(raw.stage as VaultCryptoStage);
        } catch {
          this.fault();
        }
      }
      return;
    }
    if (pending.signal.aborted) {
      wipeVaultMessage(value);
      // Stage messages are not acknowledgements of unabortable native work finishing.
      if (
        raw.kind === "complete" ||
        raw.kind === "failed" ||
        raw.kind === "cancelled"
      )
        this.finish(pending, new DOMException("操作已取消。", "AbortError"));
      return;
    }
    if (raw.kind === "failed") {
      const error = vaultWorkerFailure(raw.code);
      if (error.code === "worker" || error.code === "busy") this.fault();
      else this.finish(pending, error);
      return;
    }
    if (raw.kind !== "complete") {
      wipeVaultMessage(value);
      this.fault();
      return;
    }
    const result = writingRecord(raw.result);
    if (pending.action === "verify") {
      if (
        result &&
        Object.keys(result).length === 1 &&
        vaultWorkerVerification(result.verification)
      )
        this.finish(pending, null, { verification: result.verification });
      else {
        wipeVaultMessage(value);
        this.fault();
      }
      return;
    }
    try {
      if (
        !result ||
        !(result.bytes instanceof Uint8Array) ||
        !(result.bytes.buffer instanceof ArrayBuffer) ||
        result.bytes.byteOffset !== 0 ||
        result.bytes.byteLength !== result.bytes.buffer.byteLength ||
        !vaultWorkerReview(result.review)
      )
        throw new VaultError("worker");
      vaultSize(result.bytes.byteLength, VAULT_FILE_LIMIT);
      if (pending.action === "seal" || pending.action === "rotate") {
        const envelope = parseVaultEnvelope(result.bytes as VaultBytes);
        if (
          result.selfChecked !== true ||
          envelope.header.plaintextBytes !== result.review.bytes
        )
          throw new VaultError("worker");
      } else if (result.bytes.byteLength !== result.review.bytes)
        throw new VaultError("worker");
      this.finish(pending, null, {
        bytes: result.bytes as VaultBytes,
        review: result.review,
        ...(result.selfChecked === true ? { selfChecked: true as const } : {}),
      });
    } catch {
      wipeVaultMessage(value);
      this.fault();
    }
  }
  private async execute(
    action: VaultWorkerAction,
    input: VaultBytes,
    password: string,
    replacement: string,
    signal: AbortSignal,
    progress: Progress,
  ): Promise<Reply> {
    vaultActive(signal);
    if (this.status === "cold") this.warm();
    if (this.status === "failed") throw new VaultError("worker");
    if (this.status !== "idle" || !this.worker || this.pending)
      throw new VaultError("busy");
    vaultSize(
      input.byteLength,
      action === "inspect" || action === "seal"
        ? COLLECTION_BYTE_LIMIT
        : VAULT_FILE_LIMIT,
    );
    if (action !== "inspect") validateVaultPassword(password);
    if (action === "rotate") validateVaultPassword(replacement);
    if (action === "open" || action === "rotate" || action === "verify")
      parseVaultEnvelope(input);
    if (!Number.isSafeInteger(this.serial + 1)) {
      this.fault();
      throw new VaultError("worker");
    }
    const owned = input.slice();
    return new Promise<Reply>((resolve, reject) => {
      const pending: Pending = {
        id: ++this.serial,
        action,
        signal,
        started: false,
        resolve,
        reject,
        progress,
        abort: () => {
          if (this.pending !== pending) return;
          if (!pending.started) {
            this.finish(
              pending,
              new DOMException("操作已取消。", "AbortError"),
            );
            return;
          }
          try {
            this.worker?.postMessage(
              {
                protocol: VAULT_WORKER_PROTOCOL,
                kind: "cancel",
                id: pending.id,
              },
              [],
            );
          } catch {
            this.fault();
          }
        },
      };
      this.pending = pending;
      signal.addEventListener("abort", pending.abort, { once: true });
      this.publish("busy");
      const message = {
        protocol: VAULT_WORKER_PROTOCOL,
        kind: "run",
        id: pending.id,
        action,
        input: owned,
        password,
        replacement,
      };
      try {
        if (this.pending !== pending || signal.aborted || !this.worker) return;
        this.timer = this.options.later(() => {
          if (this.pending === pending) this.fault();
        }, 120000);
        pending.started = true;
        this.worker.postMessage(message, [owned.buffer]);
      } catch {
        this.fault();
      } finally {
        // A real transfer detaches it; test/custom ports may leave an owned view to wipe.
        if (owned.buffer.byteLength) owned.fill(0);
        message.password = "";
        message.replacement = "";
        password = "";
        replacement = "";
      }
    });
  }
  private payload(result: Reply): Completed {
    if ("verification" in result) {
      this.fault();
      throw new VaultError("worker");
    }
    return result;
  }
  async verify(
    input: VaultBytes,
    password: string,
    signal: AbortSignal,
    progress: Progress = () => {},
  ): Promise<VaultVerification> {
    const result = await this.execute(
      "verify",
      input,
      password,
      "",
      signal,
      progress,
    );
    if (!("verification" in result)) {
      wipeReply(result);
      this.fault();
      throw new VaultError("worker");
    }
    return result.verification;
  }
  async inspect(
    input: VaultBytes,
    signal: AbortSignal,
    progress: Progress = () => {},
  ): Promise<VaultOpened> {
    return this.payload(
      await this.execute("inspect", input, "", "", signal, progress),
    );
  }
  async seal(
    input: VaultBytes,
    password: string,
    signal: AbortSignal,
    progress: Progress = () => {},
  ): Promise<VaultSealed> {
    const result = await this.execute(
      "seal",
      input,
      password,
      "",
      signal,
      progress,
    );
    return { ...this.payload(result), selfChecked: true };
  }
  async open(
    input: VaultBytes,
    password: string,
    signal: AbortSignal,
    progress: Progress = () => {},
  ): Promise<VaultOpened> {
    return this.payload(
      await this.execute("open", input, password, "", signal, progress),
    );
  }
  async rotate(
    input: VaultBytes,
    password: string,
    replacement: string,
    signal: AbortSignal,
    progress: Progress = () => {},
  ): Promise<VaultSealed> {
    const result = await this.execute(
      "rotate",
      input,
      password,
      replacement,
      signal,
      progress,
    );
    return { ...this.payload(result), selfChecked: true };
  }
}
export const writingVaultWorker = new WritingVaultWorkerClient();
