import assert from "node:assert/strict";
import test from "node:test";
import { createApiContentClient, resolveApiBaseUrl } from "./api-content.ts";

type CapturedRequest = { url: string; init: RequestInit | undefined };

const article = {
  id: "article-1",
  authorId: "user-1",
  slug: "hello-world",
  status: "published",
  locale: "zh-TW",
  title: "Hello",
  summary: "Summary",
  workType: "poetry",
  contentBlocks: [{ id: "p1", type: "paragraph", text: "Hello" }],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
  publishedAt: "2026-10-02T00:00:00.000Z",
  author: { userId: "user-1", displayName: "Author", bio: "Bio", locale: "zh-TW" },
  categories: [{ name: "Engineering" }],
  tags: [{ name: "Web" }],
};

function response(data: unknown, status = 200): { ok: boolean; status: number; json(): Promise<unknown> } {
  return { ok: status >= 200 && status < 300, status, async json() { return data; } };
}

function captureFetch(
  payload: unknown,
  status = 200,
  captured: CapturedRequest[] = [],
): (input: string, init?: RequestInit) => Promise<ReturnType<typeof response>> {
  return async (input, init) => {
    captured.push({ url: input, init });
    return response(payload, status);
  };
}

test("API service binding base URL resolves directly without adding a GraphQL path", () => {
  assert.equal(resolveApiBaseUrl({ serviceUrl: "https://api-internal.example.test/" }), "https://api-internal.example.test");
  assert.equal(resolveApiBaseUrl({ serviceUrl: "https://api-internal.example.test" }), "https://api-internal.example.test");
  assert.equal(resolveApiBaseUrl({ serviceUrl: "https://api.example.test/internal/" }), "https://api.example.test/internal");
});

test("explicit REST API base takes precedence over the service binding", () => {
  assert.equal(
    resolveApiBaseUrl({
      explicitUrl: "https://api.example.test",
      serviceUrl: "https://api-internal.example.test/",
    }),
    "https://api.example.test",
  );
});

test("new base URL takes precedence and legacy override retains its previous precedence over service binding", () => {
  assert.equal(
    resolveApiBaseUrl({
      explicitUrl: "https://api-new.example.test",
      legacyGraphqlUrl: "https://api-legacy.example.test/graphql",
      serviceUrl: "https://api-service.example.test",
    }),
    "https://api-new.example.test",
  );
  assert.equal(
    resolveApiBaseUrl({
      legacyGraphqlUrl: "https://api-legacy.example.test/graphql",
      serviceUrl: "https://api-service.example.test",
    }),
    "https://api-legacy.example.test",
  );
});

test("legacy GraphQL environment value is mapped to its API base with a deprecation warning", () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => { warnings.push(String(message)); };
  try {
    assert.equal(
      resolveApiBaseUrl({ legacyGraphqlUrl: "https://api.example.test/graphql" }),
      "https://api.example.test",
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /API_GRAPHQL_URL is deprecated/);
  } finally {
    console.warn = originalWarn;
  }
});

test("endpoint resolution preserves fixture mode when no endpoint is configured", () => {
  assert.equal(resolveApiBaseUrl({}), undefined);
});

test("invalid service binding and malformed legacy endpoints fail visibly", () => {
  assert.throws(
    () => resolveApiBaseUrl({ serviceUrl: "not-a-url" }),
    /API_SERVICE_URL must be an absolute HTTP\(S\) URL/,
  );
  assert.throws(
    () => resolveApiBaseUrl({ legacyGraphqlUrl: "https://api.example.test/custom-query" }),
    /must point to a \/graphql endpoint/,
  );
  assert.throws(
    () => resolveApiBaseUrl({ explicitUrl: "https://user:password@api.example.test" }),
    /without embedded credentials/,
  );
});

test("REST content client maps article fields and uses the versioned REST route", async () => {
  const calls: CapturedRequest[] = [];
  const client = createApiContentClient({
    endpoint: "https://api.example.test",
    fetchImpl: captureFetch({ data: [article] }, 200, calls),
  });
  const articles = await client.listArticles({ locale: "zh-TW", query: "Hello", limit: 20, offset: 40 });
  assert.equal(calls.length, 1);
  const requestUrl = new URL(calls[0].url);
  assert.equal(requestUrl.pathname, "/api/v1/articles");
  assert.deepEqual(Object.fromEntries(requestUrl.searchParams), {
    locale: "zh-TW", query: "Hello", limit: "20", offset: "40",
  });
  assert.equal(calls[0].init?.method, "GET");
  assert.equal((calls[0].init?.headers as Record<string, string>).accept, "application/json");
  assert.equal(calls[0].init?.cache, "no-store");
  assert.equal(articles.length, 1);
  assert.equal(articles[0].author.username, "user-1");
  assert.equal(articles[0].description, "Summary");
  assert.equal(articles[0].workType, "poetry");
  assert.deepEqual(articles[0].contentBlocks, [{ id: "p1", type: "paragraph", text: "Hello" }]);
  assert.deepEqual(articles[0].categories, ["Engineering"]);
  assert.deepEqual(articles[0].tags, ["Web"]);
});

