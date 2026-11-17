import { MAX_WRITING_BACKUP_BYTES, parseWritingBackup, type WritingBackup } from "./writing-backup.ts";
import { writingRecord } from "./writing-document.ts";

export const COLLECTION_DOCUMENT_LIMIT = 20;
export const COLLECTION_BYTE_LIMIT = 16 * 1024 * 1024;
export type CollectionEntry = { key: string; group: string; backup: WritingBackup; digest: string };
export type WritingCollection = { format: "no-wave-writing-collection"; version: 1; createdAt: string; entries: CollectionEntry[]; digest: string };
export type PreparedCollection = { collection: WritingCollection; text: string; bytes: number };
export type CollectionDocument = { group: string; backup: WritingBackup };
export type OpenedCollection = { source: "single" | "collection"; prepared: PreparedCollection };
const FORMAT = "no-wave-writing-collection";
const DIGEST = /^[a-f0-9]{64}$/;
const ENTRY_KEY = /^d(?:[1-9]|1\d|20)$/;
const GROUP_KEY = /^w(?:[1-9]|1\d|20)$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function invalid(message: string): never { throw new Error(`集合校验失败：${message}`); }
function active(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("集合操作已取消。", "AbortError");
}
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const record = writingRecord(value);
  if (!record || Object.keys(record).length !== fields.length || fields.some(field => !Object.hasOwn(record, field))) invalid("字段缺失、未知或结构无效。");
  return record;
}
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid("创建时间无效。");
  return value;
}
function boundedText(text: string): number {
  if (!text.length || text.length > COLLECTION_BYTE_LIMIT) invalid("文件须大于 0 且不超过 16 MiB。");
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > COLLECTION_BYTE_LIMIT) invalid("UTF-8 文件超过 16 MiB。");
  return bytes;
}
/** Check names before native JSON.parse can discard earlier values; strings remain inert literal data. */
function unambiguousJsonKeys(text: string): void {
  const scopes: (Set<string> | null)[] = [];
  for (let offset = 0; offset < text.length; offset++) {
    const character = text[offset];
    if (character === "{" || character === "[") {
      scopes.push(character === "{" ? new Set<string>() : null);
      if (scopes.length > 64) invalid("JSON 结构层级超过 64，未读取深层输入。");
    } else if (character === "}" || character === "]") scopes.pop();
    else if (character === '"') {
      const start = offset;
      let end = offset + 1;
      while (end < text.length && text[end] !== '"') { if (text[end] === "\\") end++; end++; }
      if (end >= text.length) invalid("JSON 字符串没有结束。");
      let next = end + 1;
      while (next < text.length && (text[next] === " " || text[next] === "\t" || text[next] === "\r" || text[next] === "\n")) next++;
      if (text[next] === ":") {
        const names = scopes.at(-1);
        if (!names) invalid("JSON 对象字段结构无效。");
        let name: unknown;
        try { name = JSON.parse(text.slice(start, end + 1)); } catch { invalid("JSON 字段名编码无效。"); }
        if (typeof name !== "string" || names.has(name)) invalid("JSON 含重复或歧义字段名，未接纳最后一个值来掩盖其他内容。");
        names.add(name);
      }
      offset = end;
    }
  }
}
export function readCollectionJson(text: string): unknown {
  boundedText(text);
  const input = text.replace(/^\ufeff/, "");
  unambiguousJsonKeys(input);
  try {
    return JSON.parse(input, (key: string, value: unknown) => {
      if (FORBIDDEN_KEYS.has(key)) invalid("包含危险字段。");
      return value;
    });
  } catch { invalid("不是支持的 JSON，或含危险字段。"); }
}

