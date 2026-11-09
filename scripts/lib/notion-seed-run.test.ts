import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runNotionSeed, type SeedArgs } from "./notion-seed-run.ts";

/**
 * The seed end to end, against a stub that speaks the REST contract.
 *
 * The point of running the real driver over HTTP rather than asserting on its
 * internals is that the seed's promises are HTTP-shaped: a create carries the
 * page's idempotency key, an edition is replaced by `PUT` on the *work* id, a
 * dry run issues no request at all, and a second run with an unchanged bundle
 * writes nothing.
 */
type Recorded = { method: string; path: string; headers: IncomingMessage["headers"]; body: unknown };

const text = (content: string) => ({
  type: "text",
  plain_text: content,
  href: null,
  text: { content, link: null },
  annotations: { bold: false, italic: false, underline: false, strikethrough: false, code: false, color: "default" },
});

const paragraph = (content: string) => ({ type: "paragraph", has_children: false, paragraph: { rich_text: [text(content)] } });

function page(id: string, title: string, extra: Record<string, unknown> = {}, blocks: unknown[] = [paragraph("正文")]) {
  return {
    id,
    properties: {
      Page: { type: "title", title: [text(title)] },
      Slug: { type: "rich_text", rich_text: [] },
      Excerpt: { type: "rich_text", rich_text: [] },
      Date: { type: "date", date: null },
      Published: { type: "checkbox", checkbox: false },
      Tags: { type: "multi_select", multi_select: [] },
      ...extra,
    },
    blocks,
  };
}

const wallBundle = {
  version: 1,
  database: { id: "ds-1", title: "Bottom Think" },
  pages: [
    page("p-wall", "墙壁", {
      Date: { type: "date", date: { start: "2026-10-08" } },
      Published: { type: "checkbox", checkbox: true },
      Tags: { type: "multi_select", multi_select: [{ name: "诗歌" }] },
    }),
    page(
      "p-plane",
      "飞行器",
      {
        Date: { type: "date", date: { start: "2026-05-13" } },
        Published: { type: "checkbox", checkbox: true },
        English: { type: "relation", relation: [{ id: "p-aircraft" }] },
      },
    ),
    page("p-aircraft", "Aircraft", {}, [paragraph("A head is opened")]),
    // A blank page: refused, not published empty.
    page("p-blank", "空白", {}, []),
  ],
};

