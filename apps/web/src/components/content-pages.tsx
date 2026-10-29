import Link from "next/link";
import type { ReactNode } from "react";
import { archivePath, articlePath, authorPath, getMessages, type ArticleContentBlock, type ArticleView, type AuthorView, type Locale, type WorkType } from "@/lib/content.ts";
import { dateLabel, initial } from "@/lib/format.ts";
import { lengthLabel, minutesLabel, readingMinutes, textLength } from "@/lib/reading.ts";
import { getUi } from "@/lib/ui-copy.ts";
import { loadArchivePage, loadArticleDetailPage, loadAuthorPage } from "@/lib/public-pages.ts";
import { ArchivePageView } from "@/components/public/archive-view.tsx";
import { ArticlePageView } from "@/components/public/article-view.tsx";
import { AuthorPageView } from "@/components/public/author-view.tsx";
import { Highlight, SectionHeading, TypeChip, WorkRow } from "@/components/ui/parts.tsx";

export { HomeContent } from "@/components/home-page.tsx";

/* ---------------------------------------------------------------- 作品目录 */

/**
 * 作品目录 — App Router entry point.
 *
 * The data is loaded by the framework-neutral `loadArchivePage` and rendered by
 * the synchronous `ArchivePageView`, which is what lets the React Router prototype
 * serve the same page from the same data without an async server component.
 */
export async function ArticleArchiveContent({ locale, query = "", page = 1, type = null }: { locale: Locale; query?: string; page?: number; type?: WorkType | null }) {
  const data = await loadArchivePage({ locale, query, page, type });
  return <ArchivePageView {...data} />;
}

/* ---------------------------------------------------------------- 阅读页 */

/**
 * 阅读页 — App Router entry point.
 *
 * The data comes from the framework-neutral `loadArticleDetailPage` and the
 * markup from the synchronous `ArticlePageView`, which is what lets the React
 * Router prototype serve the same page — reader toolbar, table of contents and
 * comment section included — from the same data.
 */
export async function ArticleDetailContent({ article }: { article: ArticleView }) {
  const data = await loadArticleDetailPage({ slug: article.slug, locale: article.locale });
  if (!data) return null;
  return <ArticlePageView {...data} />;
}

/* ---------------------------------------------------------------- 作者主页 */

/**
 * 作者主页 — App Router entry point (same load/render split as the archive).
 */
export async function AuthorProfileContent({ locale, author, type = null, page = 1 }: { locale: Locale; author: AuthorView; type?: WorkType | null; page?: number }) {
  const data = await loadAuthorPage({ locale, author, type, page });
  return <AuthorPageView {...data} />;
}

export { Highlight };
