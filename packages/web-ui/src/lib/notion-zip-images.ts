import { Unzip, UnzipInflate } from "fflate";

/**
 * Images inside a Notion Markdown export, uploaded to the author's media library
 * on the author's click (P2).
 *
 * A Notion export ZIP keeps every image beside the page that shows it and links it
 * relatively (`![](墙壁%20ce90…/image.png)`). The import API takes JSON and an
 * image block needs a URL, so until now those images were removed with a warning.
 * The desk can instead send each one through the same upload the editor uses
 * (`POST /api/authoring/media` → `POST /api/v1/me/media`), and put the returned
 * `/api/media/<id>` — the site's own, stable address — into the bundle before the
 * dry run. Nothing about the upload or the import changes on the server:
 *
 * - the upload's limits stand: JPEG, PNG or WebP, at most 8 MiB, re-encoded by the
 *   server; 10 uploads per author per hour (20 per IP). One click sends at most
 *   `LOCAL_IMAGE_UPLOADS_PER_RUN` requests and stops at the first 429 — it never
 *   waits out an hour; what was not sent is counted, and the author imports again
 *   later;
 * - nothing is uploaded unless the author clicks, and an upload writes no article:
 *   the dry run and the confirm still decide that. An image that is not uploaded
 *   is still removed and named, exactly as before;
 * - an image uploaded earlier is not uploaded again. The browser remembers, per
 *   image, a fingerprint → the address it got (`localStorage`, see
 *   `browserUploadMemory`), and reuses that address only after finding the asset
 *   in the signed-in author's own library — so a later visit continues where the
 *   hourly limit stopped it, a deleted asset is uploaded afresh, and another
 *   account in the same browser never borrows one.
 *
 * The ZIP has already passed `readMarkdownZip`'s checks (complete, not ZIP64,
 * at most 8 MiB). Image entries are listed from its central directory without
 * decompressing anything; only the images about to be sent are inflated, one pass
 * per group, each cut off at 8 MiB however small its header claims it is.
 */

/** The media upload's own ceiling (`MEDIA_MAX_BYTES`); a larger image would be refused anyway. */
export const LOCAL_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
/** Upload requests per click: the media limit's per-author allowance for an hour. */
export const LOCAL_IMAGE_UPLOADS_PER_RUN = 10;
/** Library pages read to confirm remembered uploads (60 per page). */
const LIBRARY_PAGES_MAX = 10;
const MEDIA_SRC = /^\/api\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

/** Extensions the media upload accepts, and the other image types a Notion export may hold. */
const UPLOADABLE = /\.(jpe?g|png|webp)$/i;
const IMAGE_LIKE = /\.(jpe?g|png|webp|gif|svg|heic|heif|bmp|tiff?|avif|ico)$/i;

export type ZipImageEntry = { name: string; crc: number; size: number };

/**
 * The image entries of a ZIP, by name, from its central directory. Names are
 * decoded as fflate decodes them (UTF-8 when flagged, Latin-1 otherwise) so they
 * agree with `readMarkdownZip`'s entry names. Malformed records end the listing:
 * what was not listed is simply not uploadable.
 */
export function zipImageEntries(bytes: Uint8Array): Map<string, ZipImageEntry> {
  const found = new Map<string, ZipImageEntry>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) {
    if (view.getUint32(p, true) === 0x06054b50 && p + 22 + view.getUint16(p + 20, true) === bytes.length) { end = p; break; }
  }
  if (end < 0) return found;
  const count = view.getUint16(end + 10, true);
  let p = view.getUint32(end + 16, true);
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || view.getUint32(p, true) !== 0x02014b50) break;
    const flags = view.getUint16(p + 8, true);
    const crc = view.getUint32(p + 16, true);
    const size = view.getUint32(p + 24, true);
    const nameLength = view.getUint16(p + 28, true);
    const next = p + 46 + nameLength + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
    if (next > end) break;
    const raw = bytes.subarray(p + 46, p + 46 + nameLength);
    const name = flags & 0x800 ? new TextDecoder("utf-8").decode(raw) : String.fromCharCode(...raw);
    // Encrypted entries cannot be read; macOS resource forks are not images.
    if ((flags & 1) === 0 && IMAGE_LIKE.test(name) && !/(^|\/)__MACOSX\//.test(name) && !name.endsWith("/")) {
      found.set(name, { name, crc, size });
    }
    p = next;
  }
  return found;
}

