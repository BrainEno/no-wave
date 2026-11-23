/**
 * Pulling a Notion database through our own API with a pasted token (ADR 0052).
 *
 * Notion's API does not answer browsers (no CORS), so the desk cannot call it
 * directly; `POST /api/authoring/notion-fetch` reads it for us one bounded slice at
 * a time and keeps nothing. Everything stateful lives here, in the browser: which
 * rows have been listed, which pages still need their blocks, when to wait out a
 * rate limit and when to stop. The result is the same `version: 1` bundle a JSON
 * export produces, so selection, batching, the dry run and the confirm are the
 * existing code paths and nothing about them is weakened.
 *
 * The token is a parameter of every call and is never stored, logged, or put into
 * a message: the messages below are fixed sentences keyed by the API's stable codes.
 */

export const NOTION_FETCH_ENDPOINT = "/api/authoring/notion-fetch";

/** Rows listed before the desk stops asking; a database larger than this is reported, not silently cut. */
export const NOTION_PULL_MAX_ROWS = 2000;
/** The API's own ceiling for one `pages` request. */
export const NOTION_PULL_PAGE_IDS = 200;
/** Rate-limit waits per pull before giving up; each wait is the server's Retry-After. */
export const NOTION_PULL_MAX_WAITS = 6;

/**
 * The same shape the API checks, so an obvious paste mistake (a link, a `Bearer `
 * prefix, a half-copied value) is caught before a request. The prefix is not
 * checked: Notion treats tokens as opaque, a personal access token and an internal
 * integration secret both start with `ntn_` today, and an OAuth access token's
 * shape is not documented. Only Notion can say whether a token is real.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9\-._~+/]+=*$/;

export function looksLikeNotionToken(value: string): boolean {
  const token = value.trim();
  return token.length >= 20 && token.length <= 500 && TOKEN_PATTERN.test(token);
}

/** One answer from the fetch endpoint, already parsed. */
export type FetchAnswer = { status: number; payload: unknown; retryAfter: string | null };
/** Sends one JSON body to the fetch endpoint; rejects only when the network fails. */
export type FetchPost = (body: Record<string, unknown>) => Promise<FetchAnswer>;

export type PullDeps = {
  post: FetchPost;
  /** Progress in the author's words, including rate-limit countdowns. */
  onProgress?: (message: string) => void;
  /** Checked between requests and every second of a countdown. */
  isStopped?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
};

export type PullFailure = { ok: false; message: string; stopped?: boolean };

export type NotionRowsPull = {
  ok: true;
  bundle: { version: 1; database: { id: string; title: string }; pages: Record<string, unknown>[] };
  /** Rows not listed because the database is larger than NOTION_PULL_MAX_ROWS. */
  truncated: boolean;
  /** Page id → Notion's `created_time`, kept beside the bundle for the optional date backfill. */
  created: Map<string, string>;
};

export type NotionPullIssue = { id: string; code: string };
export type NotionPagesPull = {
  ok: true;
  blocks: Map<string, unknown[]>;
  issues: NotionPullIssue[];
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dataOf(payload: unknown): Record<string, unknown> | null {
  return isRecord(payload) && isRecord(payload.data) ? payload.data : null;
}

function errorCode(payload: unknown): string | null {
  const code = isRecord(payload) && isRecord(payload.error) ? payload.error.code : null;
  return typeof code === "string" ? code : null;
}

/**
 * A refusal in the author's words. The API's own message is used only for a 400,
 * where it names the field (never its value); every Notion-side refusal has a fixed
 * sentence that says which step in Notion to fix.
 */
export function notionFetchFailureMessage(status: number, payload: unknown): string {
  const code = errorCode(payload);
  if (code === "NOTION_TOKEN_INVALID") return "Notion 不接受这个令牌：可能没有复制完整、已经过期或已被撤销。请在 Notion 里重新复制，或新建一个令牌。";
  if (code === "NOTION_NOT_SHARED") return "Notion 找不到这个数据库。请检查链接是否完整；用 Notion 授权时，确认在授权页里选中了它（或它的父页面）；用个人访问令牌时，确认你自己能在 Notion 里打开它；用内部集成时，在数据库右上角「…」→「连接」里添加这个集成。";
  if (code === "NOTION_UNAVAILABLE") return "暂时读不到 Notion，请稍后再试。";
  if (code === "NOTION_FETCH_DISABLED") return "本站暂时关闭了直接从 Notion 拉取，请改用「上传导出文件」。";
  if (code === "NOTION_RATE_LIMITED" || status === 429) return "请求过于频繁，已多次等待仍未恢复。请过几分钟再试。";
  if (status === 503) return "暂时无法拉取：本站同时进行的 Notion 拉取较多，或服务暂不可用。请过几分钟再试。";
  if (status === 401) return "登录状态已失效，请重新登录后再拉取。";
  if (status === 400) {
    const message = isRecord(payload) && isRecord(payload.error) ? payload.error.message : null;
    return typeof message === "string" ? `请求没有被接受：${message}` : "请求没有被接受，请检查令牌和链接。";
  }
  if (status === 0) return "网络中断，没有拉取完成。没有写入任何内容，可以直接重试。";
  return `拉取没有完成（HTTP ${status}）。没有写入任何内容，可以稍后重试。`;
}

/** Why a page was left out, as the import's warning list says it. */
export const NOTION_PULL_ISSUE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  "too-many-blocks": "超过 2000 个块，无法完整读取（不会截断导入）",
  "page-too-large": "正文超过 6 MB，无法一次读取",
  "fetch-timeout": "读取超时",
  "page-unavailable": "令牌无权访问或页面已删除",
  "fetch-failed": "读取失败",
});

