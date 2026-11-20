import { COLLECTION_BYTE_LIMIT } from "./writing-collection.ts";
import type { CollectionArtifact } from "./writing-collection-index.ts";

export async function readLocalFileBytes(file: Blob, signal: AbortSignal, progress: (percent: number) => void = () => {}, makeReader: () => FileReader = () => new FileReader(), limit = COLLECTION_BYTE_LIMIT): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 17 * 1024 * 1024 || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > limit) throw new Error("请选择大于 0 且不超过 16 MiB 的 UTF-8 JSON 文件。");
  if (signal.aborted) throw new DOMException("读取已取消。", "AbortError");
  return new Promise((resolve, reject) => {
    const reader = makeReader();
    let settled = false;
    const clean = () => {
      reader.onload = null; reader.onerror = null; reader.onabort = null; reader.onprogress = null;
      signal.removeEventListener("abort", abort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true; clean(); reject(error);
    };
    const abort = () => { fail(new DOMException("读取已取消。", "AbortError")); reader.abort(); };
    reader.onerror = () => fail(new Error("本机文件读取失败，请重新选择；没有上传文件。"));
    reader.onabort = () => fail(new DOMException("读取已取消。", "AbortError"));
    reader.onprogress = event => { if (!settled) progress(Math.max(0, Math.min(100, Math.floor(event.loaded / file.size * 100)))); };
    reader.onload = () => {
      if (settled || signal.aborted) return;
      if (!(reader.result instanceof ArrayBuffer)) { fail(new Error("文件读取结果无效。")); return; }
      if (reader.result.byteLength !== file.size) { fail(new Error("读取字节数与选中文件大小不符，文件可能已变化或截断，请重新选择。")); return; }
      settled = true; clean(); resolve(new Uint8Array(reader.result));
    };
    signal.addEventListener("abort", abort, { once: true });
    try { reader.readAsArrayBuffer(file); } catch { fail(new Error("无法启动本机文件读取。")); }
  });
}

/** JSON callers retain fatal UTF-8 and their original BOM behavior; binary callers never decode. */
export async function readCollectionFile(file: File, signal: AbortSignal, progress: (percent: number) => void = () => {}, makeReader: () => FileReader = () => new FileReader()): Promise<string> {
  const bytes = await readLocalFileBytes(file, signal, progress, makeReader);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("文件不是有效 UTF-8 JSON；没有以替换字符悄悄修复原文。"); }
  finally { bytes.fill(0); }
}
export type LocalBinaryArtifact = { bytes: Uint8Array<ArrayBuffer>; name: string; mime: string };

type DownloadEnvironment = {
  create(blob: Blob): string; revoke(url: string): void; deliver(url: string, name: string): void;
  later(work: () => void): ReturnType<typeof setTimeout>; cancel(timer: ReturnType<typeof setTimeout>): void;
};
const browserDownload: DownloadEnvironment = {
  create: blob => URL.createObjectURL(blob), revoke: url => URL.revokeObjectURL(url),
  deliver: (url, name) => {
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = name;
    document.body.append(anchor);
    try { anchor.click(); } finally { anchor.remove(); }
  },
  later: work => setTimeout(work, 1000), cancel: timer => clearTimeout(timer),
};

/** A live intent check happens again after allocating the URL, including in failure paths. */
export class CollectionDownloadLease {
  private environment: DownloadEnvironment;
  private url: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(environment: DownloadEnvironment = browserDownload) { this.environment = environment; }
  release() {
    if (this.timer !== null) this.environment.cancel(this.timer);
    if (this.url !== null) this.environment.revoke(this.url);
    this.timer = null; this.url = null;
  }
  download(artifact: CollectionArtifact, permitted: () => boolean): void {
    if (!permitted()) throw new Error("下载意图已变化，没有生成旧文件。");
    this.downloadBytes({ ...artifact, bytes: new TextEncoder().encode(artifact.text) }, permitted);
  }
  downloadBytes(artifact: LocalBinaryArtifact, permitted: () => boolean): void {
    if (!permitted()) throw new Error("下载意图已变化，没有生成旧文件。");
    const extension = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}\.(json|txt|md|csv|nwvault)$/.exec(artifact.name)?.[1];
    const types: Record<string, string> = { json: "application/json;charset=utf-8", txt: "text/plain;charset=utf-8", md: "text/plain;charset=utf-8", csv: "text/csv;charset=utf-8", nwvault: "application/octet-stream" };
    if (!extension || types[extension] !== artifact.mime) throw new Error("下载文件名或类型无效。");
    const limit = extension === "nwvault" ? 17 * 1024 * 1024 : COLLECTION_BYTE_LIMIT;
    if (!artifact.bytes.byteLength || artifact.bytes.byteLength > limit) throw new Error("下载文件为空或超过本机文件预算。");
    const bytes = artifact.bytes;
    this.release();
    try {
      this.url = this.environment.create(new Blob([bytes], { type: artifact.mime }));
      if (!permitted()) throw new Error("文件、选择或账户已变化，没有下载旧内容。");
      this.environment.deliver(this.url, artifact.name);
      this.timer = this.environment.later(() => this.release());
    } catch (error) {
      this.release();
      throw error instanceof Error ? error : new Error("生成本机下载失败。");
    }
  }
}

/** Files are user input, not an account credential; BFCache must never restore their private DOM. */
export function bindCollectionPrivacy(window: EventTarget, clear: () => void, flush: (work: () => void) => void): () => void {
  const hide = () => flush(clear);
  const show = (event: Event) => { if ("persisted" in event && event.persisted === true) flush(clear); };
  window.addEventListener("pagehide", hide);
  window.addEventListener("pageshow", show);
  return () => { window.removeEventListener("pagehide", hide); window.removeEventListener("pageshow", show); };
}
