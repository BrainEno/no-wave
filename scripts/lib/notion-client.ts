/**
 * Fetching a Notion database into a bundle.
 *
 * This is the only place in the repository that speaks to Notion, and it exists
 * so that `--notion-token` is a convenience rather than an architecture: the
 * fetcher produces exactly the JSON that `--bundle` reads, so the mapping and
 * the planner cannot tell which one you used, and the future REST endpoint can
 * accept the same document from a client that did the fetching itself.
 *
 * Three Notion API facts shape it:
 *
 * 1. **A database is not the queryable thing any more.** Since API version
 *    2025-09-03 the properties live on a *data source*, and rows are queried
 *    through it. The fetcher resolves the database's first data source, which is
 *    what an author's own database has.
 * 2. **Everything paginates.** The query returns `next_cursor`; a page's
 *    children do too; a container block's children have their own cursor. A
 *    bundle that stops at the first page silently loses the tail of a
 *    manuscript, so every loop here continues until the cursor is null.
 * 3. **The body lives in blocks, not in the row.** Each page's children are
 *    walked depth-first — the mapping expects a flat, in-order list.
 *
 * The token is sent as a header and never logged. Errors carry the endpoint and
 * the status, not the request, because a Notion error body can echo content.
 */
import type { NotionBundle, NotionBundlePage } from "./notion-bundle.ts";
import type { NotionBlockLike, NotionPropertyValue } from "../../apps/api/src/application/notion-interchange.ts";

export const NOTION_API_ORIGIN = "https://api.notion.com";
export const NOTION_API_VERSION = "2025-09-03";

/** The slice of `fetch` this module needs, so a test can stand in for it. */
export type NotionFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; ok: boolean; json: () => Promise<unknown> }>;

export class NotionApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type NotionPageObject = {
  id?: string;
  properties?: Record<string, NotionPropertyValue>;
  in_trash?: boolean;
  archived?: boolean;
};

type NotionBlockObject = {
  id?: string;
  type?: string;
  has_children?: boolean;
};

export type CollectBundleOptions = {
  token: string;
  /** A data source id, or a database id (resolved to its first data source). */
  sourceId: string;
  fetchImpl?: NotionFetch;
  /** Wall-clock sleep, injectable so a retry test does not wait. */
  sleep?: (ms: number) => Promise<void>;
  pageSize?: number;
  /** Safety valve: a bundle far larger than one author's manuscripts is a bug. */
  maxPages?: number;
  maxBlocksPerPage?: number;
};

async function readJson(response: { status: number; ok: boolean; json: () => Promise<unknown> }, what: string): Promise<Record<string, unknown>> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "message" in body && typeof (body as { message?: unknown }).message === "string"
      ? (body as { message: string }).message
      : `HTTP ${response.status}`;
    throw new NotionApiError(`${what} failed: ${message}`, response.status);
  }
  if (typeof body !== "object" || body === null) throw new NotionApiError(`${what} returned a non-object body.`, response.status);
  return body as Record<string, unknown>;
}

/**
 * Walk a page's blocks depth-first, fetching every page of children.
 *
 * `has_children` is the only reliable signal: a block object never embeds its
 * own children. When it is set, the children are fetched and appended after the
 * parent — the order the mapping reads them in.
 */
