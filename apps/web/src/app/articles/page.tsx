import type { Metadata } from "next";
import { ArticleArchiveContent } from "@/components/content-pages";
import { archiveMetadata, defaultLocale } from "@/lib/content.ts";

export const metadata: Metadata = archiveMetadata(defaultLocale) as Metadata;

type PageProps = { searchParams: Promise<{ q?: string | string[]; page?: string | string[] }> };

export default async function ArticlesPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : "";
  const requestedPage = typeof params.page === "string" ? Number(params.page) : 1;
  const page = Number.isSafeInteger(requestedPage) && requestedPage >= 1 && requestedPage <= 5001
    ? requestedPage
    : 1;
  return <ArticleArchiveContent locale={defaultLocale} query={query} page={page} />;
}