/** Codes that may succeed on the next try; the rest would fail the same way again. */
export function isRetryableNotionIssue(code: string): boolean {
  return code === "fetch-timeout" || code === "fetch-failed";
}

/**
 * Send one request, waiting out 429s with the server's Retry-After. The wait is
 * shared across a whole pull so a pull that is throttled over and over gives up
 * with a sentence rather than counting down forever.
 */
async function send(body: Record<string, unknown>, deps: PullDeps, waits: { count: number }, label: string): Promise<FetchAnswer | PullFailure> {
  for (;;) {
    if (deps.isStopped?.()) return { ok: false, stopped: true, message: "已停止拉取，没有写入任何内容。" };
    let answer: FetchAnswer;
    try {
      answer = await deps.post(body);
    } catch {
      return { ok: false, message: notionFetchFailureMessage(0, null) };
    }
    // A 429 is a rate limit (ours or Notion's); a 503 with a Retry-After is the
    // API saying too many pulls are running right now. Both are waited out.
    if (answer.status !== 429 && !(answer.status === 503 && answer.retryAfter !== null)) return answer;
    if (waits.count >= NOTION_PULL_MAX_WAITS) return { ok: false, message: notionFetchFailureMessage(answer.status, answer.payload) };
    waits.count += 1;
    const header = Number.parseInt(answer.retryAfter ?? "", 10);
    if (await countdown(Number.isFinite(header) ? header : 30, deps, label) === null) return { ok: false, stopped: true, message: "已停止拉取，没有写入任何内容。" };
  }
}

async function countdown(requested: number, deps: PullDeps, label: string): Promise<number | null> {
  const sleep = deps.sleep ?? defaultSleep;
  const seconds = Math.min(Math.max(requested, 1), 900);
  for (let left = seconds; left > 0; left--) {
    if (deps.isStopped?.()) return null;
    deps.onProgress?.(`Notion 或本站限制了请求频率，${label}将在 ${left} 秒后自动继续…`);
    await sleep(1000);
  }
  return seconds;
}

/**
 * List every row of the database (properties only) and shape them into a bundle
 * whose pages have no blocks yet. Blocks are read later, only for the pages the
 * author keeps selected, which is most of the Notion traffic of a pull.
 */
export async function pullNotionRows(token: string, source: string, deps: PullDeps): Promise<NotionRowsPull | PullFailure> {
  const waits = { count: 0 };
  const pages: Record<string, unknown>[] = [];
  const created = new Map<string, string>();
  let database: { id: string; title: string } | null = null;
  let cursor: string | null = null;
  do {
    deps.onProgress?.(pages.length === 0 ? "正在读取 Notion 数据库的条目…" : `已读取 ${pages.length} 个条目，继续读取…`);
    const answer = await send({ token, mode: "rows", source, ...(cursor === null ? {} : { cursor }) }, deps, waits, "读取条目");
    if ("ok" in answer) return answer;
    const data = dataOf(answer.payload);
    if (answer.status !== 200 || data === null) return { ok: false, message: notionFetchFailureMessage(answer.status === 200 ? 502 : answer.status, answer.payload) };
    const sourceInfo = isRecord(data.source) ? data.source : null;
    if (database === null && sourceInfo !== null && typeof sourceInfo.id === "string") {
      database = { id: sourceInfo.id, title: typeof sourceInfo.title === "string" ? sourceInfo.title : "" };
    }
    const rows = Array.isArray(data.rows) ? data.rows : null;
    if (database === null || rows === null) return { ok: false, message: "拉取接口的响应格式不符合约定，请稍后重试。" };
    for (const row of rows) {
      if (!isRecord(row) || typeof row.id !== "string") continue;
      if (typeof row.createdTime === "string") created.set(row.id, row.createdTime);
      pages.push({
        id: row.id,
        properties: isRecord(row.properties) ? row.properties : {},
        blocks: [],
        ...(row.inTrash === true ? { inTrash: true } : {}),
        ...(row.archived === true ? { archived: true } : {}),
      });
    }
    const next: unknown = data.cursor;
    cursor = typeof next === "string" && next !== "" ? next : null;
  } while (cursor !== null && pages.length < NOTION_PULL_MAX_ROWS);
  return {
    ok: true,
    bundle: { version: 1, database: database ?? { id: "", title: "" }, pages: pages.slice(0, NOTION_PULL_MAX_ROWS) },
    truncated: cursor !== null || pages.length > NOTION_PULL_MAX_ROWS,
    created,
  };
}