async function collectBlocks(
  blockId: string,
  call: (path: string, body?: Record<string, unknown>) => Promise<Record<string, unknown>>,
  options: { pageSize: number; maxBlocks: number; sleep: (ms: number) => Promise<void> },
): Promise<NotionBlockLike[]> {
  const out: NotionBlockLike[] = [];
  let cursor: string | null = null;
  do {
    const query = `page_size=${options.pageSize}${cursor === null ? "" : `&start_cursor=${encodeURIComponent(cursor)}`}`;
    const page = await call(`/v1/blocks/${encodeURIComponent(blockId)}/children?${query}`);
    const results = Array.isArray(page.results) ? (page.results as NotionBlockObject[]) : [];
    for (const block of results) {
      if (out.length >= options.maxBlocks) return out;
      // Keep only the fields the mapping reads, plus a stable id. Notion blocks
      // also carry audit fields (created_by, last_edited_time) that would make a
      // bundle noisy and a diff useless.
      const kept: NotionBlockLike = { id: typeof block.id === "string" ? block.id : "", type: block.type, has_children: block.has_children === true };
      if (typeof block.type === "string") kept[block.type] = (block as Record<string, unknown>)[block.type];
      out.push(kept);
      if (block.has_children === true && typeof block.id === "string") {
        out.push(...(await collectBlocks(block.id, call, options)));
        if (out.length >= options.maxBlocks) return out;
      }
    }
    cursor = typeof page.next_cursor === "string" ? page.next_cursor : null;
  } while (cursor !== null);
  return out;
}

/**
 * Resolve the queryable data source for a database, tolerating a caller that
 * already passed a data source id.
 */
async function resolveDataSource(
  sourceId: string,
  call: (path: string, body?: Record<string, unknown>) => Promise<Record<string, unknown>>,
): Promise<{ id: string; title: string | null }> {
  try {
    const database = await call(`/v1/databases/${encodeURIComponent(sourceId)}`);
    const sources = Array.isArray(database.data_sources) ? database.data_sources : [];
    const first = sources[0] as { id?: string; name?: string } | undefined;
    if (typeof first?.id === "string") return { id: first.id, title: typeof first.name === "string" ? first.name : null };
    throw new NotionApiError("The database holds no data source to query.", 404);
  } catch (error) {
    // A data source id answers 404 (or 400) on the database endpoint and works
    // on the query endpoint, which is the point: the caller may pass either.
    if (error instanceof NotionApiError && error.status < 500) {
      return { id: sourceId, title: null };
    }
    throw error;
  }
}

export async function collectNotionBundle(options: CollectBundleOptions): Promise<NotionBundle> {
  const fetchImpl: NotionFetch = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const pageSize = Math.min(Math.max(options.pageSize ?? 100, 1), 100);
  const maxPages = options.maxPages ?? 2000;
  const maxBlocksPerPage = options.maxBlocksPerPage ?? 2000;

  const call = async (path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const init = {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${options.token}`,
        "notion-version": NOTION_API_VERSION,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    let response = await fetchImpl(`${NOTION_API_ORIGIN}${path}`, init);
    // One retry on a rate limit, because a run that stops at the first 429 on a
    // 200-page database is not a run.
    if (response.status === 429) {
      await sleep(1000);
      response = await fetchImpl(`${NOTION_API_ORIGIN}${path}`, init);
    }
    return readJson(response, `${init.method} ${path}`);
  };

  const source = await resolveDataSource(options.sourceId, call);
  const pages: NotionBundlePage[] = [];
  let cursor: string | null = null;

  do {
    const query: Record<string, unknown> = { page_size: pageSize };
    if (cursor !== null) query.start_cursor = cursor;
    const result = await call(`/v1/data_sources/${encodeURIComponent(source.id)}/query`, query);
    const results = Array.isArray(result.results) ? (result.results as NotionPageObject[]) : [];
    for (const page of results) {
      if (pages.length >= maxPages) break;
      if (typeof page.id !== "string") continue;
      const blocks = await collectBlocks(page.id, call, { pageSize, maxBlocks: maxBlocksPerPage, sleep });
      pages.push({
        id: page.id,
        properties: page.properties ?? {},
        blocks,
        ...(page.in_trash === true ? { inTrash: true } : {}),
        ...(page.archived === true ? { archived: true } : {}),
      });
    }
    cursor = typeof result.next_cursor === "string" ? result.next_cursor : null;
  } while (cursor !== null && pages.length < maxPages);

  return { version: 1, database: { id: source.id, title: source.title }, pages };
}
