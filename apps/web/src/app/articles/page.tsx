import type { Metadata } from "next";
import { ArticleArchiveContent } from "@/components/content-pages";
import { archiveMetadata, defaultLocale } from "@/lib/content.mjs";

export const metadata: Metadata = archiveMetadata(defaultLocale) as Metadata;

type PageProps = { searchParams: Promise<{ q?: string | string[] }> };

export default async function ArticlesPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : "";
  return <ArticleArchiveContent locale={defaultLocale} query={query} />;
}
