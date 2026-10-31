import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

/**
 * Deterministic stand-in for the versioned REST API.
 *
 * The prototype talks to a real HTTP server rather than an injected fake, so the
 * tests exercise the same `fetch` path, cookie handling and status mapping that a
 * live API would produce. Payload shapes mirror the documented REST contract that
 * `apps/web/src/lib/api-content.ts` already parses:
 * `{ data: ... }` envelopes, `{ error: { code, message } }` failures.
 *
 * Deliberately not a general-purpose mock: it serves the two articles and the
 * three auth endpoints the prototype needs, and nothing else.
 */

export const MOCK_CREDENTIALS = {
  email: "writer@example.test",
  password: "correct-horse-battery",
} as const;

export const MOCK_TOKENS = {
  // `isTokenEnvelope` requires an access token longer than 30 characters and a
  // 43-character base64url refresh token; these satisfy the real policy check.
  accessToken: `mock-access-token-${"0".repeat(20)}`,
  refreshToken: "r".repeat(43),
} as const;

export const MOCK_DISPLAY_NAME = "林可行";

/**
 * `GET /api/v1/me` — the account, exactly as the real API answers it.
 *
 * `null` while unverified, which is the state the account page has to render
 * its "send the verification mail" action for.
 */
export const MOCK_EMAIL_VERIFIED_AT: string | null = null;

export const MOCK_AUTHOR = { username: "writer", bio: "在无浪潮写作。" } as const;

/**
 * One seeded comment per article.
 *
 * Comments are the only interactive, state-changing surface on a migrated public
 * page (Phase 4a), so the mock has to model both halves of it: a readable thread
 * and a write that requires a session. `MOCK_COMMENT_ID` is exported so a test
 * can assert on a specific comment without depending on the text.
 */
export const MOCK_COMMENT_ID = "9c1f0a52-3d4e-4f7a-8b21-5e6d7c8a9b01";

const MOCK_COMMENTS: Record<string, { id: string; body: Record<"zh-CN" | "en", string>; createdAt: string }> = {
  "portable-web-foundation": {
    id: MOCK_COMMENT_ID,
    body: { "zh-CN": "这篇把托管成本讲得很清楚。", en: "This lays out the hosting costs clearly." },
    createdAt: "2026-10-02T08:30:00.000Z",
  },
};

/**
 * A 1x1 WebP and its content hash.
 *
 * Media objects are content-addressed in the API (the SHA-256 is the ETag), so
 * the mock must produce a stable ETag too — otherwise conditional requests and
 * immutable caching could not be asserted.
 */
const MOCK_MEDIA_BYTES = Buffer.from(
  "UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==",
  "base64",
);
export const MOCK_MEDIA = {
  id: "3f7c1d90-8a2b-4c1e-9f3a-6c5b2e8d1a44",
  contentType: "image/webp",
  etag: `"${createHash("sha256").update(MOCK_MEDIA_BYTES).digest("hex")}"`,
  bytes: MOCK_MEDIA_BYTES,
} as const;

/**
 * The writing desk's own store (Phase 4b).
 *
 * The mock is deliberately not a general-purpose API, but the desk is the one
 * surface where a read and a write have to agree with each other: a created work
 * must appear in the author's list, and saving it again must update that row
 * instead of appending a second one. So authored works are kept in memory for
 * the lifetime of the process, seeded from the published catalogue — which is
 * what makes "the desk lists what this author wrote" assertable at all.
 */
type AuthoredArticle = {
  id: string;
  slug: string;
  title: string;
  summary: string;
  locale: string;
  workType: string;
  status: "draft" | "published";
  contentBlocks: unknown[];
  contentBlocksVersion: number;
  publishedAt: string | null;
  updatedAt: string;
  /** Set when the work is deleted, cleared again when it is restored. */
  deletedAt?: string | null;
};

/** Fixed ids so a test can name one without depending on the insertion order. */
export const MOCK_AUTHORED_IDS: readonly string[] = Object.freeze([
  "1f0b7c2e-5a4d-4c8b-9e13-7a6d5c4b3a21",
  "2a1c8d3f-6b5e-4d9c-8f24-8b7e6d5c4b32",
]);

const AUTHORED: AuthoredArticle[] = [];

/** The mock's retention window, in days; the API's own default. */
const MOCK_RETENTION_DAYS = 30;

/**
 * Comments written through the mock, counted by slug.
 *
 * The recycle bin reports how many comments a tombstone still carries, because
 * the sweep takes them with it. A mock that always answered zero would let the
 * desk display a number nobody had ever checked.
 */
const MOCK_COMMENT_COUNTS = new Map<string, number>();

