/**
 * Reading a Notion database: the walk the seed script and the desk's pull share.
 *
 * Two callers, one walk (ADR 0052, decision 9). `scripts/lib/notion-client.ts`
 * runs it to completion on an operator's machine; `application/notion-fetch.ts`
 * runs it inside one API request, in slices bounded by time and bytes, with a
 * token the author pasted and that the server never keeps. What differs between
 * them — pacing, how a rate limit is waited out, how big a response may be — is
 * the injected `NotionCall`; what they share is how Notion is *read*, which is
 * the part that loses an author's paragraphs when it is wrong.
 *
 * Three Notion API facts shape it:
 *
 * 1. **A database is not the queryable thing any more.** Since API version
 *    2025-09-03 the properties live on a *data source*, and rows are queried
 *    through it. A database resolves to its first data source, which is what an
 *    author's own database has.
 * 2. **Everything paginates.** The query returns `next_cursor`; a page's
 *    children do too; a container block's children have their own cursor. A walk
 *    that stops at the first page silently loses the tail of a manuscript, so
 *    every loop continues until the cursor is null.
 * 3. **The body lives in blocks, not in the row.** Each page's children are
 *    walked depth-first — the mapping expects a flat, in-order list.
 *
 * A page with more blocks than the ceiling is an error (`TooManyBlocksError`),
 * never a truncated body: importing the first 2000 blocks of a longer page would
 * publish a manuscript with its ending missing and nothing saying so.
 */
import type { NotionBlockLike, NotionPropertyValue } from "../application/notion-interchange.ts";

export const NOTION_API_ORIGIN = "https://api.notion.com";
export const NOTION_API_VERSION = "2025-09-03";

/** The slice of a fetch response this module reads. `headers` is optional so a test stub can omit it. */
export type NotionResponse = {
  status: number;
  ok: boolean;
  json: () => Promise<unknown>;
  headers?: { get(name: string): string | null };
};

/** The slice of `fetch` this module needs, so a test can stand in for it. */
export type NotionFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<NotionResponse>;

/**
 * A Notion call failed. The message names the endpoint and the status; whether it
 * also carries Notion's own message is the caller's choice (`notionCaller`), because
 * a Notion error body can echo content and the API must not forward it.
 */
export class NotionApiError extends Error {
  readonly status: number;
  /** Notion's `Retry-After`, in seconds, when it sent one. */
  readonly retryAfterSeconds: number | null;
  constructor(message: string, status: number, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "NotionApiError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** A page's body is longer than the walk may carry; it is reported, not truncated. */
export class TooManyBlocksError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`The page has more than ${limit} blocks.`);
    this.name = "TooManyBlocksError";
    this.limit = limit;
  }
}

