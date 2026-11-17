import assert from "node:assert/strict";
import test from "node:test";
import { exportNotionBundle, MAX_EXPORT_WORKS } from "../../../apps/api/src/application/notion-export.ts";
import { validateArticleBlocks } from "../../../apps/api/src/domain/article.ts";
import type { StoredArticle } from "../../../apps/api/src/application/persistence-ports.ts";
import { handleAuthoringNotionExportRequest } from "../src/authoring.ts";
import { UpstreamTransport } from "../src/upstream.ts";

// A legal edition close to the existing 1,000,000-character domain ceiling.
// The real Notion mapper writes plain_text and text.content; it does not have
// the same byte size as the stored article. No limit is changed for this test.
const contentBlocks = Array.from({ length: 19 }, (_, index) => ({ id: `code-${index}`, type: "code", language: "text", code: "浪".repeat(49_900) }));
const slugs = Array.from({ length: MAX_EXPORT_WORKS }, (_, index) => `work-${index}`);

test("fifty legal bilingual works remain downloadable above a quarter-gigabyte without a full-file buffer", { timeout: 90_000 }, async t => {
  validateArticleBlocks(contentBlocks, 0);
  const exported = await exportNotionBundle({ actorId: "fixture-author", slugs, deps: {
    listMyArticleEditions: ({ slug }) => ["zh-CN", "en"].map(locale => ({ id: `id-${slug}`, authorId: "fixture-author", slug,
      title: "A legal long work", summary: "", workType: "essay", status: "draft", locale, contentBlocks,
      contentBlocksVersion: 0, createdAt: null, updatedAt: null, publishedAt: null, viewCount: 0 } satisfies StoredArticle)),
    listArticlesTaxonomies: () => ({}), listExternalContentLinks: () => [],
  } });
  assert.equal(exported.bundle.pages.length, 100);
  let emitted = 0;
  function* fragments() {
    yield '{"data":{"bundle":{"version":1,"database":' + JSON.stringify(exported.bundle.database) + ',"pages":[';
    for (const [index, page] of exported.bundle.pages.entries()) yield (index ? "," : "") + JSON.stringify(page);
    yield ']},"report":' + JSON.stringify(exported.report) + '}}';
  }
  const iterator = fragments();
  let current = new Uint8Array(0);
  let offset = 0;
  const transport = new UpstreamTransport({ fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= current.byteLength) {
        const next = iterator.next();
        if (next.done) { controller.close(); return; }
        current = new TextEncoder().encode(next.value); offset = 0;
      }
      const chunk = current.subarray(offset, offset + 64 * 1024);
      offset += chunk.byteLength; emitted += chunk.byteLength; controller.enqueue(chunk);
    }, cancel() { iterator.return(); },
  }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } }) });
  t.after(() => transport.close());
  const response = await handleAuthoringNotionExportRequest(new Request(`https://web.test/api/authoring/notion-export?slugs=${slugs.join(",")}`),
    { apiBaseUrl: "https://api.test", upstreamTransport: transport, upstreamTimeoutMs: 90_000 });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition") ?? "", /attachment/);
  const reader = response.body!.getReader();
  let received = 0;
  for (;;) { const next = await reader.read(); if (next.done) break; received += next.value.byteLength; }
  reader.releaseLock();
  assert.equal(received, emitted);
  assert.ok(received > 512 * 1024 * 1024, `The compatibility fixture must be genuinely large: ${received}`);
  assert.equal(await transport.close(), true);
});