/**
 * Where a relative image link in `entryName` points inside the ZIP, or null for
 * anything that is not a plain relative path (a scheme, an absolute path, a
 * protocol-relative URL, or `..` above the archive's root).
 */
export function resolveLocalImage(entryName: string, href: string): string | null {
  const raw = href.trim().replace(/^<|>$/g, "");
  if (raw === "" || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("/") || raw.startsWith("\\")) return null;
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { /* keep the link as written */ }
  const base = entryName.replace(/\\/g, "/").split("/").slice(0, -1);
  const parts = [...base];
  for (const segment of decoded.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") { if (parts.length === 0) return null; parts.pop(); continue; }
    parts.push(segment);
  }
  return parts.length ? parts.join("/") : null;
}

/** The type the bytes really are, among the three the upload accepts. */
export function imageContentType(bytes: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return "image/png";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  return null;
}

/** Inflate only `wanted` entries; each stops at LOCAL_IMAGE_MAX_BYTES. */
export function extractZipImages(bytes: Uint8Array, wanted: ReadonlySet<string>): Map<string, Uint8Array | "too-large" | "unreadable"> {
  const out = new Map<string, Uint8Array | "too-large" | "unreadable">();
  const unzip = new Unzip((file) => {
    if (!wanted.has(file.name) || out.has(file.name)) return;
    const chunks: Uint8Array[] = []; let size = 0; let done = false;
    file.ondata = (err, chunk, final) => {
      if (done) return;
      if (err) { done = true; out.set(file.name, "unreadable"); return; }
      size += chunk.length;
      if (size > LOCAL_IMAGE_MAX_BYTES) { done = true; out.set(file.name, "too-large"); file.terminate(); return; }
      chunks.push(chunk);
      if (final) {
        done = true;
        const whole = new Uint8Array(size); let offset = 0;
        for (const part of chunks) { whole.set(part, offset); offset += part.length; }
        out.set(file.name, whole);
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    for (let offset = 0; offset < bytes.length; offset += 65536) unzip.push(bytes.subarray(offset, Math.min(offset + 65536, bytes.length)), offset + 65536 >= bytes.length);
  } catch { /* an entry that failed is reported below as unreadable */ }
  for (const name of wanted) if (!out.has(name)) out.set(name, "unreadable");
  return out;
}

/** Remembered uploads: fingerprint → `/api/media/<id>`. Fingerprints are hashes, never names. */
export type UploadMemory = { get(key: string): string | undefined; set(key: string, src: string): void };

const MEMORY_KEY = "nw:notion-zip-image-uploads:v1";
const MEMORY_MAX = 2000;

/** `localStorage`, or nothing when it is unavailable (private mode, quota): uploads still work, without reuse. */
export function browserUploadMemory(): UploadMemory {
  const read = (): Record<string, string> => {
    try {
      const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(MEMORY_KEY) ?? "{}");
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
    } catch { return {}; }
  };
  return {
    get: (key) => { const value = read()[key]; return typeof value === "string" && MEDIA_SRC.test(value) ? value : undefined; },
    set: (key, src) => {
      const all = read(); delete all[key]; all[key] = src;
      const keys = Object.keys(all);
      for (const old of keys.slice(0, Math.max(0, keys.length - MEMORY_MAX))) delete all[old];
      try { globalThis.localStorage?.setItem(MEMORY_KEY, JSON.stringify(all)); } catch { /* reuse is a convenience */ }
    },
  };
}

/** SHA-256 of the entry's path, CRC-32 and size: the same image in a later export of the same page. */
async function fingerprint(entry: ZipImageEntry): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(`${entry.name}\u0000${entry.crc}\u0000${entry.size}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type LocalImageCandidate = { path: string; zip: number; entry: ZipImageEntry };

/**
 * The local images a bundle conversion found, sorted into what one click can
 * upload and what it cannot (with the reason the author sees). `refs` are the
 * resolved paths in page order; duplicates count once.
 */
export function localImageCandidates(refs: readonly (string | null)[], zips: readonly ReadonlyMap<string, ZipImageEntry>[]):
  { candidates: LocalImageCandidate[]; unusable: { path: string; reason: string }[] } {
  const candidates: LocalImageCandidate[] = []; const unusable: { path: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const path of refs) {
    if (path === null || seen.has(path)) continue;
    seen.add(path);
    const zip = zips.findIndex((entries) => entries.has(path));
    const entry = zip < 0 ? undefined : zips[zip]!.get(path);
    if (entry === undefined) unusable.push({ path, reason: "所选文件里没有这张图片" });
    else if (!UPLOADABLE.test(path)) unusable.push({ path, reason: "只支持 JPEG、PNG、WebP 格式" });
    else if (entry.size > LOCAL_IMAGE_MAX_BYTES) unusable.push({ path, reason: "超过 8 MB" });
    else candidates.push({ path, zip, entry });
  }
  return { candidates, unusable };
}

export type LocalImageUploadDeps = {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  memory: UploadMemory;
  onProgress?: (message: string) => void;
};

export type LocalImageUploadResult = {
  /** Path → `/api/media/<id>`, new uploads and confirmed earlier ones together. */
  uploaded: Map<string, string>;
  newly: number;
  reused: number;
  failed: { path: string; reason: string }[];
  /** Not sent this time: over the per-click cap, or after a stop. */
  left: string[];
  stop: null | "rate-limited" | "session" | "unconfigured" | "network";
};

async function errorMessage(response: Response): Promise<string> {
  const payload: unknown = await response.json().catch(() => null);
  const message = typeof payload === "object" && payload !== null ? (payload as { error?: { message?: unknown } }).error?.message : undefined;
  return typeof message === "string" && message !== "" ? message : `HTTP ${response.status}`;
}

/** Ids in the signed-in author's library, read until every wanted id is seen or the bound is reached. */
async function libraryIds(wanted: ReadonlySet<string>, deps: LocalImageUploadDeps): Promise<Set<string> | "session"> {
  const ids = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < LIBRARY_PAGES_MAX; page++) {
    const query = new URLSearchParams({ limit: "60" });
    if (cursor !== null) query.set("cursor", cursor);
    let response: Response;
    try {
      response = await deps.fetch(`/api/authoring/media?${query.toString()}`, { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store" });
    } catch { return ids; }
    if (response.status === 401) return "session";
    if (!response.ok) return ids;
    const payload = await response.json().catch(() => null) as { data?: { items?: { id?: unknown }[]; nextCursor?: unknown } } | null;
    for (const item of payload?.data?.items ?? []) if (typeof item.id === "string") ids.add(item.id.toLowerCase());
    if ([...wanted].every((id) => ids.has(id))) return ids;
    cursor = typeof payload?.data?.nextCursor === "string" ? payload.data.nextCursor : null;
    if (cursor === null) return ids;
  }
  return ids;
}

/**
 * One click: reuse what this author already uploaded, then send at most
 * LOCAL_IMAGE_UPLOADS_PER_RUN upload requests, stopping at the first refusal that
 * would refuse the rest too. No request is retried, and nothing waits.
 */
export async function uploadLocalImages(zips: readonly Uint8Array[], candidates: readonly LocalImageCandidate[], deps: LocalImageUploadDeps): Promise<LocalImageUploadResult> {
  const result: LocalImageUploadResult = { uploaded: new Map(), newly: 0, reused: 0, failed: [], left: [], stop: null };
  const keys = new Map<string, string | null>();
  for (const candidate of candidates) keys.set(candidate.path, await fingerprint(candidate.entry));

  const remembered = new Map<string, string>();
  for (const candidate of candidates) {
    const key = keys.get(candidate.path);
    const src = key ? deps.memory.get(key) : undefined;
    if (src !== undefined) remembered.set(candidate.path, src);
  }
  if (remembered.size > 0) {
    deps.onProgress?.("正在核对媒体库里上次上传的图片…");
    const wanted = new Set([...remembered.values()].map((src) => MEDIA_SRC.exec(src)![1]!.toLowerCase()));
    const ids = await libraryIds(wanted, deps);
    if (ids === "session") { result.stop = "session"; result.left = candidates.map((c) => c.path); return result; }
    for (const [path, src] of remembered) {
      if (ids.has(MEDIA_SRC.exec(src)![1]!.toLowerCase())) { result.uploaded.set(path, src); result.reused++; }
    }
  }

  const pending = candidates.filter((candidate) => !result.uploaded.has(candidate.path));
  let attempts = 0; let at = 0;
  while (at < pending.length && attempts < LOCAL_IMAGE_UPLOADS_PER_RUN && result.stop === null) {
    // Inflate only as many as may still be sent; a file that cannot be sent costs no request.
    const group = pending.slice(at, at + LOCAL_IMAGE_UPLOADS_PER_RUN - attempts);
    at += group.length;
    const inflated = new Map<string, Uint8Array | "too-large" | "unreadable">();
    for (const zip of new Set(group.map((candidate) => candidate.zip))) {
      for (const [name, value] of extractZipImages(zips[zip]!, new Set(group.filter((c) => c.zip === zip).map((c) => c.path)))) inflated.set(name, value);
    }
    for (const candidate of group) {
      if (result.stop !== null) { result.left.push(candidate.path); continue; }
      const bytes = inflated.get(candidate.path);
      if (bytes === "too-large") { result.failed.push({ path: candidate.path, reason: "超过 8 MB" }); continue; }
      if (bytes === undefined || bytes === "unreadable") { result.failed.push({ path: candidate.path, reason: "无法从 ZIP 中读取" }); continue; }
      const type = imageContentType(bytes);
      if (type === null) { result.failed.push({ path: candidate.path, reason: "文件内容不是 JPEG、PNG 或 WebP 图片" }); continue; }
      attempts++;
      deps.onProgress?.(`正在上传第 ${attempts} 张图片（本次最多 ${Math.min(LOCAL_IMAGE_UPLOADS_PER_RUN, pending.length)} 张）…`);
      let response: Response;
      try {
        response = await deps.fetch("/api/authoring/media", {
          method: "POST", headers: { "content-type": type, accept: "application/json" }, credentials: "same-origin", cache: "no-store",
          body: bytes as Uint8Array<ArrayBuffer>,
        });
      } catch {
        // Unknown whether it was stored: if it was, it is in the library and can be deleted there.
        result.stop = "network"; result.left.push(candidate.path); continue;
      }
      if (response.status === 429) { result.stop = "rate-limited"; result.left.push(candidate.path); continue; }
      if (response.status === 401) { result.stop = "session"; result.left.push(candidate.path); continue; }
      if (response.status === 503) { result.stop = "unconfigured"; result.left.push(candidate.path); continue; }
      if (!response.ok) { result.failed.push({ path: candidate.path, reason: `上传被拒绝：${await errorMessage(response)}` }); continue; }
      const payload = await response.json().catch(() => null) as { data?: { src?: unknown } } | null;
      const src = payload?.data?.src;
      if (typeof src !== "string" || !MEDIA_SRC.test(src)) { result.failed.push({ path: candidate.path, reason: "上传服务返回了无效的图片地址" }); continue; }
      result.uploaded.set(candidate.path, src); result.newly++;
      const key = keys.get(candidate.path);
      if (key) deps.memory.set(key, src);
    }
  }
  result.left.push(...pending.slice(at).map((candidate) => candidate.path));
  deps.onProgress?.("");
  return result;
}
