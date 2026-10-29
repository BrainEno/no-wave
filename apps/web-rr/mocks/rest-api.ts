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
      ],
      en: [
        { id: "b1", type: "paragraph", text: "A literary site should not tie its fate to one host's lifecycle." },
        { id: "b2", type: "heading", level: 2, text: "Why portability" },
        { id: "b3", type: "paragraph", text: "Server rendering, a standard Node runtime and a standalone REST API form the floor." },
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
    const limit = Number(url.searchParams.get("limit") ?? ARTICLES.length);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const page = ARTICLES.slice(offset, offset + (Number.isFinite(limit) ? limit : ARTICLES.length));
    send(response, 200, { data: page.map((article) => articlePayload(article, locale)) });
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

  if (method === "GET" && path === "/api/v1/me") {
    const authorization = request.headers.authorization ?? "";
    if (authorization !== `Bearer ${MOCK_TOKENS.accessToken}`) {
      send(response, 401, { error: { code: "UNAUTHENTICATED", message: "Please sign in again." } });
      return;
    }
    send(response, 200, {
      data: { userId: "writer", displayName: MOCK_DISPLAY_NAME, email: MOCK_CREDENTIALS.email },
    });
    return;
  }

  send(response, 404, { error: { code: "NOT_FOUND", message: `No mock route for ${method} ${path}.` } });
}

export type MockRestApi = { url: string; close: () => Promise<void> };

export async function startMockRestApi({ port = 0 }: { port?: number } = {}): Promise<MockRestApi> {
  const server: Server = createServer((request, response) => {
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
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections?.();
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}
