import type { ArticleView, AuthorView, Locale } from "./content.mjs";

export type WorkType = "novel" | "short_story" | "poetry" | "essay" | "criticism" | "literary_criticism" | "nonfiction" | "serial" | "other";

export type CategoryView = {
  slug: string;
  name: string;
  description: string;
  locale: string;
  articleCount: number;
};

export function createApiContentClient(options: {
  endpoint?: string;
  fetchImpl?: (input: string, init?: Record<string, unknown>) => Promise<{
    ok: boolean;
    status: number;
    json(): Promise<{ data?: Record<string, unknown>; errors?: unknown[] }>;
  }>;
}): {
  listArticles(options?: { locale?: Locale; query?: string; authorUsername?: string | null; limit?: number; offset?: number }): Promise<ArticleView[]>;
  getArticleBySlug(slug: string, locale?: Locale): Promise<ArticleView | null>;
  getAuthorByUsername(username: string, locale?: Locale): Promise<AuthorView | null>;
  listCategories(options?: { locale?: Locale; query?: string; limit?: number; offset?: number }): Promise<CategoryView[]>;
  getCategoryBySlug(slug: string, locale?: Locale): Promise<CategoryView | null>;
  listCategoryArticles(slug: string, locale?: Locale, limit?: number, offset?: number): Promise<ArticleView[]>;
};
export function listPublicArticles(options?: { locale?: Locale; query?: string; authorUsername?: string | null; limit?: number; offset?: number }): Promise<ArticleView[]>;
export function getPublicArticle(slug: string, locale?: Locale): Promise<ArticleView | null>;
export function getPublicAuthor(username: string, locale?: Locale): Promise<AuthorView | null>;
export function listPublicCategories(options?: { locale?: Locale; query?: string; limit?: number; offset?: number }): Promise<CategoryView[]>;
export function getPublicCategory(slug: string, locale?: Locale): Promise<CategoryView | null>;
export function listPublicCategoryArticles(slug: string, locale?: Locale, limit?: number, offset?: number): Promise<ArticleView[]>;
