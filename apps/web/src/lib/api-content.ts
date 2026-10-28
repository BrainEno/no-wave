import type { ArticleContentBlock, ArticleView, AuthorView, Locale, WorkType } from "./content.ts";
import {
  defaultLocale,
  getArticleBySlug,
  getAuthorByUsername,
  listArticles as listFixtureArticles,
} from "./content.ts";

export type CategoryView = { slug: string; name: string; description: string; locale: string; articleCount: number };
export type ArticleListOptions = { locale?: Locale; query?: string; authorUsername?: string | null; limit?: number; offset?: number };
type CategoryListOptions = { locale?: Locale; query?: string; limit?: number; offset?: number };
type ApiObject = Record<string, unknown>;
type ApiPayload = { data?: unknown; error?: unknown };
type JsonResponse = { ok: boolean; status: number; json(): Promise<unknown> };
type FetchImpl = (input: string, init?: RequestInit) => Promise<JsonResponse>;
type QueryValues = Record<string, string | number>;

type ApiContentClient = {
  listArticles(options?: ArticleListOptions): Promise<ArticleView[]>;
  getArticleBySlug(slug: string, locale?: Locale): Promise<ArticleView | null>;
  getAuthorByUsername(username: string, locale?: Locale): Promise<AuthorView | null>;
  listCategories(options?: CategoryListOptions): Promise<CategoryView[]>;
  getCategoryBySlug(slug: string, locale?: Locale): Promise<CategoryView | null>;
  listCategoryArticles(slug: string, locale?: Locale, limit?: number, offset?: number): Promise<ArticleView[]>;
};

const WORK_TYPES = ["novel", "short_story", "poetry", "essay", "criticism", "literary_criticism", "nonfiction", "serial", "other"] as const;
let legacyGraphqlWarningShown = false;

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

  const serviceUrl = config.serviceUrl?.trim();
  if (serviceUrl) return normalizeHttpUrl(serviceUrl, "API_SERVICE_URL");

  const legacyGraphqlUrl = config.legacyGraphqlUrl?.trim();
  if (!legacyGraphqlUrl) return undefined;

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
    author,
    categories: mapNames(article.categories),
    tags: mapNames(article.tags),
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

export function createApiContentClient({ endpoint, fetchImpl = fetch }: { endpoint?: string; fetchImpl?: FetchImpl } = {}): ApiContentClient {
  async function request(path: string, query: QueryValues = {}, allowNotFound = false): Promise<unknown | null> {
    if (typeof endpoint !== "string" || endpoint.trim().length === 0) {
      throw new Error("API_BASE_URL or API_SERVICE_URL must be configured to use API-backed content.");
    }
    const response = await fetchImpl(buildApiUrl(endpoint, path, query), {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) {
      if (allowNotFound && response.status === 404) return null;
      throw new Error(`Content API request failed with HTTP ${response.status}.`);
    }
    const payload = await response.json();
    if (!isRecord(payload)) throw new Error("The content API returned an invalid response.");
    if (isRecord(payload.error)) {
      const code = typeof payload.error.code === "string" ? payload.error.code : "API_ERROR";
      throw new Error(`The content API returned ${code}.`);
    }
    if (!Object.hasOwn(payload, "data")) throw new Error("The content API response is missing its data field.");
    return payload.data;
  }

  return Object.freeze({
    async listArticles({ locale = defaultLocale, query = "", authorUsername = null, limit = 100, offset = 0 }: ArticleListOptions = {}): Promise<ArticleView[]> {
      const path = authorUsername
        ? `api/v1/authors/${encodeURIComponent(authorUsername)}/articles`
        : "api/v1/articles";
      const data = await request(path, { locale, query, limit, offset });
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
  });
}

function configuredClient(): ApiContentClient | null {
  const endpoint = resolveApiBaseUrl();
  return endpoint ? createApiContentClient({ endpoint }) : null;
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

export async function getPublicArticle(slug: string, locale: Locale = defaultLocale): Promise<ArticleView | null> {
  const client = configuredClient();
  return client ? client.getArticleBySlug(slug, locale) : getArticleBySlug(slug, locale);
}

export async function getPublicAuthor(username: string, locale: Locale = defaultLocale): Promise<AuthorView | null> {
  const client = configuredClient();
  return client ? client.getAuthorByUsername(username, locale) : getAuthorByUsername(username, locale);
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
