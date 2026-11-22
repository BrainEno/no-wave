/**
 * Pulling a Notion database for the desk, one bounded slice per request (ADR 0052).
 *
 * The author pastes an integration token and a database link; the browser cannot
 * call Notion itself (no CORS), so the API does, with the walk the seed script
 * uses (`infrastructure/notion-source.ts`). Three rules make that acceptable:
 *
 * - **The token is never kept.** It arrives in the body of one request, becomes
 *   one `Authorization` header per Notion call, and is gone when the request
 *   ends. No error, log line, metric or response built here contains it, and
 *   none contains Notion's own error text, which can echo content.
 * - **A request is bounded, the pull is not.** The Web edge allows an upstream
 *   request at most 120 seconds and 8 MiB, and those limits are not raised for
 *   this. So each request stops starting work after `startBudgetMs`, abandons a
 *   page at `pageDeadlineMs`, and ends its slice at `maxBytes`; the browser sends
 *   the remaining page ids (or the row cursor) back for the next slice. Nothing
 *   about the continuation is stored here.
 * - **Nothing is dropped silently.** A page that is too long, too large, too
 *   slow or unreadable is answered in `done` with an issue code and no blocks —
 *   never with a truncated body that would import a manuscript without its end.
 *
 * What comes back is the raw material of a bundle. The browser assembles it and
 * hands it to the unchanged dry-run → explicit-confirm import; nothing here writes.
 */
import type { NotionBlockLike } from "./notion-interchange.ts";
import {
  NotionApiError,
  TooManyBlocksError,
  collectBlocks,
  notionCaller,
  queryRows,
  resolveDataSource,
  type NotionFetch,
  type NotionRow,
} from "../infrastructure/notion-source.ts";

export const NOTION_FETCH_LIMITS = Object.freeze({
  /** Page ids one `pages` request may name. */
  maxPageIds: 200,
  /** Rows one `rows` request may return before it hands back a cursor. */
  maxRows: 1000,
  /** No new page (or row page) is started after this much of the request. */
  startBudgetMs: 45_000,
  /** A page still being read at this point of the request is abandoned and reported. */
  pageDeadlineMs: 75_000,
  /** Serialized blocks one response may carry; the Web edge buffers at most 8 MiB. */
  maxBytes: 6 * 1024 * 1024,
  /** A page with more blocks is reported, not truncated. */
  maxBlocksPerPage: 2000,
  /** Notion averages about three requests per second per integration. */
  minIntervalMs: 340,
  /** The longest Notion `Retry-After` waited out inside a request. */
  maxInlineRetryMs: 10_000,
});

/** What a page that could not be carried is reported as. */
export type NotionFetchIssueCode = "too-many-blocks" | "page-too-large" | "fetch-timeout" | "page-unavailable" | "fetch-failed";

export type NotionFetchErrorCode = "NOTION_TOKEN_INVALID" | "NOTION_NOT_SHARED" | "NOTION_RATE_LIMITED" | "NOTION_UNAVAILABLE";

const ERROR_STATUS: Readonly<Record<NotionFetchErrorCode, { status: number; message: string }>> = Object.freeze({
  NOTION_TOKEN_INVALID: { status: 422, message: "Notion did not accept this token. It may be incomplete, expired or revoked; copy it again or create a new one." },
  NOTION_NOT_SHARED: { status: 422, message: "Notion could not find this database with this token. Check the link; with an internal integration, add it under the database's Connections." },
  NOTION_RATE_LIMITED: { status: 429, message: "Notion is rate limiting this integration. Retry after the indicated time." },
  NOTION_UNAVAILABLE: { status: 502, message: "The Notion API could not be read. Try again later." },
});

/** A pull that cannot continue; carries a stable code and nothing from Notion or the request. */
export class NotionFetchError extends Error {
  readonly code: NotionFetchErrorCode;
  readonly status: number;
  readonly retryAfterSeconds: number | null;
  constructor(code: NotionFetchErrorCode, retryAfterSeconds: number | null = null) {
    super(ERROR_STATUS[code].message);
    this.name = "NotionFetchError";
    this.code = code;
    this.status = ERROR_STATUS[code].status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The request is not one this endpoint accepts; the message says which part. */
export class NotionFetchRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotionFetchRequestError";
  }
}

const HEX_ID = /[0-9a-f]{32}/gi;

