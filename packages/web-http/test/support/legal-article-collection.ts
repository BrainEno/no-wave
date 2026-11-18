import { serializeRestArticles } from "../../../../apps/api/src/transport/rest/serializers.ts";
import { validateArticleBlocks } from "../../../../apps/api/src/domain/article.ts";
import type { RestServices } from "../../../../apps/api/src/transport/rest/http.ts";
import type { StoredArticle, StoredAuthorProfile } from "../../../../apps/api/src/application/persistence-ports.ts";

export async function legalArticleCollection(count = 3, locale = "zh-CN", long = true) {
  const blocks = long ? Array.from({ length: 19 }, (_, index) => ({ id: `code-${index}`, type: "code", language: "text", code: "浪".repeat(49_900) }))
    : [{ id: "paragraph", type: "paragraph", text: "A complete article. 浪潮" }];
  validateArticleBlocks(blocks, 0);
  const at = "2026-11-12T00:00:00.000Z";
  const articles: StoredArticle[] = Array.from({ length: count }, (_, index) => ({ id: `article-${index}`, authorId: "fixture-author",
    slug: `work-${index}`, title: `A legal long work ${index}`, summary: "", workType: "essay", status: "published", locale,
    contentBlocks: blocks, contentBlocksVersion: 0, createdAt: at, updatedAt: at, publishedAt: at, viewCount: 0 }));
  const profile: StoredAuthorProfile = { userId: "fixture-author", displayName: "Fixture", role: "author", bio: "", avatarUrl: null,
    websiteUrl: null, locale, followerCount: 0, followingCount: 0, isFollowing: false, createdAt: at, updatedAt: at };
  // This real serializer only invokes the two read-only projection ports here.
  const services = { getAuthorProfilesByIds: () => ({ "fixture-author": profile }), listArticlesTaxonomies: () => ({}) } as unknown as RestServices;
  const data = await serializeRestArticles(services, articles, null);
  function response(options: { chunkBytes?: number; tail?: string; onCancel?: () => Promise<void> | void } = {}) {
    let size = 0;
    function* parts() {
      yield '{"data":[';
      for (const [index, article] of data.entries()) yield (index ? "," : "") + JSON.stringify(article);
      yield options.tail ?? "]}";
    }
    const iterator = parts();
    let bytes = new Uint8Array(0), offset = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (offset === bytes.byteLength) {
        const part = iterator.next();
        if (part.done) { controller.close(); return; }
        bytes = new TextEncoder().encode(part.value); offset = 0;
      }
      const next = bytes.subarray(offset, offset + (options.chunkBytes ?? 64 * 1024));
      offset += next.byteLength; size += next.byteLength; controller.enqueue(next);
    }, cancel() { iterator.return(); return options.onCancel?.(); } }, { highWaterMark: 0 });
    return { response: new Response(body, { headers: { "content-type": "application/json" } }), bytes: () => size };
  }
  return { articles, data, response };
}
