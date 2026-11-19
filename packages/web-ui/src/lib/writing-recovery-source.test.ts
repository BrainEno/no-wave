import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createWritingBackup } from "./writing-backup.ts";
import { articleBlocksToLexicalEditorState } from "./lexical-article-state.ts";
import {
  parseRecoveryEntry,
  WritingRecoveryFault,
  type RecoveryEntry,
} from "./writing-recovery-model.ts";
import { WritingRecoverySourceReader } from "./writing-recovery-source.ts";

const articleId = randomUUID(),
  at = "2026-11-12T00:00:00.000Z";
const article = {
  id: articleId,
  authorId: "author-a",
  locale: "zh-CN",
  slug: "sea",
  title: "海风",
  summary: "摘要",
  workType: "essay",
  status: "draft",
  revision: "23",
  createdAt: at,
  updatedAt: at,
  publishedAt: null,
  contentBlocksVersion: 1,
  contentBlocks: [{ type: "paragraph", text: "同一份正文" }],
};
function entry(patch: Partial<RecoveryEntry> = {}): RecoveryEntry {
  return parseRecoveryEntry({
    version: 1,
    id: randomUUID(),
    actor: "author-a",
    writer: randomUUID(),
    epoch: randomUUID(),
    revision: 1,
    createdAt: Date.parse(at),
    updatedAt: Date.parse(at),
    outcomeUnknown: true,
    base: { articleId, locale: "zh-CN", revision: "23" },
    backup: createWritingBackup(
      {
        title: "海风",
        summary: "摘要",
        locale: "zh-CN",
        workType: "essay",
        editorState: articleBlocksToLexicalEditorState(article.contentBlocks),
      },
      new Date(at),
    ),
    ...patch,
  });
}
const fault = (code: string) => (error: unknown) =>
  error instanceof WritingRecoveryFault && error.code === code;

test("source reconciliation is an explicit actor-bound GET, classifies revisions with bigint and never treats equivalent text as request confirmation", async () => {
  const source = entry();
  let reads = 0;
  const reader = new WritingRecoverySourceReader({
    now: () => Date.parse(at),
    fetchImpl: async (url, init) => {
      reads++;
      assert.equal(url, `/api/authoring/catalogue/${articleId}?locale=zh-CN`);
      assert.equal(init.method, "GET");
      assert.equal(
        new Headers(init.headers).get("x-expected-author"),
        "author-a",
      );
      assert.equal(init.cache, "no-store");
      assert.equal(init.redirect, "error");
      return Response.json({ data: article });
    },
  });
  const result = await reader.read(source, "author-a", () => true);
  assert.equal(result?.kind, "available");
  assert.equal(result.equivalent, true);
  assert.equal(result.relation, "same");
  assert.equal(source.outcomeUnknown, true);
  assert.equal(reads, 1);
  for (const [remote, base, relation] of [
    ["9007199254740994", "9007199254740993", "advanced"],
    ["22", "23", "rewound"],
  ] as const) {
    const changed = new WritingRecoverySourceReader({
      fetchImpl: async () =>
        Response.json({
          data: { ...article, revision: remote, title: "远端新标题" },
        }),
    });
    const compared = await changed.read(
      entry({ base: { ...source.base, revision: base } }),
      "author-a",
      () => true,
    );
    assert.equal(compared?.relation, relation);
    assert.equal(compared.equivalent, false);
    assert.equal(compared.comparison?.fields[0]?.field, "title");
  }
});

test("an unlinked or missing source is not a reason to infer an article, fall back to another language or retry writes", async () => {
  let calls = 0;
  const reader = new WritingRecoverySourceReader({
    fetchImpl: async () => {
      calls++;
      return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
    },
  });
  assert.equal(
    (
      await reader.read(
        entry({ base: { articleId: null, locale: "zh-CN", revision: null } }),
        "author-a",
        () => true,
      )
    )?.kind,
    "unlinked",
  );
  assert.equal(calls, 0);
  assert.equal(
    (await reader.read(entry(), "author-a", () => true))?.kind,
    "missing",
  );
  assert.equal(calls, 1);
  await assert.rejects(
    reader.read(entry(), "author-b", () => true),
    fault("identity"),
  );
  assert.equal(calls, 1);
});

test("wrong identities, unsafe content, non-JSON and excessive advertised or streamed bodies fail closed before comparison", async () => {
  const invalid = [
    () => Response.json({ data: { ...article, authorId: "author-b" } }),
    () => Response.json({ data: { ...article, locale: "en" } }),
    () => Response.json({ data: { ...article, revision: "00" } }),
    () =>
      Response.json({
        data: {
          ...article,
          contentBlocks: [
            { type: "image", src: "javascript:alert(1)", alt: "unsafe" },
          ],
        },
      }),
    () => new Response("{}", { headers: { "content-type": "text/html" } }),
    () =>
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          "content-length": "3000000",
        },
      }),
    () =>
      new Response(" ".repeat(2 * 1024 * 1024 + 1), {
        headers: { "content-type": "application/json" },
      }),
    () =>
      new Response(new Uint8Array([0xff]), {
        headers: { "content-type": "application/json" },
      }),
  ];
  for (const response of invalid) {
    const reader = new WritingRecoverySourceReader({
      fetchImpl: async () => response(),
    });
    await assert.rejects(reader.read(entry(), "author-a", () => true));
  }
});

test("stalled fetch and stalled body both time out; late, cancelled or superseded results are never displayed", async () => {
  for (const mode of ["fetch", "body"] as const) {
    const reader = new WritingRecoverySourceReader({
      timeoutMs: 20,
      fetchImpl: () =>
        mode === "fetch"
          ? new Promise(() => {})
          : Promise.resolve(
              new Response(new ReadableStream({ start() {} }), {
                headers: { "content-type": "application/json" },
              }),
            ),
    });
    await assert.rejects(
      reader.read(entry(), "author-a", () => true),
      fault("timeout"),
    );
  }
  let release!: (response: Response) => void;
  const reader = new WritingRecoverySourceReader({
    fetchImpl: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const pending = reader.read(entry(), "author-a", () => true);
  await new Promise((resolve) => setImmediate(resolve));
  reader.cancel();
  release(Response.json({ data: article }));
  assert.equal(await pending, null);
  assert.equal(await reader.read(entry(), "author-a", () => false), null);
});

test("429 retains a finite manual retry deadline without automatic retries or bypass by choosing another cache", async () => {
  let calls = 0,
    now = Date.parse(at);
  const reader = new WritingRecoverySourceReader({
    now: () => now,
    fetchImpl: async () => {
      calls++;
      return Response.json(
        { error: {} },
        { status: 429, headers: { "retry-after": "2" } },
      );
    },
  });
  await assert.rejects(
    reader.read(entry(), "author-a", () => true),
    /等待/,
  );
  await assert.rejects(
    reader.read(entry(), "author-a", () => true),
    /等待/,
  );
  assert.equal(calls, 1);
  now += 2000;
  await assert.rejects(
    reader.read(entry(), "author-a", () => true),
    /等待/,
  );
  assert.equal(calls, 2);
});