function dashed(hex: string): string {
  const id = hex.toLowerCase();
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

/**
 * A Notion id from what an author pastes: a bare id (with or without hyphens) or
 * a page/database link. In a link the id is the last one in the *path* — the
 * `?v=` query names a view, not the database.
 */
export function parseNotionId(input: string): string | null {
  const value = input.trim();
  if (value.length === 0 || value.length > 2048) return null;
  let haystack = value;
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (!/(^|\.)notion\.(so|site|com)$/i.test(url.hostname)) return null;
      haystack = url.pathname;
    } catch {
      return null;
    }
  }
  const matches = haystack.replaceAll("-", "").match(HEX_ID);
  const last = matches?.at(-1);
  if (!last) return null;
  if (!/^https?:\/\//i.test(value) && value.replaceAll("-", "").length !== 32) return null;
  return dashed(last);
}

/**
 * The bearer-token alphabet of RFC 6750 (`b64token`). Notion's tokens are opaque:
 * personal access tokens and internal integration secrets start with `ntn_` today,
 * older ones with `secret_`, and Notion documents neither prefix as stable nor the
 * shape of an OAuth access token at all. So the prefix is not checked. What is
 * checked is what keeps the value a single safe `Authorization` header — no
 * whitespace, no control characters, no `:` of a pasted link — and a sane length.
 */
const BEARER_TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;

/** A Notion access token's shape (personal, internal integration or OAuth): checked before anything is sent with it. */
export function isNotionToken(value: unknown): value is string {
  return typeof value === "string" && value.length >= 20 && value.length <= 500 && BEARER_TOKEN.test(value);
}

const CURSOR = /^[A-Za-z0-9_=+/-]{1,512}$/;

export type NotionFetchRequest =
  | { mode: "rows"; token: string; sourceId: string; cursor: string | null }
  | { mode: "pages"; token: string; pageIds: string[] };

/**
 * Validate the body. Every message names a field and never repeats its value:
 * the value of `token` is a credential.
 */
export function readNotionFetchRequest(body: Record<string, unknown>): NotionFetchRequest {
  if (!isNotionToken(body.token)) throw new NotionFetchRequestError("`token` must be a Notion access token: 20 to 500 characters with no spaces, such as a personal access token.");
  if (body.mode === "rows") {
    const sourceId = typeof body.source === "string" ? parseNotionId(body.source) : null;
    if (sourceId === null) throw new NotionFetchRequestError("`source` must be a Notion database link or its 32-character id.");
    if (body.cursor !== undefined && body.cursor !== null && (typeof body.cursor !== "string" || !CURSOR.test(body.cursor))) {
      throw new NotionFetchRequestError("`cursor` must be the cursor a previous response returned.");
    }
    return { mode: "rows", token: body.token, sourceId, cursor: typeof body.cursor === "string" ? body.cursor : null };
  }
  if (body.mode === "pages") {
    if (!Array.isArray(body.pageIds) || body.pageIds.length === 0 || body.pageIds.length > NOTION_FETCH_LIMITS.maxPageIds) {
      throw new NotionFetchRequestError(`\`pageIds\` must list between 1 and ${NOTION_FETCH_LIMITS.maxPageIds} page ids.`);
    }
    const pageIds: string[] = [];
    for (const raw of body.pageIds) {
      const id = typeof raw === "string" && raw.replaceAll("-", "").length === 32 ? parseNotionId(raw) : null;
      if (id === null) throw new NotionFetchRequestError("Every entry of `pageIds` must be a 32-character Notion page id.");
      if (!pageIds.includes(id)) pageIds.push(id);
    }
    return { mode: "pages", token: body.token, pageIds };
  }
  throw new NotionFetchRequestError("`mode` must be `rows` or `pages`.");
}

export type NotionFetchDeps = {
  fetchImpl: NotionFetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  limits?: Partial<typeof NOTION_FETCH_LIMITS>;
};

export type NotionRowsResult = { source: { id: string; title: string | null }; rows: NotionRow[]; cursor: string | null };
export type NotionPagesResult = {
  pages: { id: string; blocks: NotionBlockLike[] }[];
  issues: { id: string; code: NotionFetchIssueCode }[];
  /** Every id this slice finished with, carried or not; the browser sends the rest next. */
  done: string[];
  /** Set when Notion's rate limit ended the slice early: wait this long before the next one. */
  retryAfterSeconds?: number;
};

class DeadlineError extends Error {}