/**
 * The mock's notification inbox.
 *
 * The API writes each commenter a notice when a work they commented on is
 * deleted, and the mock cannot produce one: it has a single account, and an
 * author is never notified of their own deletion. So this notice is a fixture,
 * standing in for a message another author's deletion would have sent. The
 * *rule* is tested against the real API (and, end to end, in `e2e/`); what the
 * prototype needs from it is the screen, and the endpoints below are real —
 * they count, mark and clear notices exactly as the API does.
 *
 * The purge date is computed from the mock's own retention window, so the date
 * the inbox shows is the same window the recycle bin is using.
 */
export type MockNotification = {
  id: string;
  eventKey: string;
  payload: string;
  createdAt: string;
  readAt: string | null;
};

export const MOCK_DELETED_ARTICLE_ID = "7b1c9d2e-3f4a-4b5c-8d6e-9f0a1b2c3d4e";

export const MOCK_NOTIFICATION: MockNotification = Object.freeze({
  id: "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f",
  eventKey: `article.deleted:${MOCK_DELETED_ARTICLE_ID}:writer`,
  payload: JSON.stringify({
    type: "article.deleted",
    articleId: MOCK_DELETED_ARTICLE_ID,
    purgesAt: new Date(Date.now() + MOCK_RETENTION_DAYS * 86_400_000).toISOString(),
  }),
  createdAt: new Date().toISOString(),
  readAt: null,
});

/** Newest first, and mutable: marking a notice read is the point of the inbox. */
const MOCK_NOTIFICATIONS: MockNotification[] = [{ ...MOCK_NOTIFICATION }];

/**
 * Put every notice back to unread.
 *
 * The mock's inbox is process-wide, and the tests that mark a notice read must
 * not depend on which of them ran first.
 */
export function resetMockNotifications(): void {
  for (const notice of MOCK_NOTIFICATIONS) notice.readAt = null;
}

/** Newest first, like the API's author list. */
function authoredPayload(article: AuthoredArticle) {
  return { ...article };
}

/**
 * A crude slug: lowercase ASCII, dashes for everything else, capped at 60
 * characters, with the API's own `article-<hex>` fallback for a title that has
 * no ASCII letters or digits in it (a Chinese title, for instance). The real
 * transliteration is the API's job; the mock only needs a stable, valid-looking
 * address that a test can assert against.
 */
function authoredSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : `article-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

/**
 * The mock's stand-in for the API's Lexical adapter: one paragraph block holding
 * the document's text. Enough for the desk to round-trip a body without
 * reimplementing the adapter — the conversion itself is asserted in the API's
 * own tests.
 */
function blocksFromEditorState(editorState: unknown): unknown[] {
  let text = "";
  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    const item = node as { type?: unknown; text?: unknown; children?: unknown };
    if (item.type === "text" && typeof item.text === "string") text += item.text;
    if (Array.isArray(item.children)) item.children.forEach(visit);
  };
  visit((editorState as { root?: unknown } | null)?.root);
  return text.trim().length > 0 ? [{ id: randomUUID(), type: "paragraph", text }] : [];
}

type MockArticle = {
  slug: string;
  workType: string;
  publishedAt: string;
  title: Record<"zh-CN" | "en", string>;
  summary: Record<"zh-CN" | "en", string>;
  blocks: Record<"zh-CN" | "en", unknown[]>;
};

const ARTICLES: MockArticle[] = [
  {
    slug: "portable-web-foundation",
    workType: "essay",
    publishedAt: "2026-10-01T09:00:00.000Z",
    title: { "zh-CN": "可移植的文学基础设施", en: "A Portable Literary Foundation" },
    summary: { "zh-CN": "从框架依赖中取回叙事自主权的实践记录。", en: "Notes on taking narrative sovereignty back from framework lock-in." },
    blocks: {
      "zh-CN": [
        { id: "b1", type: "paragraph", text: "文学网站的命运不该与某一家托管的生命周期绑定。" },
        { id: "b2", type: "heading", level: 2, text: "为什么是可移植性" },
        { id: "b3", type: "paragraph", text: "服务端渲染、标准 Node 运行时与独立的 REST API，三者共同构成了可迁移的底线。" },
        { id: "b4", type: "quote", text: "先把事实写进数据库，再谈渲染。", attribution: "架构备忘" },
        { id: "b5", type: "list", ordered: false, items: ["服务端渲染的公开页面", "客户端交互的写作台", "可作为纯 Node 进程启动"] },
        // A second level-2 heading: the table of contents only appears from two
        // headings on, and it is one of the interactive parts under test.
        { id: "b6", type: "heading", level: 2, text: "可移植性的代价" },
      ],
      en: [
        { id: "b1", type: "paragraph", text: "A literary site should not tie its fate to one host's lifecycle." },
        { id: "b2", type: "heading", level: 2, text: "Why portability" },
        { id: "b3", type: "paragraph", text: "Server rendering, a standard Node runtime and a standalone REST API form the floor." },
        { id: "b4", type: "heading", level: 2, text: "The cost of portability" },
      ],
    },
  },
  {
    slug: "reading-as-resistance",
    workType: "short_story",
    publishedAt: "2026-09-20T12:30:00.000Z",
    title: { "zh-CN": "作为抵抗的阅读", en: "Reading as Resistance" },
    summary: { "zh-CN": "关于慢下来的短篇。", en: "A short story about slowing down." },
    blocks: {
      "zh-CN": [{ id: "b1", type: "paragraph", text: "她把书翻到第七十页，然后停下了。" }],
      en: [{ id: "b1", type: "paragraph", text: "She turned to page seventy and stopped." }],
    },
  },
];

type MockCategory = {
  slug: string;
  names: Record<"zh-CN" | "en", string>;
  descriptions: Record<"zh-CN" | "en", string>;
  articleSlugs: string[];
};

const CATEGORIES: MockCategory[] = [
  {
    slug: "essays",
    names: { "zh-CN": "随笔", en: "Essays" },
    descriptions: {
      "zh-CN": "关于出版、写作与基础设施的长文与短论。",
      en: "Long-form and short-form writing about publishing, writing and infrastructure.",
    },
    articleSlugs: ["portable-web-foundation"],
  },
  {
    slug: "fiction",
    names: { "zh-CN": "小说", en: "Fiction" },
    descriptions: { "zh-CN": "虚构作品：短篇、连载与长篇节选。", en: "Short stories, serials and novel excerpts." },
    articleSlugs: ["reading-as-resistance"],
  },
];

function categoryPayload(category: MockCategory, locale: "zh-CN" | "en") {
  const articles = category.articleSlugs
    .map((slug) => ARTICLES.find((candidate) => candidate.slug === slug))
    .filter((article): article is MockArticle => Boolean(article));
  return {
    slug: category.slug,
    name: category.names[locale],
    description: category.descriptions[locale],
    locale,
    articleCount: articles.length,
  };
}

// Seeded from the published catalogue so "the desk lists what this author
// wrote" is assertable from a cold mock.
for (const [index, article] of ARTICLES.entries()) {
  AUTHORED.push({
    id: MOCK_AUTHORED_IDS[index] ?? randomUUID(),
    slug: article.slug,
    title: article.title["zh-CN"],
    summary: article.summary["zh-CN"],
    locale: "zh-CN",
    workType: article.workType,
    status: "published",
    contentBlocks: article.blocks["zh-CN"] as unknown[],
    contentBlocksVersion: 1,
    publishedAt: article.publishedAt,
    updatedAt: article.publishedAt,
  });
}

function articlePayload(article: MockArticle, locale: "zh-CN" | "en") {
  return {
    slug: article.slug,
    title: article.title[locale],
    summary: article.summary[locale],
    workType: article.workType,
    contentBlocks: article.blocks[locale],
    publishedAt: article.publishedAt,
    updatedAt: article.publishedAt,
    author: { userId: "writer", displayName: MOCK_DISPLAY_NAME, bio: "在无浪潮写作。" },
    categories: [{ name: "随笔" }],
    tags: [{ name: locale === "en" ? "portability" : "可移植性" }],
  };
}

function localeOf(url: URL): "zh-CN" | "en" {
  return url.searchParams.get("locale") === "en" ? "en" : "zh-CN";
}

/** Title/summary substring match, case-insensitive, mirroring the API's `query`. */
function matchesQuery(article: MockArticle, locale: "zh-CN" | "en", query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return article.title[locale].toLocaleLowerCase().includes(needle) ||
    article.summary[locale].toLocaleLowerCase().includes(needle);
}

function paginated<T>(items: T[], url: URL): T[] {
  const limit = Number(url.searchParams.get("limit") ?? items.length);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const size = Number.isFinite(limit) ? limit : items.length;
  return items.slice(offset, offset + size);
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  response.end(text);
}

function tokenEnvelope() {
  const now = Date.now();
  return {
    data: {
      accessToken: MOCK_TOKENS.accessToken,
      refreshToken: MOCK_TOKENS.refreshToken,
      tokenType: "Bearer",
      accessExpiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
      refreshExpiresAt: new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString(),
    },
  };
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function handle(request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>): void {
  const url = new URL(request.url ?? "/", "http://mock.invalid");
  const method = request.method ?? "GET";
  const path = url.pathname;
  const locale = localeOf(url);

  if (method === "GET" && path === "/api/v1/articles") {
    const query = url.searchParams.get("query") ?? "";
    const page = paginated(ARTICLES.filter((article) => matchesQuery(article, locale, query)), url);
    send(response, 200, { data: page.map((article) => articlePayload(article, locale)) });
    return;
  }

  const authorArticles = /^\/api\/v1\/authors\/([^/]+)\/articles$/.exec(path);
  if (method === "GET" && authorArticles) {
    const username = decodeURIComponent(authorArticles[1] ?? "");
    if (username !== MOCK_AUTHOR.username) {
      send(response, 404, { error: { code: "NOT_FOUND", message: "Author not found." } });
      return;
    }
    const query = url.searchParams.get("query") ?? "";
    const page = paginated(ARTICLES.filter((article) => matchesQuery(article, locale, query)), url);
    send(response, 200, { data: page.map((article) => articlePayload(article, locale)) });
    return;
  }

  const authorDetail = /^\/api\/v1\/authors\/([^/]+)$/.exec(path);
  if (method === "GET" && authorDetail) {
    const username = decodeURIComponent(authorDetail[1] ?? "");
    if (username !== MOCK_AUTHOR.username) {
      send(response, 404, { error: { code: "NOT_FOUND", message: "Author not found." } });
      return;
    }
    send(response, 200, { data: { userId: MOCK_AUTHOR.username, displayName: MOCK_DISPLAY_NAME, bio: MOCK_AUTHOR.bio } });
    return;
  }

  if (method === "GET" && path === "/api/v1/categories") {
    const query = (url.searchParams.get("query") ?? "").trim().toLocaleLowerCase();
    const matched = CATEGORIES.filter((category) => !query ||
      category.names[locale].toLocaleLowerCase().includes(query) ||
      category.descriptions[locale].toLocaleLowerCase().includes(query));
    send(response, 200, { data: paginated(matched, url).map((category) => categoryPayload(category, locale)) });
    return;
  }

  const categoryArticles = /^\/api\/v1\/categories\/([^/]+)\/articles$/.exec(path);
  if (method === "GET" && categoryArticles) {
    const slug = decodeURIComponent(categoryArticles[1] ?? "");
    const category = CATEGORIES.find((candidate) => candidate.slug === slug);
    if (!category) {
      send(response, 404, { error: { code: "NOT_FOUND", message: "Category not found." } });
      return;
    }
    const articles = category.articleSlugs
      .map((articleSlug) => ARTICLES.find((candidate) => candidate.slug === articleSlug))
      .filter((article): article is MockArticle => Boolean(article));
    send(response, 200, { data: paginated(articles, url).map((article) => articlePayload(article, locale)) });
    return;
  }

  const categoryDetail = /^\/api\/v1\/categories\/([^/]+)$/.exec(path);
  if (method === "GET" && categoryDetail) {
    const slug = decodeURIComponent(categoryDetail[1] ?? "");
    const category = CATEGORIES.find((candidate) => candidate.slug === slug);
    if (!category) {
      send(response, 404, { error: { code: "NOT_FOUND", message: "Category not found." } });
      return;
    }
    send(response, 200, { data: categoryPayload(category, locale) });
    return;
  }

  const detail = /^\/api\/v1\/articles\/([^/]+)$/.exec(path);
  if (method === "GET" && detail) {
    const slug = decodeURIComponent(detail[1] ?? "");
    const article = ARTICLES.find((candidate) => candidate.slug === slug);
    if (!article) {
      send(response, 404, { error: { code: "NOT_FOUND", message: "Article not found." } });
      return;
    }
    send(response, 200, { data: articlePayload(article, locale) });
    return;
  }

  const commentList = /^\/api\/v1\/articles\/([^/]+)\/comments$/.exec(path);
  if (commentList) {
    const slug = decodeURIComponent(commentList[1] ?? "");
    // A work written through the desk is commentable too, while it is published:
    // the mock answers for the two registries the way the API answers for one
    // table, and a draft or a tombstone is still not a public thread.
    const article = ARTICLES.find((candidate) => candidate.slug === slug)
      ?? AUTHORED.find((candidate) => candidate.slug === slug && candidate.status === "published" && !candidate.deletedAt);
    if (!article) {
      send(response, 404, { error: { code: "NOT_FOUND", message: "Article not found." } });
      return;
    }
    if (method === "GET") {
      const seeded = MOCK_COMMENTS[slug];
      const data = seeded
        ? [{
            id: seeded.id,
            body: seeded.body[locale],
            createdAt: seeded.createdAt,
            author: { userId: MOCK_AUTHOR.username, displayName: MOCK_DISPLAY_NAME, username: MOCK_AUTHOR.username },
            replies: [],
          }]
        : [];
      send(response, 200, { data });
      return;
    }
    if (method !== "POST") {
      send(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." } });
      return;
    }
    // Writing a comment requires a session: the access token travels in an
    // HttpOnly cookie, so it is the proxy — never the browser — that sets it.
    if (!request.headers.authorization) {
      send(response, 401, { error: { code: "UNAUTHENTICATED", message: "Sign in to comment." } });
      return;
    }
    const content = typeof body.body === "string" ? body.body.trim() : "";
    if (!content) {
      send(response, 400, { error: { code: "BAD_USER_INPUT", message: "Comment is empty." } });
      return;
    }
    MOCK_COMMENT_COUNTS.set(slug, (MOCK_COMMENT_COUNTS.get(slug) ?? 0) + 1);
    send(response, 201, {
      data: {
        id: "d2e3f4a5-6b7c-4d8e-9f01-2a3b4c5d6e7f",
        body: content,
        createdAt: new Date().toISOString(),
        author: { userId: MOCK_AUTHOR.username, displayName: MOCK_DISPLAY_NAME, username: MOCK_AUTHOR.username },
        replies: [],
      },
    });
    return;
  }

  if (method === "POST" && (path === "/api/v1/auth/login" || path === "/api/v1/auth/register")) {
    const email = typeof body.email === "string" ? body.email : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (path === "/api/v1/auth/register" && password.length < 12) {
      send(response, 400, { error: { code: "BAD_USER_INPUT", message: "密码至少需要 12 个字符。" } });
      return;
    }
    if (email !== MOCK_CREDENTIALS.email || password !== MOCK_CREDENTIALS.password) {
      send(response, 401, { error: { code: "INVALID_CREDENTIALS", message: "邮箱或密码不正确。" } });
      return;
    }
    send(response, path.endsWith("register") ? 201 : 200, tokenEnvelope());
    return;
  }

  if (method === "POST" && path === "/api/v1/auth/logout") {
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
    return;
  }

  /**
   * Recovery and verification. The real API answers `202` for "a link is on its
   * way" and never says whether the address exists, so the mock does the same —
   * a prototype that echoed "no such account" would be testing a behaviour the
   * product deliberately does not have.
   */
  if (method === "POST" && path === "/api/v1/auth/forgot-password") {
    send(response, 202, { data: { ok: true } });
    return;
  }

  if (method === "POST" && path === "/api/v1/auth/reset-password") {
    if (typeof body.token !== "string" || body.token.length === 0 || typeof body.password !== "string" || body.password.length < 12) {
      send(response, 400, { error: { code: "BAD_USER_INPUT", message: "The token or password is not acceptable." } });
      return;
    }
    send(response, 200, { data: { ok: true } });
    return;
  }

  if (method === "POST" && path === "/api/v1/auth/verify-email") {
    if (typeof body.token !== "string" || body.token.length === 0) {
      send(response, 400, { error: { code: "BAD_USER_INPUT", message: "The token is not acceptable." } });
      return;
    }
    send(response, 200, { data: { ok: true, alreadyVerified: false } });
    return;
  }

  const mediaDetail = /^\/api\/v1\/media\/([^/]+)$/.exec(path);
  if (method === "GET" && mediaDetail) {
    const id = decodeURIComponent(mediaDetail[1] ?? "");
    if (id !== MOCK_MEDIA.id) {
      send(response, 404, { error: { code: "NOT_FOUND", message: "The requested media asset was not found." } });
      return;
    }
    if (request.headers["if-none-match"] === MOCK_MEDIA.etag) {
      response.writeHead(304, { "cache-control": "public, max-age=31536000, immutable", etag: MOCK_MEDIA.etag });
      response.end();
      return;
    }
    response.writeHead(200, {
      "content-type": MOCK_MEDIA.contentType,
      "content-length": MOCK_MEDIA.bytes.byteLength,
      "cache-control": "public, max-age=31536000, immutable",
      etag: MOCK_MEDIA.etag,
    });
    response.end(MOCK_MEDIA.bytes);
    return;
  }

  if (method === "POST" && path === "/api/v1/me/media") {
    const authorization = request.headers.authorization ?? "";
    if (authorization !== `Bearer ${MOCK_TOKENS.accessToken}`) {
      send(response, 401, { error: { code: "UNAUTHENTICATED", message: "Please sign in again." } });
      return;
    }
    send(response, 201, {
      data: { id: MOCK_MEDIA.id, contentType: "image/webp", byteSize: MOCK_MEDIA.bytes.byteLength, sha256: MOCK_MEDIA.etag.slice(1, -1) },
    });
    return;
  }

  if (path === "/api/v1/me/articles") {
    if (method !== "GET") {
      send(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." } });
      return;
    }
    if (request.headers.authorization !== `Bearer ${MOCK_TOKENS.accessToken}`) {
      send(response, 401, { error: { code: "UNAUTHENTICATED", message: "Please sign in again." } });
      return;
    }
    // A deleted work leaves the desk, exactly as it does behind the real API.
    send(response, 200, { data: AUTHORED.filter((article) => !article.deletedAt).map(authoredPayload) });
    return;
  }

  if (path === "/api/v1/me/articles/deleted") {
    if (method !== "GET") {
      send(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." } });
      return;
    }
    if (request.headers.authorization !== `Bearer ${MOCK_TOKENS.accessToken}`) {
      send(response, 401, { error: { code: "UNAUTHENTICATED", message: "Please sign in again." } });
      return;
    }
    // The mock mirrors the API's contract, not its storage: the desk depends on
    // a tombstone carrying its deletion time and an expiry the desk can show.
    send(response, 200, {
      data: AUTHORED.filter((article) => Boolean(article.deletedAt))
        .map((article) => ({
          ...authoredPayload(article),
          purgesAt: new Date(new Date(article.deletedAt as string).getTime() + MOCK_RETENTION_DAYS * 86_400_000).toISOString(),
          commentCount: MOCK_COMMENT_COUNTS.get(article.slug) ?? 0,
        })),
    });
    return;
  }

  if (method === "POST" && path === "/api/v1/articles") {
    if (request.headers.authorization !== `Bearer ${MOCK_TOKENS.accessToken}`) {
      send(response, 401, { error: { code: "UNAUTHENTICATED", message: "Please sign in again." } });
      return;
    }
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) {
      send(response, 400, { error: { code: "BAD_USER_INPUT", message: "标题不能为空。" } });
      return;
    }
    const blocks = Array.isArray(body.contentBlocks) ? body.contentBlocks : blocksFromEditorState(body.editorState);
    if (blocks.length === 0) {
      send(response, 400, { error: { code: "BAD_USER_INPUT", message: "正文不能为空。" } });
      return;
    }
    const publish = body.publish === true;
    const now = new Date().toISOString();
    const article: AuthoredArticle = {
      id: randomUUID(),
      slug: authoredSlug(title),
      title,
      summary: typeof body.summary === "string" ? body.summary : "",
      locale: "zh-CN",
      workType: typeof body.workType === "string" ? body.workType : "other",
      status: publish ? "published" : "draft",
      contentBlocks: blocks,
      contentBlocksVersion: 1,
      publishedAt: publish ? now : null,
      updatedAt: now,
    };
    AUTHORED.unshift(article);
    send(response, 201, { data: article });
    return;
  }

  const authoredArticle = /^\/api\/v1\/articles\/([^/]+)$/.exec(path);
  if (method === "PUT" && authoredArticle) {
    if (request.headers.authorization !== `Bearer ${MOCK_TOKENS.accessToken}`) {
      send(response, 401, { error: { code: "UNAUTHENTICATED", message: "Please sign in again." } });
      return;
    }
    const id = decodeURIComponent(authoredArticle[1] ?? "");
    const existing = AUTHORED.find((item) => item.id === id);
    if (!existing) {
      send(response, 404, { error: { code: "NOT_FOUND", message: "The article was not found." } });
      return;
    }
    const blocks = Array.isArray(body.contentBlocks)
      ? body.contentBlocks
      : body.editorState === undefined
        ? existing.contentBlocks
        : blocksFromEditorState(body.editorState);
    if (blocks.length === 0) {
      send(response, 400, { error: { code: "BAD_USER_INPUT", message: "正文不能为空。" } });
      return;
    }
    const publish = body.publish === true;
    if (typeof body.title === "string" && body.title.trim()) existing.title = body.title.trim();
    if (typeof body.summary === "string") existing.summary = body.summary;
    if (typeof body.workType === "string") existing.workType = body.workType;
    existing.contentBlocks = blocks;
    // An update publishes, but only an explicit `publish: false` unpublishes and
    // only in the mock's terms: the real rule lives in the API's article store.
    if (body.publish !== undefined) existing.status = publish ? "published" : "draft";
    // The store's rule for `published_at`: publishing keeps the date a work
    // already has, withdrawing clears it, so a work published again after a
    // withdrawal carries a **new** date. The mock mirrors all three, so a test
    // that reads the date here is reading the API's rule, not a mock's habit.
    if (!publish) existing.publishedAt = null;
    if (publish && !existing.publishedAt) existing.publishedAt = new Date().toISOString();
    existing.updatedAt = new Date().toISOString();
    send(response, 200, { data: authoredPayload(existing) });
    return;
  }

  if (method === "DELETE" && authoredArticle) {
    if (request.headers.authorization !== `Bearer ${MOCK_TOKENS.accessToken}`) {
      send(response, 401, { error: { code: "UNAUTHENTICATED", message: "Please sign in again." } });
      return;
    }
    const id = decodeURIComponent(authoredArticle[1] ?? "");
    const existing = AUTHORED.find((item) => item.id === id);
    if (!existing) {
      send(response, 404, { error: { code: "NOT_FOUND", message: "The article was not found." } });
      return;
    }
    // The row stays, as a tombstone: the desk now depends on the recycle bin, so
    // a mock that dropped the row would be standing in for a contract the desk
    // no longer uses. The window itself is the API's business.
    if (existing.deletedAt) {
      send(response, 404, { error: { code: "NOT_FOUND", message: "The article was not found." } });
      return;
    }
    existing.deletedAt = new Date().toISOString();
    existing.status = "draft";
    send(response, 200, { data: { id, deletedAt: existing.deletedAt } });
    return;
  }

  if (method === "POST" && /^\/api\/v1\/articles\/([^/]+)\/restore$/.test(path)) {
    if (request.headers.authorization !== `Bearer ${MOCK_TOKENS.accessToken}`) {
      send(response, 401, { error: { code: "UNAUTHENTICATED", message: "Please sign in again." } });
      return;
    }
    const id = decodeURIComponent((/^\/api\/v1\/articles\/([^/]+)\/restore$/.exec(path) as RegExpExecArray)[1] ?? "");
    const existing = AUTHORED.find((item) => item.id === id);
    // Not a tombstone — an unknown id, a live work or a second restore are all
    // the same answer, so nothing here can be used to probe what exists.
    if (!existing || !existing.deletedAt) {
      send(response, 404, { error: { code: "NOT_FOUND", message: "The article was not found." } });
      return;
    }
    existing.deletedAt = null;
    existing.updatedAt = new Date().toISOString();
    send(response, 200, { data: authoredPayload(existing) });
    return;
  }

  if (method === "GET" && path === "/api/v1/me") {
    const authorization = request.headers.authorization ?? "";
    if (authorization !== `Bearer ${MOCK_TOKENS.accessToken}`) {
      send(response, 401, { error: { code: "UNAUTHENTICATED", message: "Please sign in again." } });
      return;
    }
    // Exactly the real API's shape: `GET /api/v1/me` answers the account, and
    // the author's display name is not part of it (that lives in the profile).
    send(response, 200, {
      data: { id: "writer", email: MOCK_CREDENTIALS.email, emailVerifiedAt: MOCK_EMAIL_VERIFIED_AT },
    });
    return;
  }

  /**
   * `PUT /api/v1/me/email` — moving the account to another address.
   *
   * The mock keeps the rules the real contract has: the current password must
   * match, the address must be one the mock is willing to hand out, and a
   * different one standing in for "already taken" is a conflict. The answer
   * carries the address and its verification state, which is what the account
   * page shows without asking again.
   */
  if (path === "/api/v1/me/email") {
    if (method !== "PUT") {
      send(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." } });
      return;
    }
    if (request.headers.authorization !== `Bearer ${MOCK_TOKENS.accessToken}`) {
      send(response, 401, { error: { code: "UNAUTHENTICATED", message: "Please sign in again." } });
      return;
    }
    const password = typeof body.password === "string" ? body.password : "";
    const email = typeof body.email === "string" ? body.email : "";
    if (Object.keys(body).length !== 2 || password !== MOCK_CREDENTIALS.password || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      send(response, 400, { error: { code: "BAD_USER_INPUT", message: "The request input is invalid." } });
      return;
    }
    if (email === "taken@example.test") {
      send(response, 409, { error: { code: "CONFLICT", message: "The request conflicts with the current resource state." } });
      return;
    }
    send(response, 200, { data: { ok: true, email, emailVerifiedAt: null } });
    return;
  }

  /**
   * `PUT /api/v1/me/password` — changing the password from inside a session.
   *
   * The mock keeps the two rules the real contract has: the current password
   * must be the mock credential (a session alone is not enough), and the new one
   * must be a credential worth storing. It also answers with the number of other
   * devices it signed out, which is the one field the account page shows.
   */
  if (path === "/api/v1/me/password") {
    if (method !== "PUT") {
      send(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." } });
      return;
    }
    if (request.headers.authorization !== `Bearer ${MOCK_TOKENS.accessToken}`) {
      send(response, 401, { error: { code: "UNAUTHENTICATED", message: "Please sign in again." } });
      return;
    }
    const current = typeof body.currentPassword === "string" ? body.currentPassword : "";
    const next = typeof body.newPassword === "string" ? body.newPassword : "";
    if (Object.keys(body).length !== 2 || current !== MOCK_CREDENTIALS.password || next.length < 12) {
      send(response, 400, { error: { code: "BAD_USER_INPUT", message: "The request input is invalid." } });
      return;
    }
    send(response, 200, { data: { ok: true, revokedSessions: 2 } });
    return;
  }

  /**
   * The inbox endpoints. Reads and writes both need a session: the access token
   * travels in an HttpOnly cookie, so it is the proxy — never the browser —
   * that presents it.
   */
  if (path === "/api/v1/me/notifications") {
    if (method !== "GET") {
      send(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." } });
      return;
    }
    if (request.headers.authorization !== `Bearer ${MOCK_TOKENS.accessToken}`) {
      send(response, 401, { error: { code: "UNAUTHENTICATED", message: "Please sign in again." } });
      return;
    }
    const raw = url.searchParams.get("limit");
    if (raw !== null && !/^[1-9][0-9]*$/.test(raw)) {
      send(response, 400, { error: { code: "BAD_USER_INPUT", message: "Invalid limit query parameter." } });
      return;
    }
    const limit = raw === null ? 50 : Math.min(100, Math.max(1, Number(raw)));
    send(response, 200, { data: MOCK_NOTIFICATIONS.slice(0, limit) });
    return;
  }

  if (path === "/api/v1/me/notifications/unread-count") {
    if (method !== "GET") {
      send(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." } });
      return;
    }
    if (request.headers.authorization !== `Bearer ${MOCK_TOKENS.accessToken}`) {
      send(response, 401, { error: { code: "UNAUTHENTICATED", message: "Please sign in again." } });
      return;
    }
    send(response, 200, { data: MOCK_NOTIFICATIONS.filter((notice) => notice.readAt === null).length });
    return;
  }

  if (path === "/api/v1/me/notifications/read-all") {
    if (method !== "POST") {
      send(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." } });
      return;
    }
    if (request.headers.authorization !== `Bearer ${MOCK_TOKENS.accessToken}`) {
      send(response, 401, { error: { code: "UNAUTHENTICATED", message: "Please sign in again." } });
      return;
    }
    let marked = 0;
    for (const notice of MOCK_NOTIFICATIONS) {
      if (notice.readAt === null) { notice.readAt = new Date().toISOString(); marked += 1; }
    }
    send(response, 200, { data: marked });
    return;
  }

  const notificationRead = /^\/api\/v1\/me\/notifications\/([^/]+)\/read$/.exec(path);
  if (notificationRead) {
    if (method !== "PUT") {
      send(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." } });
      return;
    }
    if (request.headers.authorization !== `Bearer ${MOCK_TOKENS.accessToken}`) {
      send(response, 401, { error: { code: "UNAUTHENTICATED", message: "Please sign in again." } });
      return;
    }
    const id = decodeURIComponent(notificationRead[1] ?? "");
    const notice = MOCK_NOTIFICATIONS.find((candidate) => candidate.id === id && candidate.readAt === null);
    // An unknown id, an already-read notice and someone else's notice are the
    // same answer, so nothing here can be used to probe what exists.
    if (!notice) {
      send(response, 404, { error: { code: "NOT_FOUND", message: "Notification not found." } });
      return;
    }
    notice.readAt = new Date().toISOString();
    send(response, 200, { data: { ...notice } });
    return;
  }

  send(response, 404, { error: { code: "NOT_FOUND", message: `No mock route for ${method} ${path}.` } });
}

export type MockRestApi = {
  url: string;
  close: () => Promise<void>;
  /** Upstream calls recorded since the last reset, e.g. `GET /api/v1/articles`. */
  requests: () => string[];
  resetRequests: () => void;
};

export async function startMockRestApi({ port = 0 }: { port?: number } = {}): Promise<MockRestApi> {
  let recorded: string[] = [];
  const server: Server = createServer((request, response) => {
    // The query string is recorded too: the page limit of a list request is part
    // of the contract the proxy is asserting, not an implementation detail.
    const target = new URL(request.url ?? "/", "http://mock.invalid");
    recorded.push(`${request.method ?? "GET"} ${target.pathname}${target.search}`);
    void readJson(request).then(
      (body) => handle(request, response, body),
      () => send(response, 400, { error: { code: "BAD_USER_INPUT", message: "Unreadable body." } }),
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("The mock API did not bind to a TCP port.");

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests: () => [...recorded],
    resetRequests: () => { recorded = []; },
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections?.();
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}
