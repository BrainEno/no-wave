import type { ArticleContentBlock, ArticleView, AuthorView, Locale, WorkType } from "./content.ts";

export type CategoryView = { slug: string; name: string; description: string; locale: string; articleCount: number };
type GraphQLPayload = { data?: Record<string, unknown>; errors?: unknown[] };
type JsonResponse = { ok: boolean; status: number; json(): Promise<GraphQLPayload> };
type FetchImpl = (input: string, init?: RequestInit) => Promise<JsonResponse>;
export type ArticleListOptions = { locale?: Locale; query?: string; authorUsername?: string | null; limit?: number; offset?: number };
type CategoryListOptions = { locale?: Locale; query?: string; limit?: number; offset?: number };

/**
 * Resolve either an explicit GraphQL endpoint (local/legacy configuration) or
 * the base URL injected by a Vercel service binding. Bindings are runtime-only,
 * so pages that depend on this value must render dynamically.
 */
export function resolveApiGraphqlEndpoint(
  config: { explicitUrl?: string; serviceUrl?: string } = {
    explicitUrl: process.env.API_GRAPHQL_URL,
    serviceUrl: process.env.API_SERVICE_URL,
  },
): string | undefined {
  const explicitUrl = config.explicitUrl?.trim();
  if (explicitUrl) return explicitUrl;

  const serviceUrl = config.serviceUrl?.trim();
  if (!serviceUrl) return undefined;

  let baseUrl: URL;
  try {
    baseUrl = new URL(serviceUrl);
  } catch {
    throw new Error("API_SERVICE_URL must be an absolute HTTP(S) URL.");
  }
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new Error("API_SERVICE_URL must be an absolute HTTP(S) URL.");
  }

  while (baseUrl.pathname.endsWith("/")) {
    baseUrl.pathname = baseUrl.pathname.slice(0, -1);
  }
  baseUrl.pathname = `${baseUrl.pathname}/`;
  baseUrl.search = "";
  baseUrl.hash = "";
  return new URL("graphql", baseUrl).toString();
}
type ApiContentClient = {
  listArticles(options?: ArticleListOptions): Promise<ArticleView[]>;
  getArticleBySlug(slug: string, locale?: Locale): Promise<ArticleView | null>;
  getAuthorByUsername(username: string, locale?: Locale): Promise<AuthorView | null>;
  listCategories(options?: CategoryListOptions): Promise<CategoryView[]>;
  getCategoryBySlug(slug: string, locale?: Locale): Promise<CategoryView | null>;
  listCategoryArticles(slug: string, locale?: Locale, limit?: number, offset?: number): Promise<ArticleView[]>;
};
const WORK_TYPES = ["novel", "short_story", "poetry", "essay", "criticism", "literary_criticism", "nonfiction", "serial", "other"] as const;
type ApiObject = Record<string, unknown>;
function isRecord(value: unknown): value is ApiObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isWorkType(value: unknown): value is WorkType {
  return typeof value === "string" && (WORK_TYPES as readonly string[]).includes(value);
}
function mapNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).map((item): unknown => isRecord(item) ? item.name : undefined)
    .filter((name): name is string => typeof name === "string");
}
function isContentBlock(value: unknown): value is ArticleContentBlock {
  if (!isRecord(value) || typeof value.id !== "string") return false;
  switch (value.type) {
    case "paragraph": return typeof value.text === "string";
    case "heading": return typeof value.text === "string" && (value.level === 2 || value.level === 3 || value.level === 4) && (value.anchor === undefined || typeof value.anchor === "string");
    case "quote": return typeof value.text === "string" && (value.attribution === undefined || typeof value.attribution === "string");
    case "list": return typeof value.ordered === "boolean" && Array.isArray(value.items) && (value.items as unknown[]).every((item) => typeof item === "string");
    case "image": return typeof value.src === "string" && typeof value.alt === "string" && (value.caption === undefined || typeof value.caption === "string");
    case "code": return typeof value.language === "string" && typeof value.code === "string";
    default: return false;
  }
}

import {
  defaultLocale,
  getArticleBySlug,
  getAuthorByUsername,
  listArticles as listFixtureArticles,
} from "./content.ts";

const ARTICLES_QUERY = `
  query PublicArticles($locale: String!, $query: String!, $limit: Int!, $offset: Int!) {
    articles(locale: $locale, query: $query, limit: $limit, offset: $offset) {
      id authorId slug status locale title summary workType contentBlocks createdAt updatedAt publishedAt
      author { userId displayName bio locale }
      categories { name }
      tags { name }
    }
  }
`;

const ARTICLE_QUERY = `
  query PublicArticle($slug: String!, $locale: String!) {
    article(slug: $slug, locale: $locale) {
      id authorId slug status locale title summary workType contentBlocks createdAt updatedAt publishedAt
      author { userId displayName bio locale }
      categories { name }
      tags { name }
    }
  }
`;