/** Translate a Notion failure into the endpoint's codes, keeping nothing of Notion's text. */
function requestFailure(error: unknown): NotionFetchError {
  if (error instanceof NotionFetchError) return error;
  if (error instanceof NotionApiError) {
    if (error.status === 401) return new NotionFetchError("NOTION_TOKEN_INVALID");
    if (error.status === 403 || error.status === 404) return new NotionFetchError("NOTION_NOT_SHARED");
    if (error.status === 429) return new NotionFetchError("NOTION_RATE_LIMITED", error.retryAfterSeconds ?? 30);
  }
  return new NotionFetchError("NOTION_UNAVAILABLE");
}

function setup(token: string, deps: NotionFetchDeps) {
  const limits = { ...NOTION_FETCH_LIMITS, ...deps.limits };
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const startedAt = now();
  const elapsed = () => now() - startedAt;
  const raw = notionCaller({
    token,
    fetchImpl: deps.fetchImpl,
    sleep,
    now,
    minIntervalMs: limits.minIntervalMs,
    includeNotionMessage: false,
    // Wait out a short Retry-After inside the request; a longer one ends the slice.
    onRateLimit: (seconds) => {
      const wait = (seconds ?? 1) * 1000;
      return wait <= limits.maxInlineRetryMs && elapsed() + wait < limits.startBudgetMs ? wait : null;
    },
  });
  const call: typeof raw = async (path, body) => {
    if (elapsed() >= limits.pageDeadlineMs) throw new DeadlineError();
    return raw(path, body);
  };
  return { limits, elapsed, call };
}

/** List a database's rows (properties only), up to the row and time budget. */
export async function fetchNotionRows(request: Extract<NotionFetchRequest, { mode: "rows" }>, deps: NotionFetchDeps): Promise<NotionRowsResult> {
  const { limits, elapsed, call } = setup(request.token, deps);
  try {
    const source = await resolveDataSource(request.sourceId, call);
    const rows: NotionRow[] = [];
    let cursor = request.cursor;
    do {
      const page = await queryRows(source.id, call, { cursor, pageSize: 100 });
      rows.push(...page.rows);
      cursor = page.nextCursor;
    } while (cursor !== null && rows.length < limits.maxRows && elapsed() < limits.startBudgetMs);
    return { source, rows, cursor };
  } catch (error) {
    throw requestFailure(error);
  }
}

/**
 * Read the blocks of the named pages, in order, until a budget runs out. A page
 * that cannot be carried is finished with an issue code; a token Notion refuses
 * ends the request, because every later page would be refused too.
 */
export async function fetchNotionPages(request: Extract<NotionFetchRequest, { mode: "pages" }>, deps: NotionFetchDeps): Promise<NotionPagesResult> {
  const { limits, elapsed, call } = setup(request.token, deps);
  const result: NotionPagesResult = { pages: [], issues: [], done: [] };
  let bytes = 0;
  const finish = (id: string, code: NotionFetchIssueCode) => { result.issues.push({ id, code }); result.done.push(id); };
  for (const id of request.pageIds) {
    if (result.done.length > 0 && (elapsed() >= limits.startBudgetMs || bytes >= limits.maxBytes)) break;
    try {
      const blocks = await collectBlocks(id, call, { pageSize: 100, maxBlocks: limits.maxBlocksPerPage });
      const size = Buffer.byteLength(JSON.stringify(blocks));
      if (size > limits.maxBytes) { finish(id, "page-too-large"); continue; }
      if (result.pages.length > 0 && bytes + size > limits.maxBytes) break; // the next slice carries it
      bytes += size;
      result.pages.push({ id, blocks });
      result.done.push(id);
    } catch (error) {
      if (error instanceof TooManyBlocksError) { finish(id, "too-many-blocks"); continue; }
      if (error instanceof DeadlineError) { finish(id, "fetch-timeout"); break; }
      if (error instanceof NotionApiError) {
        if (error.status === 401) throw new NotionFetchError("NOTION_TOKEN_INVALID");
        if (error.status === 429) {
          // Finished pages are kept; the browser waits and sends the rest.
          if (result.done.length === 0) throw requestFailure(error);
          result.retryAfterSeconds = error.retryAfterSeconds ?? 30;
          break;
        }
        if (error.status === 403 || error.status === 404) { finish(id, "page-unavailable"); continue; }
        if (error.status === 413) { finish(id, "page-too-large"); continue; }
      }
      finish(id, "fetch-failed");
    }
  }
  return result;
}
