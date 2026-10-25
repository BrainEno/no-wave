export const siteUrl: string;
export type Locale = "zh-CN" | "zh-TW" | "en";
export const defaultLocale: Locale;
export const supportedLocales: readonly Locale[];
export type AuthorView = {
  username: string;
  displayName: string;
  bio: string;
  locale: Locale;
  availableLocales: Locale[];
};
export type ArticleContentBlock =
  | { id: string; type: "paragraph"; text: string }
  | { id: string; type: "heading"; level: 2 | 3 | 4; text: string; anchor?: string }
  | { id: string; type: "quote"; text: string; attribution?: string }
  | { id: string; type: "list"; ordered: boolean; items: string[] }
  | { id: string; type: "image"; src: string; alt: string; caption?: string }
  | { id: string; type: "code"; language: string; code: string };
export type ArticleView = {
  slug: string;
  title: string;
  description: string;
  workType: "novel" | "short_story" | "poetry" | "essay" | "criticism" | "literary_criticism" | "nonfiction" | "serial" | "other";
  contentBlocks: ArticleContentBlock[];
  publishedAt: string;
  author: AuthorView;
  categories: string[];
  tags: string[];
  locale: Locale;
  availableLocales: Locale[];
};
export type SiteMessages = {
  primaryNavigation: string;
  homeTitle: string;
  homeDescription: string;
  blog: string;
  blogTitle: string;
  blogDescription: string;
  latestArticles: string;
  searchLabel: string;
  searchPlaceholder: string;
  searchButton: string;
  emptyResults: string;
  readArticle: string;
  authorPrefix: string;
  switchLanguage: string;
  backToArticles: string;
  publishedOn: string;
  authorProfile: string;
  noAuthorArticles: string;
  previousPage: string;
  nextPage: string;
  pageLabel: string;
  workTypeLabels: Record<ArticleView["workType"], string>;
};
export const articleFixture: ArticleView;
export function getMessages(locale?: Locale): SiteMessages;
export function homePath(locale?: Locale): string;
export function archivePath(locale?: Locale): string;
export function articlePath(slug: string, locale?: Locale): string;
export function authorPath(username: string, locale?: Locale): string;
export function getAuthorByUsername(username: string, locale?: Locale): AuthorView | null;
export function getArticleBySlug(slug: string, locale?: Locale): ArticleView | null;
export function listArticles(options?: { locale?: Locale; query?: string; authorUsername?: string | null; limit?: number; offset?: number }): ArticleView[];
export function articleMetadata(article: ArticleView, baseUrl?: string): {
  title: string;
  description: string;
  alternates: { canonical: string; languages: Record<string, string> };
  openGraph: { type: string; title: string; description: string; url: string; locale: string };
};
export function archiveMetadata(locale?: Locale, baseUrl?: string): {
  title: string;
  description: string;
  alternates: { canonical: string; languages: Record<string, string> };
};
export function homeMetadata(locale?: Locale, baseUrl?: string): {
  title: string;
  description: string;
  alternates: { canonical: string; languages: Record<string, string> };
};
export function authorMetadata(author: AuthorView, baseUrl?: string): {
  title: string;
  description: string;
  alternates: { canonical: string; languages: Record<string, string> };
};