const AUTHOR_QUERY = `
  query PublicAuthor($userId: String!, $locale: String!) {
    authorProfile(userId: $userId, locale: $locale) {
      userId displayName bio locale
    }
  }
`;

const CATEGORIES_QUERY = `
  query PublicCategories($locale: String!, $query: String!, $limit: Int!, $offset: Int!) {
    taxonomies(kind: "category", locale: $locale, query: $query, limit: $limit, offset: $offset) {
      id slug name description locale articleCount
    }
  }
`;

const CATEGORY_QUERY = `
  query PublicCategory($slug: String!, $locale: String!) {
    taxonomy(kind: "category", slug: $slug, locale: $locale) {
      id slug name description locale articleCount
    }
  }
`;

const CATEGORY_ARTICLES_QUERY = `
  query PublicCategoryArticles($slug: String!, $locale: String!, $limit: Int!, $offset: Int!) {
    taxonomyArticles(kind: "category", slug: $slug, locale: $locale, limit: $limit, offset: $offset) {
      id authorId slug status locale title summary workType contentBlocks createdAt updatedAt publishedAt
      author { userId displayName bio locale }
      categories { name }
      tags { name }
    }
  }
`;

function parseContentBlocks(value: unknown): ArticleContentBlock[] {
  let blocks: unknown = value;
  if (typeof blocks === "string") {
    try {
      blocks = JSON.parse(blocks);
    } catch {
      throw new Error("The content API returned malformed article content.");
    }
  }
  if (!Array.isArray(blocks) || !(blocks as unknown[]).every(isContentBlock)) {
    throw new Error("The content API returned article content that is not a valid array of content blocks.");
  }
  return blocks as ArticleContentBlock[];
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
  const publishedAt = [article.publishedAt, article.updatedAt, article.createdAt].find((item): item is string => typeof item === "string");
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
  async function request(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (typeof endpoint !== "string" || endpoint.length === 0) {
      throw new Error("API_GRAPHQL_URL must be configured to use API-backed content.");
    }
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ query, variables }),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Content API request failed with HTTP ${response.status}.`);
    const payload = await response.json();
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      throw new Error("The content API returned a GraphQL error.");
    }
    return payload.data ?? {};
  }

  return Object.freeze({
    async listArticles({ locale = defaultLocale, query = "", authorUsername = null, limit = 100, offset = 0 }: ArticleListOptions = {}): Promise<ArticleView[]> {
      const data = await request(ARTICLES_QUERY, { locale, query, limit, offset });
      const articles = Array.isArray(data.articles)
        ? (data.articles as unknown[]).map((article) => mapArticle(article, locale)).filter((article): article is ArticleView => article !== null)
        : [];
      return authorUsername ? articles.filter((article) => article.author.username === authorUsername) : articles;
    },
    async getArticleBySlug(slug: string, locale: Locale = defaultLocale): Promise<ArticleView | null> {
      const data = await request(ARTICLE_QUERY, { slug, locale });
      return mapArticle(data.article, locale);
    },
    async getAuthorByUsername(username: string, locale: Locale = defaultLocale): Promise<AuthorView | null> {
      const data = await request(AUTHOR_QUERY, { userId: username, locale });
      return mapAuthor(data.authorProfile, locale);
    },
    async listCategories({ locale = defaultLocale, query = "", limit = 100, offset = 0 }: CategoryListOptions = {}): Promise<CategoryView[]> {
      const data = await request(CATEGORIES_QUERY, { locale, query, limit, offset });
      return Array.isArray(data.taxonomies) ? (data.taxonomies as unknown[]).map(mapCategory).filter((item): item is CategoryView => item !== null) : [];
    },
    async getCategoryBySlug(slug: string, locale: Locale = defaultLocale): Promise<CategoryView | null> {
      const data = await request(CATEGORY_QUERY, { slug, locale });
      return mapCategory(data.taxonomy);
    },
    async listCategoryArticles(slug: string, locale: Locale = defaultLocale, limit = 100, offset = 0): Promise<ArticleView[]> {
      const data = await request(CATEGORY_ARTICLES_QUERY, { slug, locale, limit, offset });
      return Array.isArray(data.taxonomyArticles)
        ? (data.taxonomyArticles as unknown[]).map((article) => mapArticle(article, locale)).filter((article): article is ArticleView => article !== null)
        : [];
    },
  });
}

function configuredClient(): ApiContentClient | null {
  const endpoint = resolveApiGraphqlEndpoint();
  return endpoint ? createApiContentClient({ endpoint }) : null;
}

/**
 * API-backed content is used when API_GRAPHQL_URL (an explicit GraphQL endpoint)
 * or API_SERVICE_URL (a Vercel service-binding base URL) is configured. The local
 * fixture registry remains an explicit development fallback when both are absent;
 * configured API failures are surfaced rather than hidden by fixtures.
 * Category data has no fixture equivalent yet, so discovery routes are empty
 * in fixture-only builds and become data-backed when the API is configured.
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
