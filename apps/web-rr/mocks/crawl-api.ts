import { createServer } from "node:http";
import type { ServerResponse } from "node:http";

export type CrawlCollection = "articles" | "authors" | "categories" | "tags";
export type CrawlFault = { collection: CrawlCollection; offset?: number; locale?: string; mode: "unavailable" | "malformed" | "invalid-row" | "stall" };
export const CRAWL_PRIVATE_DIAGNOSTIC = "synthetic-internal-catalog-diagnostic";
export type CrawlApiRequest = { path: string; query: Record<string, string>; hasCredentials: boolean; hasCondition: boolean };
const collections: CrawlCollection[] = ["articles", "authors", "categories", "tags"];

function item(collection: CrawlCollection, index: number, locale: string, version: number) {
  const slug = `${collection === "articles" ? "work" : collection === "categories" ? "section" : "theme"}-${index}`;
  if (collection === "articles") return {
    slug, locale, status: "published", title: `Public work ${index}`, summary: "Public summary",
    publishedAt: "2026-10-01T00:00:00.000Z", updatedAt: `2026-11-0${version}T00:00:00.000Z`,
    author: { userId: "recent-writer", displayName: "A public writer", locale },
    contentBlocks: [], categories: [], tags: [],
  };
  if (collection === "authors") return {
    userId: index === 100 ? "older-writer-outside-article-window" : `writer-${index}`,
    displayName: `Writer ${index}`, bio: CRAWL_PRIVATE_DIAGNOSTIC,
    // The API deliberately falls back to another profile translation while
    // still selecting only writers published in the requested work locale.
    locale: "zh-TW", followerCount: 0, workCount: 1,
  };
  return { slug, locale, name: `Public taxonomy ${index}`, description: "Public directory item", articleCount: 0 };
}

function send(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

/** Real socket fixture with page-two failures; never overrides Web fetch internals. */
export async function startCrawlApi() {
  const requests: CrawlApiRequest[] = [];
  let fault: CrawlFault | undefined;
  let version = 1;
  let removeLastArticle = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://crawl-api.invalid");
    requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams),
      hasCredentials: Boolean(request.headers.authorization || request.headers.cookie),
      hasCondition: Boolean(request.headers["if-none-match"] || request.headers["if-modified-since"]) });
    const collection = collections.find((candidate) => url.pathname === `/api/v1/${candidate}`);
    if (!collection || request.method !== "GET") { send(response, 404, { error: { code: "NOT_FOUND" } }); return; }
    const locale = url.searchParams.get("locale") ?? "zh-CN";
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 20);
    if (fault && fault.collection === collection && (fault.offset === undefined || fault.offset === offset) &&
        (fault.locale === undefined || fault.locale === locale)) {
      if (fault.mode === "stall") return;
      if (fault.mode === "unavailable") { send(response, 503, { error: { code: "UNAVAILABLE", message: CRAWL_PRIVATE_DIAGNOSTIC } }); return; }
      if (fault.mode === "malformed") { send(response, 200, { data: { private: CRAWL_PRIVATE_DIAGNOSTIC } }); return; }
      send(response, 200, { data: [null] }); return;
    }
    const count = collection === "articles" && removeLastArticle ? 100 : 101;
    send(response, 200, { data: Array.from({ length: count }, (_, index) => item(collection, index, locale, version)).slice(offset, offset + limit) });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Crawl API fixture did not bind.");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests: () => [...requests],
    resetRequests: () => { requests.length = 0; },
    setFault: (next?: CrawlFault) => { fault = next; },
    updateArticles: (next: { version: number; removeLast?: boolean }) => { version = next.version; removeLastArticle = next.removeLast ?? false; },
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
