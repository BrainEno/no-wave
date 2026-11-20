import { readVaultLocalFile } from "./writing-vault-local-file.ts";
import { type LocalBinaryArtifact } from "./writing-collection-browser.ts";
import { COLLECTION_BYTE_LIMIT } from "./writing-collection.ts";
import {
  writingVaultCryptography,
  validateVaultPassword,
  type VaultCryptoStage,
  type VaultOpened,
  type WritingVaultCryptography,
} from "./writing-vault-crypto.ts";
import {
  isVaultEnvelope,
  parseVaultEnvelope,
  VAULT_FILE_LIMIT,
  VaultError,
  vaultFailure,
  vaultSize,
  type VaultBytes,
} from "./writing-vault-format.ts";
import {
  digestVaultBytes,
  inspectVaultPayload,
  type VaultReview,
  type VaultVerification,
} from "./writing-vault-payload.ts";
import {
  compareVaultReadback,
  type VaultReadback,
} from "./writing-vault-readback.ts";

export type VaultResult = {
  serial: number;
  kind: "sealed" | "plain";
  bytes: number;
  digest: string;
  name: string;
  mime: string;
};
type Source = {
  serial: number;
  kind: "plain" | "locked";
  name: string;
  bytes: number;
};
type Readback = {
  status: "idle" | "reading" | "comparing" | "complete" | "cancelled";
  percent: number;
  report: VaultReadback | null;
  error: VaultError | null;
};
export type WritingVaultState = {
  revision: number;
  phase:
    | "idle"
    | "ready"
    | "working"
    | "sealed"
    | "unlocked"
    | "verified"
    | "cancelled"
    | "failed";
  source: Source | null;
  loading: boolean;
  percent: number;
  stage: VaultCryptoStage | null;
  review: VaultReview | null;
  result: VaultResult | null;
  verified: VaultVerification | null;
  confirmed: boolean;
  readback: Readback;
  error: VaultError | null;
};
type Reader = (
  file: File,
  signal: AbortSignal,
  progress: (percent: number) => void,
) => Promise<VaultBytes>;
import {
  vaultTextPage,
  searchVaultText,
  type VaultTextPage,
  type VaultTextSearch,
} from "./writing-vault-preview.ts";

type Options = {
  read?: Reader;
  crypto?: Pick<WritingVaultCryptography, "seal" | "open" | "verify"> &
    Partial<Pick<WritingVaultCryptography, "rotate">>;
  inspect?: (bytes: VaultBytes, signal: AbortSignal) => Promise<VaultReview>;
  compare?: typeof compareVaultReadback;
  search?: typeof searchVaultText;
};
const emptyReadback = (): Readback => ({
  status: "idle",
  percent: 0,
  report: null,
  error: null,
});
const emptyState = (): WritingVaultState => ({
  revision: 0,
  phase: "idle",
  source: null,
  loading: false,
  percent: 0,
  stage: null,
  review: null,
  result: null,
  verified: null,
  confirmed: false,
  readback: emptyReadback(),
  error: null,
});
function percent(value: number): number {
  return Number.isFinite(value)
    ? Math.max(0, Math.min(100, Math.floor(value)))
    : 0;
}

