import { createServer } from "node:http";
import type { ServerResponse } from "node:http";

/** Public REST contract fixture, deliberately independent of Web mappers. */
export const STABLE_TAG_SLUG = "persisted-topic-97c4";
export const TAG_API_PRIVATE_ERROR = "database-host-internal: confidential diagnostic";
export type TagApiRequest = { path: string; query: Record<string, string>; hasCredentials: boolean };

function tagPayload(slug: string, locale: string) {
  const english = locale === "en";
  const name = slug === STABLE_TAG_SLUG
    ? english ? "A renamed theme" : "重新命名的主题"
    : slug === "empty-topic" ? english ? "Empty theme" : "空主题"
      : `${english ? "Theme" : "主题"} ${slug.replace("topic-", "")}`;
  return { id: `id-${slug}`, slug, name, description: slug === STABLE_TAG_SLUG ? english ? "Writing about places and memory." : "关于地方与记忆的写作。" : "",
    locale, articleCount: slug === STABLE_TAG_SLUG ? 22 : 0 };
}

function articlePayload(index: number, locale: string) {
  const english = locale === "en";
  return {
    id: `article-${index}`, slug: `tagged-work-${index}`, status: "published", locale, workType: "essay",
    title: `${english ? "Tagged work" : "主题作品"} ${String(index).padStart(2, "0")}`,
    summary: english ? "An independent editorial summary." : "一段独立的编辑摘要。",
    contentBlocks: [{ id: `p-${index}`, type: "paragraph", text: english ? "A public work about places." : "这是一篇关于地方的公开作品。" }],
    createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-02T00:00:00.000Z", publishedAt: "2026-11-02T00:00:00.000Z",
    author: { userId: "tag-author", displayName: english ? "A writer" : "写作者", bio: "", locale },
    categories: [{ name: english ? "Essay" : "散文" }],
    // The label intentionally cannot be turned back into the persisted slug.
    // Legacy names stay readable, and an invalid URL is never made clickable.
    tags: [{ slug: STABLE_TAG_SLUG, name: english ? "A renamed theme" : "重新命名的主题" },
      { name: english ? "Legacy label" : "旧标签" }, { slug: "javascript:alert(1)", name: "Unsafe reference" }],
    likeCount: 0, viewCount: 0,
  };
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

/** A real upstream socket: production SSR, errors and credential isolation are exercised. */
export async function startTagApi() {
  const requests: TagApiRequest[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://tag-fixture.invalid");
    requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams),
      hasCredentials: Boolean(request.headers.authorization || request.headers.cookie) });
    const locale = url.searchParams.get("locale") ?? "zh-CN";
    const query = url.searchParams.get("query") ?? "";
    const limit = Number(url.searchParams.get("limit") ?? 20);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    if (request.method !== "GET") { send(response, 405, { error: { code: "METHOD_NOT_ALLOWED" } }); return; }
    if (url.pathname === "/api/v1/tags") {
      if (query === "unavailable") { send(response, 503, { error: { code: "UNAVAILABLE", message: TAG_API_PRIVATE_ERROR } }); return; }
      if (query === "malformed") { send(response, 200, { data: { not: "an array" } }); return; }
      const tags = [STABLE_TAG_SLUG, ...Array.from({ length: 22 }, (_, i) => `topic-${String(i + 1).padStart(2, "0")}`), "empty-topic"]
        .map((slug) => tagPayload(slug, locale)).filter((tag) => !query || tag.name.toLowerCase().includes(query.toLowerCase()));
      send(response, 200, { data: tags.slice(offset, offset + limit) }); return;
    }
    const tagMatch = /^\/api\/v1\/tags\/([^/]+)(\/articles)?$/.exec(url.pathname);
    if (tagMatch) {
      const slug = tagMatch[1]!;
      if (slug === "unavailable") { send(response, 503, { error: { code: "UNAVAILABLE", message: TAG_API_PRIVATE_ERROR } }); return; }
      if (slug === "malformed") { send(response, 200, { data: { slug, name: 7 } }); return; }
      if (slug === "null-payload") { send(response, 200, { data: null }); return; }
      const exists = slug === STABLE_TAG_SLUG || slug === "empty-topic" || slug === "disappearing-topic" || /^topic-\d{2}$/.test(slug);
      if (!exists || (slug === "disappearing-topic" && tagMatch[2])) { send(response, 404, { error: { code: "NOT_FOUND" } }); return; }
      if (!tagMatch[2]) { send(response, 200, { data: tagPayload(slug, locale) }); return; }
      const works = slug === STABLE_TAG_SLUG ? Array.from({ length: 22 }, (_, i) => articlePayload(i + 1, locale)) : [];
      send(response, 200, { data: works.slice(offset, offset + limit) }); return;
    }
    if (url.pathname === "/api/v1/articles") {
      send(response, 200, { data: Array.from({ length: 22 }, (_, i) => articlePayload(i + 1, locale)).slice(offset, offset + limit) }); return;
    }
    const articleMatch = /^\/api\/v1\/articles\/tagged-work-(\d+)$/.exec(url.pathname);
    if (articleMatch) { send(response, 200, { data: articlePayload(Number(articleMatch[1]), locale) }); return; }
    send(response, 404, { error: { code: "NOT_FOUND" } });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The tag API fixture did not bind a port.");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests: () => [...requests],
    resetRequests: () => { requests.length = 0; },
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
