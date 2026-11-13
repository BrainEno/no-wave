import { resolveUpstreamTimeoutMs, withUpstreamDeadline } from "@bot-thk/web-http";
import { isTagSlug, type TagReference, type TagView } from "./tag-discovery.ts";
import type { ArticleContentBlock, ArticleSort, ArticleView, AuthorView, Locale, WorkType } from "./content.ts";
import {
  defaultLocale,
  getArticleBySlug,
  getAuthorByUsername,
  listArticles as listFixtureArticles,
} from "./content.ts";

export type CategoryView = { slug: string; name: string; description: string; locale: string; articleCount: number };
/**
 * An author in the public directory (ADR 0024).
 *
 * Everything an `AuthorView` carries — and the two numbers that make a directory
 * worth reading: how many readers follow this author, and how many works of
 * theirs are published here. Both come from the API rather than being counted
 * client-side, because counting client-side would mean loading every work first.
 */
export type AuthorSummary = AuthorView & { followerCount: number; workCount: number };
export type ArticleListOptions = { locale?: Locale; query?: string; authorUsername?: string | null; sort?: ArticleSort; limit?: number; offset?: number };
type CategoryListOptions = { locale?: Locale; query?: string; limit?: number; offset?: number };
export type TagListOptions = { locale?: Locale; query?: string; limit?: number; offset?: number };
type AuthorListOptions = { locale?: Locale; query?: string; limit?: number; offset?: number };
type ApiObject = Record<string, unknown>;
type ApiPayload = { data?: unknown; error?: unknown };
type JsonResponse = { ok: boolean; status: number; json(): Promise<unknown> };
type FetchImpl = (input: string, init?: RequestInit) => Promise<JsonResponse>;
type QueryValues = Record<string, string | number>;

type ApiContentClient = {
  listArticles(options?: ArticleListOptions): Promise<ArticleView[]>;
  listFeaturedArticles(options?: { locale?: Locale; limit?: number }): Promise<ArticleView[]>;
  getArticleBySlug(slug: string, locale?: Locale): Promise<ArticleView | null>;
  getAuthorByUsername(username: string, locale?: Locale): Promise<AuthorView | null>;
  listAuthors(options?: AuthorListOptions): Promise<AuthorSummary[]>;
  listCategories(options?: CategoryListOptions): Promise<CategoryView[]>;
  getCategoryBySlug(slug: string, locale?: Locale): Promise<CategoryView | null>;
  listCategoryArticles(slug: string, locale?: Locale, limit?: number, offset?: number): Promise<ArticleView[]>;
  listTags(options?: TagListOptions): Promise<TagView[]>;
  getTagBySlug(slug: string, locale?: Locale): Promise<TagView | null>;
  listTagArticles(slug: string, locale?: Locale, limit?: number, offset?: number): Promise<ArticleView[] | null>;
};

const WORK_TYPES = ["novel", "short_story", "poetry", "essay", "criticism", "literary_criticism", "nonfiction", "serial", "other"] as const;
let legacyGraphqlWarningShown = false;
// Preserve HTTP absence separately from a malformed successful `data: null`.
const CONTENT_NOT_FOUND = Symbol("content-not-found");

function isRecord(value: unknown): value is ApiObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWorkType(value: unknown): value is WorkType {
  return typeof value === "string" && (WORK_TYPES as readonly string[]).includes(value);
}

function mapNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item): unknown => isRecord(item) ? item.name : undefined)
    .filter((name): name is string => typeof name === "string");
}

function mapTagReferences(value: unknown): TagReference[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => isRecord(item) && isTagSlug(item.slug) && typeof item.name === "string" && item.name.trim()
    ? [{ slug: item.slug, name: item.name }] : []);
}

function mapTag(value: unknown, locale: Locale): TagView {
  if (!isRecord(value) || !isTagSlug(value.slug) || typeof value.name !== "string" || !value.name.trim() ||
      !Number.isSafeInteger(value.articleCount) || Number(value.articleCount) < 0 ||
      (value.description !== undefined && value.description !== null && typeof value.description !== "string") ||
      (value.locale !== undefined && value.locale !== locale)) {
    throw new Error("The content API returned an invalid public tag.");
  }
  return { slug: value.slug, name: value.name, description: typeof value.description === "string" ? value.description : "",
    locale, articleCount: Number(value.articleCount) };
}

