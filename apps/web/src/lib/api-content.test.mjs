import assert from "node:assert/strict";
import test from "node:test";
import { createApiContentClient } from "./api-content.mjs";

const article = {
  id: "article-1",
  authorId: "user-1",
  slug: "hello-world",
  status: "published",
  locale: "zh-TW",
  title: "Hello",
  summary: "Summary",
  workType: "poetry",
  contentBlocks: JSON.stringify([{ id: "p1", type: "paragraph", text: "Hello" }]),
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
  publishedAt: "2026-10-02T00:00:00.000Z",
  author: { userId: "user-1", displayName: "Author", bio: "Bio", locale: "zh-TW" },
  categories: [{ name: "Engineering" }],
  tags: [{ name: "Web" }],
};

function response(data, { ok = true, status = 200, errors } = {}) {
  return { ok, status, async json() { return { data, errors }; } };
}

test("API content client maps published article wire fields into web article views", async () => {
  let request;
  const client = createApiContentClient({
    endpoint: "https://api.example.test/graphql",
    fetchImpl: async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      return response({ articles: [article] });
    },
  });
  const articles = await client.listArticles({ locale: "zh-TW", query: "Hello" });
  assert.equal(request.url, "https://api.example.test/graphql");
  assert.equal(request.body.variables.query, "Hello");
  assert.equal(articles.length, 1);
  assert.equal(articles[0].author.username, "user-1");
  assert.equal(articles[0].description, "Summary");
  assert.equal(articles[0].workType, "poetry");
  assert.equal(articles[0].workType, "poetry");
  assert.deepEqual(articles[0].contentBlocks, [{ id: "p1", type: "paragraph", text: "Hello" }]);
  assert.deepEqual(articles[0].categories, ["Engineering"]);
  assert.deepEqual(articles[0].tags, ["Web"]);
});

test("API content client forwards offset pagination to the GraphQL article query", async () => {
  let request;
  const client = createApiContentClient({
    endpoint: "https://api.example.test/graphql",
    fetchImpl: async (_url, init) => {
      request = JSON.parse(init.body);
      return response({ articles: [article] });
    },
  });
  const articles = await client.listArticles({ locale: "en", query: "poetry", limit: 20, offset: 40 });
  assert.equal(articles.length, 1);
  assert.match(request.query, /offset: \$offset/);
  assert.deepEqual(request.variables, { locale: "en", query: "poetry", limit: 20, offset: 40 });
});

test("API content client maps missing articles and authors to null", async () => {
  const client = createApiContentClient({
    endpoint: "https://api.example.test/graphql",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      return response(body.query.includes("PublicAuthor") ? { authorProfile: null } : { article: null });
    },
  });
  assert.equal(await client.getArticleBySlug("missing"), null);
  assert.equal(await client.getAuthorByUsername("missing"), null);
});

test("API content client fails visibly on HTTP and GraphQL errors", async () => {
  const httpClient = createApiContentClient({
    endpoint: "https://api.example.test/graphql",
    fetchImpl: async () => response({}, { ok: false, status: 503 }),
  });
  await assert.rejects(httpClient.listArticles(), /HTTP 503/);

  const graphqlClient = createApiContentClient({
    endpoint: "https://api.example.test/graphql",
    fetchImpl: async () => response({}, { errors: [{ message: "private database detail" }] }),
  });
  await assert.rejects(graphqlClient.listArticles(), /GraphQL error/);
});

test("API content client rejects malformed serialized content blocks", async () => {
  const client = createApiContentClient({
    endpoint: "https://api.example.test/graphql",
    fetchImpl: async () => response({ article: { ...article, contentBlocks: "not-json" } }),
  });
  await assert.rejects(client.getArticleBySlug("hello-world"), /malformed article content/);
});


test("API content client lists categories and retrieves category works through GraphQL", async () => {
  const calls = [];
  const client = createApiContentClient({
    endpoint: "https://api.example.test/graphql",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (body.query.includes("PublicCategories")) {
        return response({ taxonomies: [{ id: "c1", slug: "poetry", name: "Poetry", description: "Poems", locale: "en", articleCount: 3 }] });
      }
      if (body.query.includes("PublicCategoryArticles")) {
        return response({ taxonomyArticles: [article] });
      }
      return response({ taxonomy: { id: "c1", slug: "poetry", name: "Poetry", description: "Poems", locale: "en", articleCount: 3 } });
    },
  });

  const categories = await client.listCategories({ locale: "en", query: "poe" });
  assert.deepEqual(categories, [{
    slug: "poetry", name: "Poetry", description: "Poems", locale: "en", articleCount: 3,
  }]);
  assert.equal(calls[0].variables.locale, "en");
  assert.equal(calls[0].variables.query, "poe");
  assert.deepEqual(await client.getCategoryBySlug("poetry", "en"), categories[0]);
  const works = await client.listCategoryArticles("poetry", "en", 21, 20);
  assert.equal(works.length, 1);
  assert.equal(works[0].slug, "hello-world");
  assert.equal(calls[2].variables.slug, "poetry");
  assert.ok(calls[2].query.includes("offset: $offset"));
  assert.deepEqual(calls[2].variables, { slug: "poetry", locale: "en", limit: 21, offset: 20 });
});

test("API content client maps a missing category to null", async () => {
  const client = createApiContentClient({
    endpoint: "https://api.example.test/graphql",
    fetchImpl: async () => response({ taxonomy: null }),
  });
  assert.equal(await client.getCategoryBySlug("missing"), null);
});