test("author article list is filtered by the REST endpoint before pagination", async () => {
  const calls: CapturedRequest[] = [];
  const client = createApiContentClient({
    endpoint: "https://api.example.test/",
    fetchImpl: captureFetch({ data: [article] }, 200, calls),
  });
  const works = await client.listArticles({ locale: "en", authorUsername: "author/one", query: "poetry", limit: 10, offset: 20 });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/api/v1/authors/author%2Fone/articles");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    locale: "en", query: "poetry", limit: "10", offset: "20",
  });
  assert.equal(works.length, 1);
});

test("REST detail routes map 404 responses to missing article, author and category values", async () => {
  const client = createApiContentClient({
    endpoint: "https://api.example.test",
    fetchImpl: async () => response({ error: { code: "NOT_FOUND", message: "not found" } }, 404),
  });
  assert.equal(await client.getArticleBySlug("missing"), null);
  assert.equal(await client.getAuthorByUsername("missing"), null);
  assert.equal(await client.getCategoryBySlug("missing"), null);
  assert.deepEqual(await client.listCategoryArticles("missing"), []);
});

test("REST content client fails visibly on HTTP and application errors", async () => {
  const httpClient = createApiContentClient({
    endpoint: "https://api.example.test",
    fetchImpl: captureFetch({ error: { code: "SERVICE_UNAVAILABLE" } }, 503),
  });
  await assert.rejects(httpClient.listArticles(), /HTTP 503/);

  const apiErrorClient = createApiContentClient({
    endpoint: "https://api.example.test",
    fetchImpl: captureFetch({ error: { code: "INTERNAL", message: "private database detail" } }),
  });
  await assert.rejects(apiErrorClient.listArticles(), (error: unknown) =>
    error instanceof Error && /INTERNAL/.test(error.message) && !error.message.includes("private database detail"),
  );
});

test("REST content client rejects malformed serialized content blocks", async () => {
  const client = createApiContentClient({
    endpoint: "https://api.example.test",
    fetchImpl: captureFetch({ data: { ...article, contentBlocks: "not-json" } }),
  });
  await assert.rejects(client.getArticleBySlug("hello-world"), /malformed article content/);
});

test("REST content client lists and retrieves localized categories and articles", async () => {
  const calls: CapturedRequest[] = [];
  const category = { id: "c1", slug: "poetry", name: "Poetry", description: "Poems", locale: "en", articleCount: 3 };
  const client = createApiContentClient({
    endpoint: "https://api.example.test",
    fetchImpl: async (input, init) => {
      calls.push({ url: input, init });
      const url = new URL(input);
      if (url.pathname === "/api/v1/categories") return response({ data: [category] });
      if (url.pathname === "/api/v1/categories/poetry") return response({ data: category });
      if (url.pathname === "/api/v1/categories/poetry/articles") return response({ data: [article] });
      return response({ error: { code: "NOT_FOUND" } }, 404);
    },
  });

  assert.deepEqual(await client.listCategories({ locale: "en", query: "poe", limit: 21, offset: 40 }), [{
    slug: "poetry", name: "Poetry", description: "Poems", locale: "en", articleCount: 3,
  }]);
  assert.deepEqual(await client.getCategoryBySlug("poetry", "en"), {
    slug: "poetry", name: "Poetry", description: "Poems", locale: "en", articleCount: 3,
  });
  const works = await client.listCategoryArticles("poetry", "en", 21, 20);
  assert.equal(works.length, 1);
  assert.equal(works[0].slug, "hello-world");
  assert.equal(calls.length, 3);
  assert.deepEqual(Object.fromEntries(new URL(calls[0].url).searchParams), {
    locale: "en", query: "poe", limit: "21", offset: "40",
  });
  assert.deepEqual(Object.fromEntries(new URL(calls[2].url).searchParams), {
    locale: "en", limit: "21", offset: "20",
  });
});

test("REST request rejects payloads without a data field", async () => {
  const client = createApiContentClient({
    endpoint: "https://api.example.test",
    fetchImpl: captureFetch({ unexpected: true }),
  });
  await assert.rejects(client.listArticles(), /missing its data field/);
});
