import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { CollectionDownloadLease, bindCollectionPrivacy, readCollectionFile } from "./writing-collection-browser.ts";

class Reader {
  result: ArrayBuffer | null = null;
  onload: FileReader["onload"] = null;
  onabort: FileReader["onabort"] = null;
  onerror: FileReader["onerror"] = null;
  onprogress: FileReader["onprogress"] = null;
  started = 0; aborted = 0;
  readAsArrayBuffer() { this.started++; }
  abort() { this.aborted++; }
  finish(bytes: number[]) { this.result = new Uint8Array(bytes).buffer; this.onload?.call(this as unknown as FileReader, new Event("load") as ProgressEvent<FileReader>); }
}

test("native local reads use strict UTF-8, reject oversize before I/O and detach late events after abort", async () => {
  const reader = new Reader(), abort = new AbortController();
  const result = readCollectionFile(new File(["{}"], "valid.json"), abort.signal, () => {}, () => reader as unknown as FileReader);
  reader.finish([123, 125]); assert.equal(await result, "{}");
  assert.equal(reader.onload, null);
  const invalid = new Reader(); const bad = readCollectionFile(new File(["xx"], "bad.json"), new AbortController().signal, () => {}, () => invalid as unknown as FileReader);
  invalid.finish([0xc3, 0x28]); await assert.rejects(bad, /UTF-8/);
  const late = new Reader(), stop = new AbortController();
  const pending = readCollectionFile(new File(["{}"], "late.json"), stop.signal, () => {}, () => late as unknown as FileReader);
  stop.abort(); await assert.rejects(pending, { name: "AbortError" });
  late.finish([123, 125]); assert.equal(late.aborted, 1); assert.equal(late.onload, null);
  await assert.rejects(readCollectionFile(new File([], "empty.json"), new AbortController().signal));
});

test("a download lease checks intent after URL allocation too, releases previous/failed URLs and reclaims the final URL", async () => {
  const revoked: string[] = [], delivered: string[] = []; let created = 0, permit = true;
  const environment = { create: () => `blob:local/${++created}`, revoke: (url: string) => { revoked.push(url); }, deliver: (url: string) => { delivered.push(url); }, later: (work: () => void) => setTimeout(work, 10), cancel: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer) };
  const artifact = { text: "{}", name: "collection.json", mime: "application/json;charset=utf-8" };
  const lease = new CollectionDownloadLease(environment);
  lease.download(artifact, () => permit); lease.download(artifact, () => permit);
  assert.deepEqual(revoked, ["blob:local/1"]);
  await new Promise(resolve => setTimeout(resolve, 25)); assert.deepEqual(revoked, ["blob:local/1", "blob:local/2"]);
  const stale = new CollectionDownloadLease({ ...environment, create: () => { permit = false; return "blob:stale"; } });
  assert.throws(() => stale.download(artifact, () => permit), /变化/);
  assert.equal(revoked.at(-1), "blob:stale"); assert.equal(delivered.length, 2);
  const failed = new CollectionDownloadLease({ ...environment, deliver: () => { throw new Error("download unavailable"); } });
  permit = true; assert.throws(() => failed.download(artifact, () => true));
  assert.equal(revoked.at(-1), `blob:local/${created}`);
  assert.throws(() => lease.download({ ...artifact, name: "../unsafe.json" }, () => true));
});

test("private local file DOM is flushed away on pagehide and persisted pageshow, never automatically reloaded", () => {
  const window = new EventTarget(), calls: string[] = [];
  const release = bindCollectionPrivacy(window, () => calls.push("clear"), action => { calls.push("flush"); action(); });
  window.dispatchEvent(new Event("pageshow")); assert.deepEqual(calls, []);
  window.dispatchEvent(new Event("pagehide")); assert.deepEqual(calls, ["flush", "clear"]);
  const restored = new Event("pageshow"); Object.defineProperty(restored, "persisted", { value: true });
  window.dispatchEvent(restored); assert.deepEqual(calls, ["flush", "clear", "flush", "clear"]);
  release(); window.dispatchEvent(new Event("pagehide")); assert.equal(calls.length, 4);
});

test("portable manuscript names handle long separator runs without polynomial suffix backtracking", () => {
  const module = new URL("./writing-backup.ts", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { writingDownloadName } from ${JSON.stringify(module)};
    const name = writingDownloadName("a" + "-".repeat(500_000) + "tail", "json", new Date("2026-11-01T00:00:00.000Z"));
    assert.equal(name, "a" + "-".repeat(59) + "-2026-11-01.json");
  `], { timeout: 3000, encoding: "utf8" });
  assert.equal(result.error, undefined, "filename preparation must finish inside the subprocess deadline");
  assert.equal(result.status, 0, result.stderr);
});

test("content-free report CSV uses the same live, bounded download lease and cannot masquerade as HTML", () => {
  const delivered: string[] = [];
  const lease = new CollectionDownloadLease({ create: () => "blob:report", revoke: () => {}, deliver: (_url, name) => { delivered.push(name); }, later: work => setTimeout(work, 1000), cancel: timer => clearTimeout(timer) });
  const artifact = { text: "section,state\r\npair,unchecked\r\n", name: "no-wave-review-report.csv", mime: "text/csv;charset=utf-8" };
  lease.download(artifact, () => true);
  assert.deepEqual(delivered, [artifact.name]);
  assert.throws(() => lease.download({ ...artifact, mime: "text/html" }, () => true));
  assert.throws(() => lease.download({ ...artifact, name: "report.json" }, () => true));
  lease.release();
});

test("portable leading-underscore backup names remain downloadable without permitting hidden files or path traversal", () => {
  const delivered: string[] = [];
  const lease = new CollectionDownloadLease({ create: () => "blob:single", revoke: () => {}, deliver: (_url, name) => { delivered.push(name); }, later: work => setTimeout(work, 1000), cancel: timer => clearTimeout(timer) });
  const artifact = { text: "{}", name: "_private-2026-11-12.json", mime: "application/json;charset=utf-8" };
  try {
    lease.download(artifact, () => true);
    assert.deepEqual(delivered, [artifact.name]);
    for (const name of [".private.json", "../private.json", "a/b.json", "a\\b.json", "https:evil.json"]) assert.throws(() => lease.download({ ...artifact, name }, () => true));
  } finally { lease.release(); }
});

test("a native read whose byte result changed or was truncated is never accepted as the chosen complete file", async () => {
  const reader = new Reader();
  const result = readCollectionFile(new File(["{} "], "changed.json"), new AbortController().signal, () => {}, () => reader as unknown as FileReader);
  reader.finish([123, 125]);
  await assert.rejects(result, /大小|字节|变化/);
  assert.equal(reader.onload, null);
});