/** Only validated JSON reaches this serializer; object key order is not part of the checksum. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const text = JSON.stringify(value);
    if (text === undefined) invalid("摘要输入无法序列化。");
    return text;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}
export async function collectionChecksum(value: unknown, signal?: AbortSignal): Promise<string> {
  active(signal);
  if (!globalThis.crypto?.subtle) invalid("浏览器不支持 SHA-256，请在支持 Web Crypto 的 HTTPS 页面使用；没有降级为弱校验。");
  const bytes = new TextEncoder().encode(canonical(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  active(signal);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
function normalizedBackup(value: unknown): WritingBackup {
  if (!writingRecord(value)) invalid("文稿备份结构无效。");
  const text = JSON.stringify(value);
  if (text.length > MAX_WRITING_BACKUP_BYTES) invalid("单篇备份超过 2 MiB。");
  return parseWritingBackup(text);
}
function manifest(createdAt: string, entries: CollectionEntry[]) {
  return { format: FORMAT, version: 1, createdAt, entries: entries.map(({ key, group, digest }) => ({ key, group, digest })) };
}
function prepared(collection: WritingCollection): PreparedCollection {
  const text = JSON.stringify(collection) + "\n";
  return { collection, text, bytes: boundedText(text) };
}
function uniqueLanguage(seen: Set<string>, group: string, backup: WritingBackup) {
  const key = `${group}:${backup.draft.locale}`;
  if (seen.has(key)) invalid("同一文件内作品组不能有重复语言。");
  seen.add(key);
}

/** Groups are replaced with file-local numbers: server IDs never become restore authority. */
export async function createWritingCollection(documents: readonly CollectionDocument[], now = new Date(), signal?: AbortSignal): Promise<PreparedCollection> {
  active(signal);
  if (!documents.length || documents.length > COLLECTION_DOCUMENT_LIMIT) invalid("请选择 1–20 篇文稿，不会截断选择。");
  const createdAt = timestamp(now.toISOString());
  const groups = new Map<string, string>();
  const languages = new Set<string>();
  const entries: CollectionEntry[] = [];
  let entryBytes = 0;
  for (const document of documents) {
    active(signal);
    if (typeof document.group !== "string" || !document.group.trim() || document.group.length > 300 || /[\u0000-\u001f\u007f]/u.test(document.group)) invalid("来源组号无效。");
    const backup = normalizedBackup(document.backup);
    if (!groups.has(document.group)) groups.set(document.group, `w${groups.size + 1}`);
    const group = groups.get(document.group)!;
    uniqueLanguage(languages, group, backup);
    const content = { key: `d${entries.length + 1}`, group, backup };
    const digest = await collectionChecksum(content, signal);
    const entry = { ...content, digest };
    entryBytes += new TextEncoder().encode(JSON.stringify(entry)).byteLength;
    if (entryBytes > COLLECTION_BYTE_LIMIT) invalid("所选文稿合计超过 16 MiB，未截断导出。 ");
    entries.push(entry);
  }
  const digest = await collectionChecksum(manifest(createdAt, entries), signal);
  active(signal);
  return prepared({ format: FORMAT, version: 1, createdAt, entries, digest });
}

async function verify(value: unknown, signal?: AbortSignal): Promise<PreparedCollection> {
  active(signal);
  const raw = exact(value, ["format", "version", "createdAt", "entries", "digest"]);
  if (raw.format !== FORMAT || raw.version !== 1) invalid("不是支持的文稿集合版本。");
  const createdAt = timestamp(raw.createdAt);
  if (!Array.isArray(raw.entries) || !raw.entries.length || raw.entries.length > COLLECTION_DOCUMENT_LIMIT || typeof raw.digest !== "string" || !DIGEST.test(raw.digest)) invalid("条数或集合摘要无效。");
  const keys = new Set<string>(), languages = new Set<string>();
  const entries: CollectionEntry[] = [];
  for (const item of raw.entries) {
    active(signal);
    const entry = exact(item, ["key", "group", "backup", "digest"]);
    if (typeof entry.key !== "string" || !ENTRY_KEY.test(entry.key) || keys.has(entry.key) || typeof entry.group !== "string" || !GROUP_KEY.test(entry.group) || typeof entry.digest !== "string" || !DIGEST.test(entry.digest)) invalid("文稿标识重复或条目摘要无效。");
    keys.add(entry.key);
    const backup = normalizedBackup(entry.backup);
    uniqueLanguage(languages, entry.group, backup);
    const content = { key: entry.key, group: entry.group, backup };
    if (await collectionChecksum(content, signal) !== entry.digest) invalid("某篇文稿的摘要不匹配，未载入任何条目。");
    entries.push({ ...content, digest: entry.digest });
  }
  if (await collectionChecksum(manifest(createdAt, entries), signal) !== raw.digest) invalid("集合清单摘要不匹配，成员、顺序或元数据可能变化。");
  active(signal);
  return prepared({ format: FORMAT, version: 1, createdAt, entries, digest: raw.digest });
}

export async function parseWritingCollection(text: string, signal?: AbortSignal): Promise<PreparedCollection> {
  active(signal);
  return verify(readCollectionJson(text), signal);
}

/** Legacy files have no supplied checksum: converting one must not claim original-file integrity. */
export async function openWritingCollection(text: string, signal?: AbortSignal): Promise<OpenedCollection> {
  active(signal);
  const raw = readCollectionJson(text);
  if (writingRecord(raw)?.format === "no-wave-writing-backup") {
    const backup = parseWritingBackup(text);
    return { source: "single", prepared: await createWritingCollection([{ group: "single", backup }], new Date(backup.createdAt), signal) };
  }
  return { source: "collection", prepared: await verify(raw, signal) };
}
