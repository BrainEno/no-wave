import {
  defaultLocale,
  getArticleBySlug,
  getAuthorByUsername,
  listArticles as listFixtureArticles,
} from "./content.mjs";

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
  query PublicCategories($locale: String!, $query: String!, $limit: Int!) {
    taxonomies(kind: "category", locale: $locale, query: $query, limit: $limit) {
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
  query PublicCategoryArticles($slug: String!, $locale: String!, $limit: Int!) {
    taxonomyArticles(kind: "category", slug: $slug, locale: $locale, limit: $limit) {
      id authorId slug status locale title summary workType contentBlocks createdAt updatedAt publishedAt
      author { userId displayName bio locale }
      categories { name }
      tags { name }
    }
  }
`;

function parseContentBlocks(value) {
  let blocks = value;
  if (typeof blocks === "string") {
    try {
      blocks = JSON.parse(blocks);
    } catch {
      throw new Error("The content API returned malformed article content.");
    }
  }
  if (!Array.isArray(blocks)) {
    throw new Error("The content API returned article content that is not an array.");
  }
  return blocks;
}

function mapAuthor(author, locale) {
  if (!author || typeof author.userId !== "string" || typeof author.displayName !== "string") return null;
  return {
    username: author.userId,
    displayName: author.displayName,
    bio: typeof author.bio === "string" ? author.bio : "",
    locale,
    availableLocales: [locale],
  };
}

function mapArticle(article, locale) {
  if (!article || typeof article.slug !== "string" || typeof article.title !== "string") return null;
  const author = mapAuthor(article.author, locale);
  if (!author) return null;
  return {
    slug: article.slug,
    title: article.title,
    description: typeof article.summary === "string" ? article.summary : "",
    workType: typeof article.workType === "string" ? article.workType : "other",
    contentBlocks: parseContentBlocks(article.contentBlocks),
    publishedAt: article.publishedAt ?? article.updatedAt ?? article.createdAt,
    author,
    categories: Array.isArray(article.categories) ? article.categories.map((item) => item.name).filter(Boolean) : [],
    tags: Array.isArray(article.tags) ? article.tags.map((item) => item.name).filter(Boolean) : [],
    locale,
    availableLocales: [locale],
  };
}

function mapCategory(category) {
  if (!category || typeof category.slug !== "string" || typeof category.name !== "string") return null;
  return {
    slug: category.slug,
    name: category.name,
    description: typeof category.description === "string" ? category.description : "",
    locale: typeof category.locale === "string" ? category.locale : defaultLocale,
    articleCount: Number.isInteger(category.articleCount) ? category.articleCount : 0,
  };
}

export function createApiContentClient({ endpoint, fetchImpl = fetch } = {}) {
  async function request(query, variables) {
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
    async listArticles({ locale = defaultLocale, query = "", authorUsername = null, limit = 100, offset = 0 } = {}) {
      const data = await request(ARTICLES_QUERY, { locale, query, limit, offset });
      const articles = Array.isArray(data.articles)
        ? data.articles.map((article) => mapArticle(article, locale)).filter(Boolean)
        : [];
      return authorUsername ? articles.filter((article) => article.author.username === authorUsername) : articles;
    },
    async getArticleBySlug(slug, locale = defaultLocale) {
      const data = await request(ARTICLE_QUERY, { slug, locale });
      return mapArticle(data.article, locale);
    },
    async getAuthorByUsername(username, locale = defaultLocale) {
      const data = await request(AUTHOR_QUERY, { userId: username, locale });
      return mapAuthor(data.authorProfile, locale);
    },
    async listCategories({ locale = defaultLocale, query = "", limit = 100 } = {}) {
      const data = await request(CATEGORIES_QUERY, { locale, query, limit });
      return Array.isArray(data.taxonomies) ? data.taxonomies.map(mapCategory).filter(Boolean) : [];
    },
    async getCategoryBySlug(slug, locale = defaultLocale) {
      const data = await request(CATEGORY_QUERY, { slug, locale });
      return mapCategory(data.taxonomy);
    },
    async listCategoryArticles(slug, locale = defaultLocale, limit = 100) {
      const data = await request(CATEGORY_ARTICLES_QUERY, { slug, locale, limit });
      return Array.isArray(data.taxonomyArticles)
        ? data.taxonomyArticles.map((article) => mapArticle(article, locale)).filter(Boolean)
        : [];
    },
  });
}

function configuredClient() {
  const endpoint = process.env.API_GRAPHQL_URL;
  return endpoint ? createApiContentClient({ endpoint }) : null;
}

/**
 * API-backed content is used when API_GRAPHQL_URL is configured. The local
 * fixture registry remains an explicit development/build fallback when it is
 * absent; configured API failures are surfaced rather than hidden by fixtures.
 * Category data has no fixture equivalent yet, so discovery routes are empty
 * in fixture-only builds and become data-backed when the API is configured.
 */
export async function listPublicArticles(options = {}) {
  const client = configuredClient();
  return client ? client.listArticles(options) : listFixtureArticles(options);
}

export async function getPublicArticle(slug, locale = defaultLocale) {
  const client = configuredClient();
  return client ? client.getArticleBySlug(slug, locale) : getArticleBySlug(slug, locale);
}

export async function getPublicAuthor(username, locale = defaultLocale) {
  const client = configuredClient();
  return client ? client.getAuthorByUsername(username, locale) : getAuthorByUsername(username, locale);
}

export async function listPublicCategories(options = {}) {
  const client = configuredClient();
  return client ? client.listCategories(options) : [];
}

export async function getPublicCategory(slug, locale = defaultLocale) {
  const client = configuredClient();
  return client ? client.getCategoryBySlug(slug, locale) : null;
}

export async function listPublicCategoryArticles(slug, locale = defaultLocale, limit = 100) {
  const client = configuredClient();
  return client ? client.listCategoryArticles(slug, locale, limit) : [];
}
