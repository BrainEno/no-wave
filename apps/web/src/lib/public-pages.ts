import type { ArticleView, AuthorView, Locale, WorkType } from "./content.ts";
import {
  getPublicArticle,
  getPublicCategory,
  listPublicArticles,
  listPublicCategories,
  listPublicCategoryArticles,
  type CategoryView,
} from "./api-content.ts";
import { PAGE_SIZE, paginate } from "./work-types.ts";

/**
 * Public page data loaders.
 *
 * These functions are the reason the same pages can be served by two different
 * frameworks: React Router renders synchronously, so an `async` component that
 * fetches its own data (the App Router shape) cannot be reused there, while a
 * plain function that returns a data object can. Each loader therefore owns
 * *what* a public page needs, and the matching view component owns *how* it is
 * rendered.
 *
 * Every loader is also the place where the deployment budget is enforced,
 * because a free instance (one shared CPU, cold starts, ephemeral disk) is
 * harmed by unbounded work far more than by a slightly larger response:
 *
 *   - at most two API calls per page (`Promise.all` where they are independent);
 *   - hard ceilings on every list (`*_LIMIT`), never "fetch everything";
 *   - no per-item work, no filesystem access, no in-process caching — an
 *     in-memory page cache would be wrong anyway, because the instance is
 *     restarted and duplicated at will.
 */

export type SearchTab = "works" | "authors" | "categories";

export function parseTab(value: string | string[] | undefined): SearchTab {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "authors" || raw === "categories" ? raw : "works";
}

/** The API has no work-type parameter, so type filtering scans a bounded window. */
export const ARCHIVE_TYPE_SCAN_LIMIT = 100;
/** Author catalogues are small and read once; the same window as the App Router. */
export const AUTHOR_WORKS_LIMIT = 100;
export const SEARCH_WORKS_LIMIT = 100;
export const SEARCH_CATEGORY_LIMIT = 20;
export const CATEGORY_PAGE_SIZE = 20;

export type ArchivePageData = {
  locale: Locale;
  query: string;
  page: number;
  type: WorkType | null;
  articles: ArticleView[];
  hasNextPage: boolean;
};

export async function loadArchivePage(
  options: { locale: Locale; query?: string; page?: number; type?: WorkType | null },
): Promise<ArchivePageData> {
  const locale = options.locale;
  const query = options.query ?? "";
  const page = options.page ?? 1;
  const type = options.type ?? null;

  if (type) {
    // API 暂无作品类型参数：在最新 100 篇匹配作品中筛选并分页
    const matches = (await listPublicArticles({ locale, query, limit: ARCHIVE_TYPE_SCAN_LIMIT }))
      .filter((article) => article.workType === type);
    const { visible, hasNextPage } = paginate(matches, page);
    return { locale, query, page, type, articles: visible, hasNextPage };
  }

  const results = await listPublicArticles({ locale, query, limit: PAGE_SIZE + 1, offset: (page - 1) * PAGE_SIZE });
  return {
    locale,
    query,
    page,
    type,
    articles: results.slice(0, PAGE_SIZE),
    hasNextPage: results.length > PAGE_SIZE,
  };
}

export type AuthorPageData = {
  locale: Locale;
  author: AuthorView;
  type: WorkType | null;
  page: number;
  works: ArticleView[];
};

/** Sorted newest first; type filtering and pagination stay in the view. */
export async function loadAuthorPage(
  options: { locale: Locale; author: AuthorView; type?: WorkType | null; page?: number },
): Promise<AuthorPageData> {
  const works = (await listPublicArticles({
    locale: options.locale,
    authorUsername: options.author.username,
    limit: AUTHOR_WORKS_LIMIT,
  })).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  return {
    locale: options.locale,
    author: options.author,
    type: options.type ?? null,
    page: options.page ?? 1,
    works,
  };
}

export type SearchPageData = {
  locale: Locale;
  query: string;
  tab: SearchTab;
  type: WorkType | null;
  works: ArticleView[];
  categories: CategoryView[];
};

/**
 * 搜索：只使用现有 API——作品列表（query）与分类列表（query）。
 * “作者”结果由匹配作品的作者汇总得出，没有单独的作者检索接口。
 *
 * The category call is failure-isolated on purpose: a broken taxonomy endpoint
 * must degrade the page to "works only", not turn search into a 500.
 */
export async function loadSearchPage(
  options: { locale: Locale; query: string; tab?: SearchTab; type?: WorkType | null },
): Promise<SearchPageData> {
  const locale = options.locale;
  const query = options.query ?? "";
  const tab = options.tab ?? "works";
  const type = options.type ?? null;
  const q = query.trim();
  const [works, categories] = q
    ? await Promise.all([
      listPublicArticles({ locale, query: q, limit: SEARCH_WORKS_LIMIT }),
      listPublicCategories({ locale, query: q, limit: SEARCH_CATEGORY_LIMIT }).catch((): CategoryView[] => []),
    ])
    : [[] as ArticleView[], [] as CategoryView[]];
  return { locale, query, tab, type, works, categories };
}