/**
 * Read the blocks of `ids`, a slice at a time. Each answer says which ids it
 * finished (`done`) — read or reported — and the rest are asked for again, so the
 * server never has to remember a pull. An answer that finishes nothing and asks
 * for no wait is a broken contract, not a reason to loop.
 */
export async function pullNotionPages(token: string, ids: readonly string[], deps: PullDeps): Promise<NotionPagesPull | PullFailure> {
  const waits = { count: 0 };
  const blocks = new Map<string, unknown[]>();
  const issues: NotionPullIssue[] = [];
  let remaining = [...new Set(ids)];
  const total = remaining.length;
  while (remaining.length > 0) {
    deps.onProgress?.(`正在读取正文：${total - remaining.length} / ${total} 页…`);
    const slice = remaining.slice(0, NOTION_PULL_PAGE_IDS);
    const answer = await send({ token, mode: "pages", pageIds: slice }, deps, waits, "读取正文");
    if ("ok" in answer) return answer;
    const data = dataOf(answer.payload);
    if (answer.status !== 200 || data === null) return { ok: false, message: notionFetchFailureMessage(answer.status === 200 ? 502 : answer.status, answer.payload) };
    const asked = new Set(slice);
    for (const page of Array.isArray(data.pages) ? data.pages : []) {
      if (isRecord(page) && typeof page.id === "string" && asked.has(page.id) && Array.isArray(page.blocks)) blocks.set(page.id, page.blocks);
    }
    for (const issue of Array.isArray(data.issues) ? data.issues : []) {
      if (isRecord(issue) && typeof issue.id === "string" && asked.has(issue.id) && typeof issue.code === "string") issues.push({ id: issue.id, code: issue.code });
    }
    const done = new Set((Array.isArray(data.done) ? data.done : []).filter((id): id is string => typeof id === "string" && asked.has(id)));
    // An id reported done but carried neither as a page nor as an issue would
    // vanish from the import without a word; name it instead.
    for (const id of done) if (!blocks.has(id) && !issues.some((issue) => issue.id === id)) issues.push({ id, code: "fetch-failed" });
    remaining = remaining.filter((id) => !done.has(id));
    const retryAfter = typeof data.retryAfterSeconds === "number" ? data.retryAfterSeconds : null;
    if (retryAfter !== null && remaining.length > 0) {
      if (waits.count >= NOTION_PULL_MAX_WAITS) return { ok: false, message: notionFetchFailureMessage(429, null) };
      waits.count += 1;
      if (await countdown(retryAfter, deps, "读取正文") === null) return { ok: false, stopped: true, message: "已停止拉取，没有写入任何内容。" };
    } else if (done.size === 0) {
      return { ok: false, message: "拉取接口没有返回任何进度，请稍后重试。" };
    }
  }
  deps.onProgress?.(`正在读取正文：${total} / ${total} 页…`);
  return { ok: true, blocks, issues };
}

/** The bundle with the given pages' blocks filled in; pages and order are unchanged. */
export function withPulledBlocks(bundle: Record<string, unknown>, blocks: ReadonlyMap<string, unknown[]>): Record<string, unknown> {
  if (!Array.isArray(bundle.pages) || blocks.size === 0) return bundle;
  return {
    ...bundle,
    pages: bundle.pages.map((page: unknown) => isRecord(page) && typeof page.id === "string" && blocks.has(page.id) ? { ...page, blocks: blocks.get(page.id) } : page),
  };
}

/** A `FetchPost` over the desk's own proxy. */
export function proxyFetchPost(fetchImpl: typeof fetch = fetch): FetchPost {
  return async (body) => {
    const response = await fetchImpl(NOTION_FETCH_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify(body),
    });
    return { status: response.status, payload: await response.json().catch(() => null), retryAfter: response.headers.get("retry-after") };
  };
}
