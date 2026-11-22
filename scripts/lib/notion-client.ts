/**
 * Fetching a Notion database into a bundle.
 *
 * It exists so that `--notion-token` is a convenience rather than an
 * architecture: the
 * fetcher produces exactly the JSON that `--bundle` reads, so the mapping and
 * the planner cannot tell which one you used, and the future REST endpoint can
 * accept the same document from a client that did the fetching itself.
 *
 * The walk itself — data source resolution, paginated queries, depth-first
 * blocks — lives in `apps/api/src/infrastructure/notion-source.ts`, shared with
 * the desk's pull (ADR 0052), so the two cannot read Notion differently. What
 * stays here is the operator's policy: run to completion, retry a rate limit
 * once after a second, and show Notion's own message on the terminal.
 *
 * The token is sent as a header and never logged. Errors carry the endpoint and
 * the status, not the request, because a Notion error body can echo content.
 */
import type { NotionBundle, NotionBundlePage } from "./notion-bundle.ts";
import {
  NOTION_API_ORIGIN,
  NOTION_API_VERSION,
  NotionApiError,
  TooManyBlocksError,
  collectBlocks,
  notionCaller,
  queryRows,
  resolveDataSource,
  type NotionFetch,
} from "../../apps/api/src/infrastructure/notion-source.ts";

export { NOTION_API_ORIGIN, NOTION_API_VERSION, NotionApiError, type NotionFetch };

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

export async function collectNotionBundle(options: CollectBundleOptions): Promise<NotionBundle> {
  const fetchImpl: NotionFetch = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const pageSize = Math.min(Math.max(options.pageSize ?? 100, 1), 100);
  const maxPages = options.maxPages ?? 2000;
  const maxBlocksPerPage = options.maxBlocksPerPage ?? 2000;
  // One retry on a rate limit, because a run that stops at the first 429 on a
  // 200-page database is not a run.
  const call = notionCaller({ token: options.token, fetchImpl, sleep, onRateLimit: () => 1000, includeNotionMessage: true });

  const source = await resolveDataSource(options.sourceId, call);
  const pages: NotionBundlePage[] = [];
  let cursor: string | null = null;
  do {
    const result = await queryRows(source.id, call, { cursor, pageSize });
    for (const row of result.rows) {
      if (pages.length >= maxPages) break;
      let blocks;
      try {
        blocks = await collectBlocks(row.id, call, { pageSize, maxBlocks: maxBlocksPerPage });
      } catch (error) {
        // A truncated body would import a manuscript without its ending.
        if (error instanceof TooManyBlocksError) throw new Error(`Page ${row.id} has more than ${maxBlocksPerPage} blocks; raise maxBlocksPerPage or split the page in Notion.`);
        throw error;
      }
      pages.push({ id: row.id, properties: row.properties, blocks, ...(row.inTrash ? { inTrash: true } : {}), ...(row.archived ? { archived: true } : {}) });
    }
    cursor = result.nextCursor;
  } while (cursor !== null && pages.length < maxPages);

  return { version: 1, database: { id: source.id, title: source.title }, pages };
}