export type CategoryIndexData = {
  locale: Locale;
  query: string;
  page: number;
  categories: CategoryView[];
  hasNextPage: boolean;
};

export async function loadCategoryIndexPage(
  options: { locale: Locale; query?: string; page?: number },
): Promise<CategoryIndexData> {
  const locale = options.locale;
  const query = options.query ?? "";
  const page = options.page ?? 1;
  const offset = (page - 1) * CATEGORY_PAGE_SIZE;
  const results = await listPublicCategories({ locale, query, limit: CATEGORY_PAGE_SIZE + 1, offset });
  return { locale, query, page, categories: results.slice(0, CATEGORY_PAGE_SIZE), hasNextPage: results.length > CATEGORY_PAGE_SIZE };
}

export type CategoryDetailData = {
  locale: Locale;
  category: CategoryView | null;
  articles: ArticleView[];
  page: number;
  hasNextPage: boolean;
};

/**
 * Category detail, two calls issued together.
 *
 * `category === null` means the route must answer 404 *before* any HTML is
 * committed (a soft 404 would be indexed), which is why the null is returned as
 * data instead of being thrown here: the framework adapter decides how its own
 * 404 is expressed.
 */
export async function loadCategoryDetailPage(
  options: { locale: Locale; slug: string; page?: number },
): Promise<CategoryDetailData> {
  const locale = options.locale;
  const page = options.page ?? 1;
  const offset = (page - 1) * CATEGORY_PAGE_SIZE;
  const [category, results] = await Promise.all([
    getPublicCategory(options.slug, locale),
    listPublicCategoryArticles(options.slug, locale, CATEGORY_PAGE_SIZE + 1, offset),
  ]);
  return {
    locale,
    category,
    articles: results.slice(0, CATEGORY_PAGE_SIZE),
    page,
    hasNextPage: results.length > CATEGORY_PAGE_SIZE,
  };
}

export const HOME_LATEST_LIMIT = 10;
export const HOME_CATEGORY_LIMIT = 8;

export type HomePageData = {
  locale: Locale;
  articles: ArticleView[];
  categories: CategoryView[];
};

/**
 * Home page data: the newest articles plus the category chips.
 *
 * Two calls, run together. The category read is failure-isolated — a broken
 * taxonomy endpoint must degrade the topics row to the work-type fallback, not
 * take the home page down with it.
 */
export async function loadHomePage(options: { locale: Locale }): Promise<HomePageData> {
  const [articles, categories] = await Promise.all([
    listPublicArticles({ locale: options.locale, limit: HOME_LATEST_LIMIT }),
    listPublicCategories({ locale: options.locale, limit: HOME_CATEGORY_LIMIT }).catch((): CategoryView[] => []),
  ]);
  return { locale: options.locale, articles, categories };
}

/* ------------------------------------------------------------------ 阅读页 */

/** How many articles are scanned for previous/next and related links. */
export const ARTICLE_SCAN_LIMIT = 100;

/** Related works shown at the foot of an article. */
export const ARTICLE_RELATED_LIMIT = 3;

export type ArticleDetailPageData = {
  locale: Locale;
  article: ArticleView;
  /** The next-newer and next-older work, when the scan found them. */
  newer?: ArticleView;
  older?: ArticleView;
  related: ArticleView[];
};

/**
 * Article detail.
 *
 * `null` means "no such article", which each framework turns into its own 404:
 * the App Router calls `notFound()`, the prototype throws `entityNotFound()`. The
 * view never has to know which.
 *
 * Two calls, and the second is optional in the strictest sense — the article is
 * the page, while the scan only decorates it, so a failure there degrades to an
 * article without neighbours instead of a broken page.
 */
export async function loadArticleDetailPage(options: {
  slug: string;
  locale: Locale;
}): Promise<ArticleDetailPageData | null> {
  const { slug, locale } = options;
  const article = await getPublicArticle(slug, locale);
  if (!article) return null;
  const everything = await listPublicArticles({ locale, limit: ARTICLE_SCAN_LIMIT })
    .then((items) => [...items].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)))
    .catch((): ArticleView[] => []);
  const position = everything.findIndex((candidate) => candidate.slug === article.slug);
  const others = everything.filter((candidate) => candidate.slug !== article.slug);
  const sameAuthor = others.filter((candidate) => candidate.author.username === article.author.username);
  const related = [
    ...sameAuthor,
    ...others.filter((candidate) => candidate.author.username !== article.author.username),
  ].slice(0, ARTICLE_RELATED_LIMIT);
  return {
    locale,
    article,
    ...(position > 0 ? { newer: everything[position - 1] } : {}),
    ...(position >= 0 && position < everything.length - 1 ? { older: everything[position + 1] } : {}),
    related,
  };
}