/** Owns explicit local files, never a password, key, account, request or automatic persistence. */
export class WritingVaultWorkbench {
  private state = emptyState();
  private listeners = new Set<() => void>();
  private sourceBytes: VaultBytes | null = null;
  private sourceReview: VaultReview | null = null;
  private outputBytes: VaultBytes | null = null;
  private reading: AbortController | null = null;
  private operation: AbortController | null = null;
  private readback: AbortController | null = null;
  private serial = 0;
  private previewing: AbortController | null = null;
  private options: Required<Options>;
  constructor(options: Options = {}) {
    this.options = {
      read: options.read ?? readVaultLocalFile,
      crypto: options.crypto ?? writingVaultCryptography,
      compare: options.compare ?? compareVaultReadback,
      search: options.search ?? searchVaultText,
      inspect: options.inspect ?? inspectVaultPayload,
    };
  }
  getSnapshot = (): WritingVaultState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(patch: Partial<WritingVaultState>): void {
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener();
  }
  private cancelReadbackWork(): void {
    this.readback?.abort();
    this.readback = null;
  }
  private discardOutput(): void {
    this.cancelPreviewSearch();
    this.cancelReadbackWork();
    this.outputBytes?.fill(0);
    this.outputBytes = null;
  }
  private derivedReset(): Partial<WritingVaultState> {
    this.discardOutput();
    return {
      result: null,
      confirmed: false,
      verified: null,
      readback: emptyReadback(),
      stage: null,
      error: null,
    };
  }
  clear(): void {
    this.reading?.abort();
    this.reading = null;
    this.operation?.abort();
    this.operation = null;
    this.discardOutput();
    this.sourceBytes?.fill(0);
    this.sourceBytes = null;
    this.sourceReview = null;
    this.publish(emptyState());
  }
  cancel(): void {
    this.reading?.abort();
    this.reading = null;
    this.operation?.abort();
    this.operation = null;
    this.publish({
      ...this.derivedReset(),
      loading: false,
      phase: "cancelled",
      review: this.sourceReview,
    });
  }
  credentialsChanged(): void {
    this.cancel();
    this.publish({ phase: this.state.source ? "ready" : "idle", error: null });
  }
  lock(): void {
    if (this.state.source?.kind !== "locked") {
      this.clear();
      return;
    }
    this.cancel();
    this.publish({ phase: "ready", review: null });
  }
  async load(file: File): Promise<void> {
    this.clear();
    try {
      vaultSize(file.size, VAULT_FILE_LIMIT);
    } catch {
      this.publish({ phase: "failed", error: new VaultError("size") });
      return;
    }
    const abort = new AbortController();
    this.reading = abort;
    const current = () => this.reading === abort && !abort.signal.aborted;
    this.publish({ loading: true, phase: "idle", percent: 0 });
    let bytes: VaultBytes | null = null,
      retained = false;
    try {
      if (!current()) return;
      try {
        bytes = await this.options.read(file, abort.signal, (value) => {
          if (current()) this.publish({ percent: percent(value) });
        });
      } catch (error) {
        throw error instanceof VaultError ? error : new VaultError("read");
      }
      if (!current()) return;
      if (bytes.byteLength !== file.size) throw new VaultError("read");
      let kind: Source["kind"],
        review: VaultReview | null = null;
      if (isVaultEnvelope(bytes)) {
        parseVaultEnvelope(bytes);
        kind = "locked";
      } else {
        review = await this.options.inspect(bytes, abort.signal);
        kind = "plain";
      }
      if (!current()) return;
      const name = Array.from(
        file.name.replace(
          /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,
          "",
        ),
      )
        .slice(0, 240)
        .join("");
      this.sourceBytes = bytes;
      this.sourceReview = review;
      retained = true;
      this.publish({
        source: { serial: ++this.serial, kind, name, bytes: bytes.byteLength },
        phase: "ready",
        loading: false,
        percent: 100,
        review,
        error: null,
      });
    } catch (error) {
      if (current())
        this.publish({
          phase: "failed",
          loading: false,
          error: vaultFailure(error),
          source: null,
          review: null,
        });
    } finally {
      if (!retained) bytes?.fill(0);
      if (this.reading === abort) this.reading = null;
    }
  }
  async seal(
    password: string,
    confirmation: string,
    consented: boolean,
  ): Promise<void> {
    try {
      validateVaultPassword(password);
      if (password !== confirmation) throw new VaultError("confirmation");
      if (consented !== true) throw new VaultError("consent");
    } catch (error) {
      this.cancel();
      this.publish({ error: vaultFailure(error) });
      return;
    }
    // The strings are only passed to the active operation, never to a published state.
    await this.transform("seal", password);
  }
  async unlock(password: string): Promise<void> {
    await this.transform("unlock", password);
  }
  async verify(password: string): Promise<void> {
    await this.transform("verify", password);
  }
  async rotate(
    password: string,
    replacement: string,
    confirmation: string,
    consented: boolean,
  ): Promise<void> {
    try {
      validateVaultPassword(password);
      validateVaultPassword(replacement);
      if (replacement !== confirmation || replacement === password)
        throw new VaultError("confirmation");
      if (consented !== true) throw new VaultError("consent");
    } catch (error) {
      this.cancel();
      this.publish({ error: vaultFailure(error) });
      return;
    }
    await this.transform("rotate", password, replacement);
  }
  private async transform(
    action: "seal" | "unlock" | "verify" | "rotate",
    password: string,
    replacement = "",
  ): Promise<void> {
    const source = this.sourceBytes;
    const expectedKind = action === "seal" ? "plain" : "locked";
    const sealing = action === "seal" || action === "rotate";
    if (
      !source ||
      this.state.loading ||
      this.state.source?.kind !== expectedKind
    ) {
      this.publish({ error: new VaultError("stale") });
      return;
    }
    this.operation?.abort();
    const abort = new AbortController();
    this.operation = abort;
    const current = () =>
      this.operation === abort &&
      !abort.signal.aborted &&
      this.sourceBytes === source;
    this.publish({
      ...this.derivedReset(),
      phase: "working",
      review: action === "seal" ? this.sourceReview : null,
    });
    let prepared: VaultOpened | null = null,
      retained = false;
    try {
      if (!current()) return;
      const stage = (value: VaultCryptoStage) => {
        if (current()) this.publish({ stage: value });
      };
      if (action === "verify") {
        const work = this.options.crypto.verify(
          source,
          password,
          abort.signal,
          stage,
        );
        password = "";
        const verified = await work;
        if (!current()) return;
        this.operation = null;
        this.publish({
          phase: "verified",
          verified,
          stage: null,
          review: null,
        });
        return;
      }
      const work =
        action === "seal"
          ? this.options.crypto.seal(source, password, abort.signal, stage)
          : action === "rotate"
            ? (this.options.crypto.rotate?.(
                source,
                password,
                replacement,
                abort.signal,
                stage,
              ) ?? Promise.reject(new VaultError("unavailable")))
            : this.options.crypto.open(source, password, abort.signal, stage);
      password = "";
      replacement = "";
      prepared = await work;
      if (!current()) return;
      const digest = sealing
        ? await digestVaultBytes(prepared.bytes, abort.signal)
        : prepared.review.digest;
      if (!current()) return;
      const kind = sealing ? "sealed" : "plain";
      const name =
        kind === "sealed"
          ? "no-wave-encrypted-writing-v1.nwvault"
          : `no-wave-decrypted-${prepared.review.kind}.json`;
      const result: VaultResult = {
        serial: ++this.serial,
        kind,
        bytes: prepared.bytes.length,
        digest,
        name,
        mime:
          kind === "sealed"
            ? "application/octet-stream"
            : "application/json;charset=utf-8",
      };
      this.outputBytes = prepared.bytes;
      retained = true;
      if (sealing) {
        this.sourceBytes?.fill(0);
        this.sourceBytes = null;
        this.sourceReview = null;
      }
      // Remove the operation fence before publishing a completed result: a listener may lock it immediately.
      this.operation = null;
      this.publish({
        phase: sealing ? "sealed" : "unlocked",
        result,
        source: sealing ? null : this.state.source,
        review: sealing ? null : prepared.review,
        stage: null,
        error: null,
      });
    } catch (error) {
      if (current())
        this.publish({
          phase: "failed",
          stage: null,
          error: vaultFailure(error),
          result: null,
          confirmed: false,
          review: this.sourceReview,
        });
    } finally {
      password = "";
      replacement = "";
      if (!retained) prepared?.bytes.fill(0);
      if (this.operation === abort) this.operation = null;
    }
  }
  private previewBytes(expected: VaultReview): VaultBytes {
    if (this.state.review !== expected || this.operation || this.state.loading)
      throw new VaultError("stale");
    const bytes =
      this.state.source?.kind === "plain" ? this.sourceBytes : this.outputBytes;
    if (!bytes || bytes.length !== expected.bytes)
      throw new VaultError("stale");
    return bytes;
  }
  previewPage(
    expected: VaultReview,
    anchor: number,
    direction: "forward" | "backward" = "forward",
  ): VaultTextPage {
    return vaultTextPage(this.previewBytes(expected), anchor, direction);
  }
  cancelPreviewSearch(): void {
    this.previewing?.abort();
    this.previewing = null;
  }
  async searchPreview(
    expected: VaultReview,
    query: string,
    from: number,
  ): Promise<VaultTextSearch> {
    this.cancelPreviewSearch();
    const bytes = this.previewBytes(expected),
      abort = new AbortController();
    this.previewing = abort;
    try {
      const result = await this.options.search(
        bytes,
        query,
        from,
        abort.signal,
      );
      if (this.previewing !== abort || abort.signal.aborted)
        throw new DOMException("原始文字检索已取消。", "AbortError");
      if (this.previewBytes(expected) !== bytes) throw new VaultError("stale");
      return result;
    } finally {
      if (this.previewing === abort) this.previewing = null;
    }
  }
  confirmResult(expected: VaultResult | null, confirmed: boolean): void {
    if (
      !expected ||
      this.state.result !== expected ||
      !this.outputBytes ||
      this.operation ||
      this.state.loading
    ) {
      this.publish({ error: new VaultError("stale") });
      return;
    }
    this.publish({ confirmed: confirmed === true, error: null });
  }
  permits(expected: VaultResult | null): boolean {
    return (
      expected !== null &&
      this.state.result === expected &&
      this.outputBytes !== null &&
      this.state.confirmed &&
      !this.operation &&
      !this.state.loading
    );
  }
  artifact(expected: VaultResult | null): LocalBinaryArtifact {
    if (!this.permits(expected) || !expected || !this.outputBytes)
      throw new VaultError("stale");
    return {
      bytes: this.outputBytes.slice(),
      name: expected.name,
      mime: expected.mime,
    };
  }
  cancelReadback(): void {
    this.cancelReadbackWork();
    this.publish({ readback: { ...emptyReadback(), status: "cancelled" } });
  }
  async verifyDownloaded(
    file: File,
    expected: VaultResult | null,
  ): Promise<void> {
    this.cancelReadbackWork();
    if (
      !expected ||
      this.state.result !== expected ||
      !this.outputBytes ||
      this.operation
    ) {
      this.publish({
        readback: { ...emptyReadback(), error: new VaultError("stale") },
      });
      return;
    }
    const abort = new AbortController();
    this.readback = abort;
    const current = () =>
      this.readback === abort &&
      !abort.signal.aborted &&
      this.state.result === expected &&
      this.outputBytes !== null;
    this.publish({ readback: { ...emptyReadback(), status: "reading" } });
    let bytes: VaultBytes | null = null;
    try {
      if (!current()) return;
      vaultSize(
        file.size,
        expected.kind === "sealed" ? VAULT_FILE_LIMIT : COLLECTION_BYTE_LIMIT,
      );
      try {
        bytes = await this.options.read(file, abort.signal, (value) => {
          if (current())
            this.publish({
              readback: { ...this.state.readback, percent: percent(value) },
            });
        });
      } catch {
        throw new VaultError("read");
      }
      if (!current()) return;
      if (bytes.byteLength !== file.size) throw new VaultError("read");
      this.publish({ readback: { ...emptyReadback(), status: "comparing" } });
      if (!current() || !this.outputBytes) return;
      const report = await this.options.compare(
        this.outputBytes,
        bytes,
        abort.signal,
        (value) => {
          if (current())
            this.publish({
              readback: { ...this.state.readback, percent: percent(value) },
            });
        },
      );
      if (!current()) return;
      this.publish({
        readback: { status: "complete", percent: 100, report, error: null },
      });
    } catch (error) {
      if (current())
        this.publish({
          readback: { ...emptyReadback(), error: vaultFailure(error) },
        });
    } finally {
      bytes?.fill(0);
      if (this.readback === abort) this.readback = null;
    }
  }
}