function tagResourcePath(slug: string): string {
  if (!isTagSlug(slug)) throw new Error("Invalid public tag slug.");
  return `api/v1/tags/${encodeURIComponent(slug)}`;
}

function isContentBlock(value: unknown): value is ArticleContentBlock {
  if (!isRecord(value) || typeof value.id !== "string") return false;
  switch (value.type) {
    case "paragraph": return typeof value.text === "string";
    case "heading": return typeof value.text === "string" && (value.level === 2 || value.level === 3 || value.level === 4) && (value.anchor === undefined || typeof value.anchor === "string");
    case "quote": return typeof value.text === "string" && (value.attribution === undefined || typeof value.attribution === "string");
    case "list": return typeof value.ordered === "boolean" && Array.isArray(value.items) && value.items.every((item) => typeof item === "string");
    case "image": return typeof value.src === "string" && typeof value.alt === "string" && (value.caption === undefined || typeof value.caption === "string");
    case "code": return typeof value.language === "string" && typeof value.code === "string";
    default: return false;
  }
}

function normalizeHttpUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) URL.`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error(`${name} must be an absolute HTTP(S) URL without embedded credentials.`);
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  const normalized = url.toString();
  return normalized.endsWith("/") && url.pathname === "/" ? normalized.slice(0, -1) : normalized;
}

/**
 * Resolve the API origin supplied directly or by the Vercel service binding.
 * API_GRAPHQL_URL remains a one-release compatibility alias and is never used
 * as a GraphQL transport; callers are migrated to the versioned REST API.
 */
export function resolveApiBaseUrl(
  config: { explicitUrl?: string; serviceUrl?: string; legacyGraphqlUrl?: string } = {
    explicitUrl: process.env.API_BASE_URL,
    serviceUrl: process.env.API_SERVICE_URL,
    legacyGraphqlUrl: process.env.API_GRAPHQL_URL,
  },
): string | undefined {
  const explicitUrl = config.explicitUrl?.trim();
  if (explicitUrl) return normalizeHttpUrl(explicitUrl, "API_BASE_URL");

  // Preserve the old explicit override for one migration release, ahead of the
  // service binding, while directing operators to API_BASE_URL.
  const legacyGraphqlUrl = config.legacyGraphqlUrl?.trim();
  if (legacyGraphqlUrl) {
    let legacyUrl: URL;
    try {
      legacyUrl = new URL(legacyGraphqlUrl);
    } catch {
      throw new Error("API_GRAPHQL_URL compatibility value must be an absolute HTTP(S) /graphql URL; configure API_BASE_URL instead.");
    }
    if ((legacyUrl.protocol !== "http:" && legacyUrl.protocol !== "https:") || !/\/graphql\/?$/.test(legacyUrl.pathname)) {
      throw new Error("API_GRAPHQL_URL compatibility value must point to a /graphql endpoint; configure API_BASE_URL instead.");
    }
    legacyUrl.pathname = legacyUrl.pathname.replace(/\/graphql\/?$/, "") || "/";
    const baseUrl = normalizeHttpUrl(legacyUrl.toString(), "API_GRAPHQL_URL");
    if (!legacyGraphqlWarningShown) {
      console.warn("API_GRAPHQL_URL is deprecated. Set API_BASE_URL to the REST API origin; GraphQL requests are no longer used by the Web content client.");
      legacyGraphqlWarningShown = true;
    }
    return baseUrl;
  }

  const serviceUrl = config.serviceUrl?.trim();
  return serviceUrl ? normalizeHttpUrl(serviceUrl, "API_SERVICE_URL") : undefined;
}

function buildApiUrl(endpoint: string, path: string, query: QueryValues = {}): string {
  const base = endpoint.replace(/\/+$/, "") + "/";
  const url = new URL(path.replace(/^\/+/, ""), base);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  return url.toString();
}

function parseContentBlocks(value: unknown): ArticleContentBlock[] {
  let blocks: unknown = value;
  if (typeof blocks === "string") {
    try {
      blocks = JSON.parse(blocks);
    } catch {
      throw new Error("The content API returned malformed article content.");
    }
  }
  if (!Array.isArray(blocks) || !blocks.every(isContentBlock)) {
    throw new Error("The content API returned article content that is not a valid array of content blocks.");
  }
  return blocks;
}

function mapAuthor(author: unknown, locale: Locale): AuthorView | null {
  if (!isRecord(author) || typeof author.userId !== "string" || typeof author.displayName !== "string") return null;
  return {
    username: author.userId,
    displayName: author.displayName,
    bio: typeof author.bio === "string" ? author.bio : "",
    locale,
    availableLocales: [locale],
  };
}

/** The directory's shape: an author plus the two counts the page shows. */
function mapAuthorSummary(author: unknown, locale: Locale): AuthorSummary | null {
  const view = mapAuthor(author, locale);
  if (!view) return null;
  const record = isRecord(author) ? author : {};
  return {
    ...view,
    followerCount: typeof record.followerCount === "number" ? record.followerCount : 0,
    workCount: typeof record.workCount === "number" ? record.workCount : 0,
  };
}

function mapArticle(article: unknown, locale: Locale): ArticleView | null {
  if (!isRecord(article) || typeof article.slug !== "string" || typeof article.title !== "string") return null;
  const author = mapAuthor(article.author, locale);
  if (!author) return null;
  const publishedAt = [article.publishedAt, article.updatedAt, article.createdAt]
    .find((item): item is string => typeof item === "string");
  if (!publishedAt) return null;
  return {
    slug: article.slug,
    title: article.title,
    description: typeof article.summary === "string" ? article.summary : "",
    workType: isWorkType(article.workType) ? article.workType : "other",
    contentBlocks: parseContentBlocks(article.contentBlocks),
    publishedAt,
    ...(typeof article.updatedAt === "string" ? { updatedAt: article.updatedAt } : {}),
    author,
    categories: mapNames(article.categories),
    tags: mapNames(article.tags),
    tagReferences: mapTagReferences(article.tags),
    likeCount: typeof article.likeCount === "number" && Number.isFinite(article.likeCount) ? article.likeCount : 0,
    locale,
    availableLocales: [locale],
  };
}

function mapCategory(category: unknown): CategoryView | null {
  if (!isRecord(category) || typeof category.slug !== "string" || typeof category.name !== "string") return null;
  return {
    slug: category.slug,
    name: category.name,
    description: typeof category.description === "string" ? category.description : "",
    locale: typeof category.locale === "string" ? category.locale : defaultLocale,
    articleCount: typeof category.articleCount === "number" && Number.isInteger(category.articleCount) ? category.articleCount : 0,
  };
}

export function createApiContentClient(
  { endpoint, fetchImpl = fetch, timeoutMs }: { endpoint?: string; fetchImpl?: FetchImpl; timeoutMs?: number | string | null } = {},
): ApiContentClient {
  // Resolved once, at construction: a malformed budget is a deployment error and
  // must fail here rather than turn the first page request into an unbounded
  // wait. The default (`DEFAULT_UPSTREAM_TIMEOUT_MS`) applies when unset.
  const budget = resolveUpstreamTimeoutMs(timeoutMs);
  async function request(path: string, query: QueryValues = {}, allowNotFound = false): Promise<unknown | null> {
    if (typeof endpoint !== "string" || endpoint.trim().length === 0) {
      throw new Error("API_BASE_URL or API_SERVICE_URL must be configured to use API-backed content.");
    }
    // Everything — connection, headers and the JSON body — happens under one
    // deadline. Without it a hung content API pins the SSR request that reads it,
    // and every request that arrives behind it waits on the same stalled socket.
    const result = await withUpstreamDeadline(budget, async (signal) => {
      const response = await fetchImpl(buildApiUrl(endpoint, path, query), {
        method: "GET",
        headers: { accept: "application/json" },
        cache: "no-store",
        signal,
      });
      if (!response.ok) return { status: response.status, ok: false as const, payload: null };
      return { status: response.status, ok: true as const, payload: await response.json() };
    });
    if (!result.ok) {
      if (allowNotFound && result.status === 404) return CONTENT_NOT_FOUND;
      throw new Error(`Content API request failed with HTTP ${result.status}.`);
    }
    const payload = result.payload;
    if (!isRecord(payload)) throw new Error("The content API returned an invalid response.");
    if (isRecord(payload.error)) {
      const code = typeof payload.error.code === "string" ? payload.error.code : "API_ERROR";
      throw new Error(`The content API returned ${code}.`);
    }
    if (!Object.hasOwn(payload, "data")) throw new Error("The content API response is missing its data field.");
    return payload.data;
  }

  return Object.freeze({
    async listArticles({ locale = defaultLocale, query = "", authorUsername = null, sort, limit = 100, offset = 0 }: ArticleListOptions = {}): Promise<ArticleView[]> {
      const path = authorUsername
        ? `api/v1/authors/${encodeURIComponent(authorUsername)}/articles`
        : "api/v1/articles";
      const data = await request(path, { locale, query, limit, offset, ...(sort ? { sort } : {}) });
      if (!Array.isArray(data)) return [];
      return data.map((article) => mapArticle(article, locale)).filter((article): article is ArticleView => article !== null);
    },
    /**
     * The editorial shelf. There is no fixture equivalent — a hand-picked order
     * is exactly the thing a static registry cannot have — so this one has no
     * fallback to fall back to, and the home page treats an empty shelf as its
     * own answer rather than a failure.
     */
    async listFeaturedArticles({ locale = defaultLocale, limit = 20 }: { locale?: Locale; limit?: number } = {}): Promise<ArticleView[]> {
      const data = await request("api/v1/featured", { locale, limit });
      if (!Array.isArray(data)) return [];
      return data.map((article) => mapArticle(article, locale)).filter((article): article is ArticleView => article !== null);
    },
    async getArticleBySlug(slug: string, locale: Locale = defaultLocale): Promise<ArticleView | null> {
      const data = await request(`api/v1/articles/${encodeURIComponent(slug)}`, { locale }, true);
      return mapArticle(data, locale);
    },
    async getAuthorByUsername(username: string, locale: Locale = defaultLocale): Promise<AuthorView | null> {
      const data = await request(`api/v1/authors/${encodeURIComponent(username)}`, { locale }, true);
      return mapAuthor(data, locale);
    },
    /**
     * The author directory (ADR 0024): everybody who has published in this
     * locale, and — with a `query` — the ones whose name matches it.
     */
    async listAuthors({ locale = defaultLocale, query = "", limit = 20, offset = 0 }: AuthorListOptions = {}): Promise<AuthorSummary[]> {
      const data = await request("api/v1/authors", { locale, query, limit, offset });
      if (!Array.isArray(data)) return [];
      return data.map((author) => mapAuthorSummary(author, locale)).filter((author): author is AuthorSummary => author !== null);
    },
    async listCategories({ locale = defaultLocale, query = "", limit = 100, offset = 0 }: CategoryListOptions = {}): Promise<CategoryView[]> {
      const data = await request("api/v1/categories", { locale, query, limit, offset });
      if (!Array.isArray(data)) return [];
      return data.map(mapCategory).filter((item): item is CategoryView => item !== null);
    },
    async getCategoryBySlug(slug: string, locale: Locale = defaultLocale): Promise<CategoryView | null> {
      const data = await request(`api/v1/categories/${encodeURIComponent(slug)}`, { locale }, true);
      return mapCategory(data);
    },
    async listCategoryArticles(slug: string, locale: Locale = defaultLocale, limit = 100, offset = 0): Promise<ArticleView[]> {
      const data = await request(`api/v1/categories/${encodeURIComponent(slug)}/articles`, { locale, limit, offset }, true);
      if (!Array.isArray(data)) return [];
      return data.map((article) => mapArticle(article, locale)).filter((article): article is ArticleView => article !== null);
    },
    async listTags({ locale = defaultLocale, query = "", limit = 100, offset = 0 }: TagListOptions = {}): Promise<TagView[]> {
      const data = await request("api/v1/tags", { locale, query, limit, offset });
      if (!Array.isArray(data)) throw new Error("The content API returned an invalid public tag list.");
      return data.map((tag) => mapTag(tag, locale));
    },
    async getTagBySlug(slug: string, locale: Locale = defaultLocale): Promise<TagView | null> {
      const data = await request(tagResourcePath(slug), { locale }, true);
      return data === CONTENT_NOT_FOUND ? null : mapTag(data, locale);
    },
    async listTagArticles(slug: string, locale: Locale = defaultLocale, limit = 21, offset = 0): Promise<ArticleView[] | null> {
      const data = await request(`${tagResourcePath(slug)}/articles`, { locale, limit, offset }, true);
      if (data === CONTENT_NOT_FOUND) return null;
      if (!Array.isArray(data)) throw new Error("The content API returned an invalid public tag article list.");
      return data.map((value) => {
        // The anonymous API query is authoritative. Refuse, rather than hide, a
        // contract violation that would accidentally place a draft on this page.
        if (!isRecord(value) || value.status !== "published") throw new Error("The content API returned a non-public tag article.");
        if (value.locale !== undefined && value.locale !== locale) throw new Error("The content API returned an inconsistent tag article locale.");
        if (typeof value.publishedAt !== "string" || !value.publishedAt) throw new Error("The content API returned invalid tag article publication metadata.");
        if (value.updatedAt !== undefined && value.updatedAt !== null && typeof value.updatedAt !== "string") throw new Error("The content API returned invalid tag article modification metadata.");
        const article = mapArticle(value, locale);
        if (!article) throw new Error("The content API returned an invalid public tag article.");
        return article;
      });
    },
  });
}

function configuredClient(): ApiContentClient | null {
  const endpoint = resolveApiBaseUrl();
  // `API_TIMEOUT_MS` sits next to the origin it bounds: the same page loader that
  // discovers `API_BASE_URL` here also resolves the budget, so an explicit client
  // and an environment-configured one cannot drift apart. An invalid value throws
  // here and becomes the page's own 503, never an unbounded wait.
  return endpoint ? createApiContentClient({ endpoint, timeoutMs: process.env.API_TIMEOUT_MS }) : null;
}

/**
 * Public pages use REST whenever API_BASE_URL / API_SERVICE_URL is configured.
 * The local fixture registry remains the explicit fallback when no API endpoint
 * is configured; live API failures are surfaced instead of silently using fixtures.
 */
export async function listPublicArticles(options: ArticleListOptions = {}): Promise<ArticleView[]> {
  const client = configuredClient();
  return client ? client.listArticles(options) : listFixtureArticles(options);
}

/**
 * The editorial shelf, in the order an editor put it in.
 *
 * With no API configured there is no shelf rather than a fake one: an empty
 * array is the honest answer, and the home page says so instead of quietly
 * presenting the newest works as if somebody had chosen them.
 */
export async function listPublicFeatured(options: { locale?: Locale; limit?: number } = {}): Promise<ArticleView[]> {
  const client = configuredClient();
  return client ? client.listFeaturedArticles(options) : [];
}

export async function getPublicArticle(slug: string, locale: Locale = defaultLocale): Promise<ArticleView | null> {
  const client = configuredClient();
  return client ? client.getArticleBySlug(slug, locale) : getArticleBySlug(slug, locale);
}

export async function getPublicAuthor(username: string, locale: Locale = defaultLocale): Promise<AuthorView | null> {
  const client = configuredClient();
  return client ? client.getAuthorByUsername(username, locale) : getAuthorByUsername(username, locale);
}

/**
 * The public author directory.
 *
 * There is no fixture equivalent, and there should not be: a directory of
 * authors is a property of the instance running the site, so with no API
 * configured the honest answer is an empty one — the page says so.
 */
export async function listPublicAuthors(options: AuthorListOptions = {}): Promise<AuthorSummary[]> {
  const client = configuredClient();
  return client ? client.listAuthors(options) : [];
}

export async function listPublicCategories(options: CategoryListOptions = {}): Promise<CategoryView[]> {
  const client = configuredClient();
  return client ? client.listCategories(options) : [];
}

export async function getPublicCategory(slug: string, locale: Locale = defaultLocale): Promise<CategoryView | null> {
  const client = configuredClient();
  return client ? client.getCategoryBySlug(slug, locale) : null;
}

export async function listPublicCategoryArticles(slug: string, locale: Locale = defaultLocale, limit = 100, offset = 0): Promise<ArticleView[]> {
  const client = configuredClient();
  return client ? client.listCategoryArticles(slug, locale, limit, offset) : [];
}

export async function listPublicTags(options: TagListOptions = {}): Promise<TagView[]> {
  const client = configuredClient();
  return client ? client.listTags(options) : [];
}

export async function getPublicTag(slug: string, locale: Locale = defaultLocale): Promise<TagView | null> {
  const client = configuredClient();
  return client ? client.getTagBySlug(slug, locale) : null;
}

export async function listPublicTagArticles(slug: string, locale: Locale = defaultLocale, limit = 21, offset = 0): Promise<ArticleView[] | null> {
  const client = configuredClient();
  return client ? client.listTagArticles(slug, locale, limit, offset) : null;
}