async function withStub(
  handler: (recorded: Recorded, response: ServerResponse) => void,
  body: (run: (args: Partial<SeedArgs>) => Promise<Awaited<ReturnType<typeof runNotionSeed>>>) => Promise<void>,
): Promise<void> {
  const recorded: Recorded[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const entry: Recorded = {
        method: request.method ?? "",
        path: (request.url ?? "").split("?")[0]!,
        headers: request.headers,
        body: raw.length > 0 ? JSON.parse(raw) : null,
      };
      recorded.push(entry);
      response.setHeader("content-type", "application/json");
      handler(entry, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // Exposed before the body runs: the assertions inside it read the recording.
  (globalThis as { __recorded?: Recorded[] }).__recorded = recorded;
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const directory = await mkdtemp(join(tmpdir(), "notion-seed-"));
  const bundlePath = join(directory, "bundle.json");
  await writeFile(bundlePath, JSON.stringify(wallBundle), "utf8");
  try {
    await body(async (overrides) => runNotionSeed({
      bundle: bundlePath,
      notionDatabase: null,
      notionToken: null,
      api: `http://127.0.0.1:${port}`,
      email: "author@example.com",
      password: "correct horse battery staple",
      state: join(directory, "state.json"),
      writeBundle: null,
      apply: false,
      ...overrides,
    }));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

function recorded(): Recorded[] {
  return (globalThis as { __recorded?: Recorded[] }).__recorded ?? [];
}

test("a dry run issues no request at all", async () => {
  await withStub(
    () => { throw new Error("a dry run must not talk to the API"); },
    async (run) => {
      const result = await run({ apply: false });
      assert.equal(recorded().length, 0);
      assert.equal(result.applied, false);
      const actions = result.outcomes.map((outcome) => `${outcome.action}:${outcome.title}`);
      assert.deepEqual(actions.sort(), [
        "create:墙壁",
        "create:飞行器",
        "create:Aircraft",
        "refused:空白",
      ].sort());
    },
  );
});

test("applying creates the work, attaches the translation and records the state", async () => {
  const articles = new Map<string, { id: string; slug: string }>();
  await withStub(
    (request, response) => {
      if (request.path === "/api/v1/auth/login") {
        response.end(JSON.stringify({ data: { accessToken: "token-1" } }));
        return;
      }
      if (request.path === "/api/v1/tags" && request.method === "GET") {
        response.end(JSON.stringify({ data: [{ id: "tag-poetry", name: "诗歌" }] }));
        return;
      }
      if (request.path === "/api/v1/tags" && request.method === "POST") {
        response.statusCode = 201;
        response.end(JSON.stringify({ data: { id: "tag-new", name: (request.body as { name: string }).name } }));
        return;
      }
      if (request.path === "/api/v1/articles" && request.method === "POST") {
        const body = request.body as { title: string; contentBlocks: unknown[] };
        const id = `art-${articles.size + 1}`;
        const slug = body.title === "墙壁" ? "qiangbi" : "feixing-qi";
        articles.set(id, { id, slug });
        response.statusCode = 201;
        response.end(JSON.stringify({ data: { id, slug, title: body.title, contentBlocks: body.contentBlocks } }));
        return;
      }
      if (request.path.startsWith("/api/v1/articles/") && request.method === "PUT") {
        const body = request.body as { slug: string; locale: string };
        response.end(JSON.stringify({ data: { id: request.path.split("/").pop(), slug: body.slug, locale: body.locale } }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "The requested resource was not found." } }));
    },
    async (run) => {
      const result = await run({ apply: true });
      const calls = recorded();

      // Nothing was written for the blank page, and it says why.
      const refused = result.outcomes.find((outcome) => outcome.action === "refused");
      assert.equal(refused?.title, "空白");
      assert.equal(refused?.detail, "empty-body");

      // A create per work (not per page): the English page is a translation.
      const creates = calls.filter((call) => call.method === "POST" && call.path === "/api/v1/articles");
      assert.equal(creates.length, 2);
      const wallCreate = creates.find((call) => (call.body as { title: string }).title === "墙壁")!;
      assert.equal(wallCreate.headers["idempotency-key"], "notion-seed:p-wall");
      const wallBody = wallCreate.body as {
        locale: string; workType: string; publish: boolean; slug?: string;
        contentBlocks: { type: string; text: string }[]; tagIds?: string[];
      };
      assert.equal(wallBody.locale, "zh-CN");
      assert.equal(wallBody.workType, "poetry");
      assert.equal(wallBody.publish, true);
      assert.equal("slug" in wallBody, false, "a derived address is left to the API, which owns uniqueness");
      assert.equal(wallBody.contentBlocks[0]?.text, "正文");
      assert.deepEqual(wallBody.tagIds, ["tag-poetry"]);

      // The translation is a `PUT` on the work's id with an explicit locale.
      const translation = calls.find((call) => call.method === "PUT" && call.path === "/api/v1/articles/art-2")!;
      const translationBody = translation.body as { locale: string; slug: string; publish: boolean };
      assert.equal(translationBody.locale, "en");
      assert.equal(translationBody.slug, "feixing-qi");
      assert.equal(translationBody.publish, true);

      // No tag was created: 诗歌 already existed.
      assert.equal(calls.filter((call) => call.method === "POST" && call.path === "/api/v1/tags").length, 0);

      // The state records both pages against the same work.
      assert.equal(result.applied, true);
      assert.equal(result.state.pages["p-wall"]?.slug, "qiangbi");
      assert.equal(result.state.pages["p-plane"]?.slug, "feixing-qi");
      assert.equal(result.state.pages["p-aircraft"]?.articleId, result.state.pages["p-plane"]?.articleId);
      assert.equal(result.state.pages["p-blank"], undefined);
    },
  );
});

test("a second run of an unchanged bundle writes nothing", async () => {
  await withStub(
    (request, response) => {
      if (request.path === "/api/v1/auth/login") {
        response.end(JSON.stringify({ data: { accessToken: "token-1" } }));
        return;
      }
      if (request.path === "/api/v1/tags" && request.method === "GET") {
        response.end(JSON.stringify({ data: [{ id: "tag-poetry", name: "诗歌" }] }));
        return;
      }
      if (request.path === "/api/v1/tags" && request.method === "POST") {
        response.statusCode = 201;
        response.end(JSON.stringify({ data: { id: "tag-new", name: (request.body as { name: string }).name } }));
        return;
      }
      if (request.path === "/api/v1/articles" && request.method === "POST") {
        response.statusCode = 201;
        response.end(JSON.stringify({ data: { id: "art-1", slug: "qiangbi" } }));
        return;
      }
      response.end(JSON.stringify({ data: { id: "art-1", slug: "qiangbi" } }));
    },
    async (run) => {
      const first = await run({ apply: true });
      const afterFirst = recorded().length;
      const second = await run({ apply: true });

      // Re-running against the same state file: every edition is unchanged, so
      // the only requests are the login and the tag lookup.
      const secondCalls = recorded().slice(afterFirst);
      assert.deepEqual(secondCalls.map((call) => `${call.method} ${call.path}`), ["POST /api/v1/auth/login", "GET /api/v1/tags"]);
      assert.equal(second.outcomes.some((outcome) => outcome.action === "create" || outcome.action === "update"), false);
      assert.ok(second.outcomes.some((outcome) => outcome.detail === "unchanged since the last run"));
      assert.ok(first.outcomes.some((outcome) => outcome.action === "create"));
    },
  );
});