/** One Notion request: a path under the API origin, and a JSON body for a POST. */
export type NotionCall = (path: string, body?: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** A row of a data source, reduced to what the bundle carries. */
export type NotionRow = {
  id: string;
  properties: Record<string, NotionPropertyValue>;
  inTrash?: true;
  archived?: true;
};

type NotionPageObject = { id?: unknown; properties?: unknown; in_trash?: unknown; archived?: unknown };
type NotionBlockObject = { id?: unknown; type?: unknown; has_children?: unknown };

function retryAfterOf(response: NotionResponse): number | null {
  const raw = response.headers?.get("retry-after") ?? null;
  if (raw === null || !/^\d{1,6}$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

export type NotionCallerOptions = {
  token: string;
  fetchImpl: NotionFetch;
  sleep: (ms: number) => Promise<void>;
  /**
   * What to do with a 429: the number of milliseconds to wait before the one
   * retry, or `null` to give up and throw. Receives Notion's `Retry-After`.
   */
  onRateLimit: (retryAfterSeconds: number | null) => number | null;
  /** Put Notion's own error message in the thrown error (fine on an operator's terminal, not in an API). */
  includeNotionMessage: boolean;
  /** The least time between two calls, to stay under Notion's ~3 requests per second. */
  minIntervalMs?: number;
  now?: () => number;
};

/**
 * Bind a token to a `NotionCall`. The token goes into the `Authorization` header
 * and nowhere else; no error built here contains it or the request.
 */
export function notionCaller(options: NotionCallerOptions): NotionCall {
  const now = options.now ?? (() => Date.now());
  let last = Number.NEGATIVE_INFINITY;
  const send = async (path: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<NotionResponse> => {
    const gap = (options.minIntervalMs ?? 0) - (now() - last);
    if (gap > 0) await options.sleep(gap);
    last = now();
    return options.fetchImpl(`${NOTION_API_ORIGIN}${path}`, init);
  };
  return async (path, body) => {
    const init = {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${options.token}`,
        "notion-version": NOTION_API_VERSION,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    let response = await send(path, init);
    if (response.status === 429) {
      const wait = options.onRateLimit(retryAfterOf(response));
      if (wait !== null) {
        await options.sleep(wait);
        response = await send(path, init);
      }
    }
    const what = `${init.method} ${path.split("?")[0]}`;
    const parsed = await response.json().catch(() => null);
    if (!response.ok) {
      const notionMessage = options.includeNotionMessage && typeof parsed === "object" && parsed !== null &&
        typeof (parsed as { message?: unknown }).message === "string" ? (parsed as { message: string }).message : `HTTP ${response.status}`;
      throw new NotionApiError(`${what} failed: ${notionMessage}`, response.status, retryAfterOf(response));
    }
    if (typeof parsed !== "object" || parsed === null) throw new NotionApiError(`${what} returned a non-object body.`, response.status);
    return parsed as Record<string, unknown>;
  };
}

/**
 * Resolve the queryable data source for a database, tolerating a caller that
 * already passed a data source id.
 */
export async function resolveDataSource(sourceId: string, call: NotionCall): Promise<{ id: string; title: string | null }> {
  try {
    const database = await call(`/v1/databases/${encodeURIComponent(sourceId)}`);
    const sources = Array.isArray(database.data_sources) ? database.data_sources : [];
    const first = sources[0] as { id?: unknown; name?: unknown } | undefined;
    if (typeof first?.id === "string") return { id: first.id, title: typeof first.name === "string" ? first.name : null };
    throw new NotionApiError("The database holds no data source to query.", 404);
  } catch (error) {
    // A data source id answers 404 (or 400) on the database endpoint and works
    // on the query endpoint, which is the point: the caller may pass either. A
    // 401 or 429 is not "maybe a data source" and is reported as it is.
    if (error instanceof NotionApiError && (error.status === 400 || error.status === 404)) return { id: sourceId, title: null };
    throw error;
  }
}

/** One page of a data source's rows. `cursor` is the previous answer's `nextCursor`. */
export async function queryRows(sourceId: string, call: NotionCall, options: { cursor: string | null; pageSize: number }): Promise<{ rows: NotionRow[]; nextCursor: string | null }> {
  const query: Record<string, unknown> = { page_size: Math.min(Math.max(options.pageSize, 1), 100) };
  if (options.cursor !== null) query.start_cursor = options.cursor;
  const result = await call(`/v1/data_sources/${encodeURIComponent(sourceId)}/query`, query);
  const rows: NotionRow[] = [];
  for (const page of Array.isArray(result.results) ? (result.results as NotionPageObject[]) : []) {
    if (typeof page.id !== "string") continue;
    rows.push({
      id: page.id,
      properties: typeof page.properties === "object" && page.properties !== null ? page.properties as Record<string, NotionPropertyValue> : {},
      ...(page.in_trash === true ? { inTrash: true as const } : {}),
      ...(page.archived === true ? { archived: true as const } : {}),
    });
  }
  return { rows, nextCursor: typeof result.next_cursor === "string" ? result.next_cursor : null };
}

/**
 * Walk a page's blocks depth-first, fetching every page of children.
 *
 * `has_children` is the only reliable signal: a block object never embeds its
 * own children. When it is set, the children are fetched and appended after the
 * parent — the order the mapping reads them in. Only the fields the mapping
 * reads are kept, plus a stable id: Notion blocks also carry audit fields
 * (created_by, last_edited_time) that would make a bundle noisy and a diff useless.
 */
export async function collectBlocks(blockId: string, call: NotionCall, options: { pageSize: number; maxBlocks: number }): Promise<NotionBlockLike[]> {
  const out: NotionBlockLike[] = [];
  const walk = async (parent: string): Promise<void> => {
    let cursor: string | null = null;
    do {
      const query = `page_size=${Math.min(Math.max(options.pageSize, 1), 100)}${cursor === null ? "" : `&start_cursor=${encodeURIComponent(cursor)}`}`;
      const page = await call(`/v1/blocks/${encodeURIComponent(parent)}/children?${query}`);
      for (const block of Array.isArray(page.results) ? (page.results as NotionBlockObject[]) : []) {
        if (out.length >= options.maxBlocks) throw new TooManyBlocksError(options.maxBlocks);
        const kept: NotionBlockLike = { id: typeof block.id === "string" ? block.id : "", type: block.type as string | undefined, has_children: block.has_children === true };
        if (typeof block.type === "string") kept[block.type] = (block as Record<string, unknown>)[block.type];
        out.push(kept);
        if (block.has_children === true && typeof block.id === "string") await walk(block.id);
      }
      cursor = typeof page.next_cursor === "string" ? page.next_cursor : null;
    } while (cursor !== null);
  };
  await walk(blockId);
  return out;
}

/** Bytes a Notion API response may have before it is refused, counted on the stream. */
export const NOTION_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The API's `NotionFetch`: one origin, no redirects, a per-call deadline and a
 * byte ceiling enforced while reading — the same discipline as the image copy
 * (`notion-image-fetch.ts`). Failures never carry the URL, headers or body.
 */
export function boundedNotionFetch(fetchImpl: typeof fetch = fetch, options: { timeoutMs?: number; maxBytes?: number } = {}): NotionFetch {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxBytes ?? NOTION_RESPONSE_MAX_BYTES;
  return async (url, init) => {
    if (!url.startsWith(`${NOTION_API_ORIGIN}/v1/`)) throw new NotionApiError("Refused a request outside the Notion API.", 0);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImpl(url, { method: init.method, headers: init.headers, ...(init.body === undefined ? {} : { body: init.body }), redirect: "manual", signal: controller.signal });
      } catch {
        throw new NotionApiError("The Notion API could not be reached.", 0);
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {});
        throw new NotionApiError("The Notion API answered with a redirect.", response.status);
      }
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body?.cancel().catch(() => {});
        throw new NotionApiError("The Notion API response is too large.", 413);
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          let next: Awaited<ReturnType<typeof reader.read>>;
          try { next = await reader.read(); } catch { throw new NotionApiError("The Notion API response was interrupted.", 0); }
          if (next.done) break;
          total += next.value.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new NotionApiError("The Notion API response is too large.", 413);
          }
          chunks.push(next.value);
        }
      }
      const text = Buffer.concat(chunks).toString("utf8");
      return {
        status: response.status,
        ok: response.ok,
        headers: response.headers,
        json: async () => JSON.parse(text) as unknown,
      };
    } finally {
      clearTimeout(timer);
    }
  };
}
