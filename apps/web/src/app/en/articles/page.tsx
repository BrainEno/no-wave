import type { Metadata } from "next";
import { ArticleArchiveContent } from "@/components/content-pages";
import { archiveMetadata } from "@/lib/content.ts";
import { configuredSiteUrl } from "@/lib/site-metadata.ts";
import { parsePage, parseWorkType } from "@/lib/work-types.ts";

export const metadata: Metadata = archiveMetadata("en", configuredSiteUrl()) as Metadata;

type PageProps = { searchParams: Promise<{ q?: string | string[]; page?: string | string[]; type?: string | string[] }> };

export default async function EnglishArticlesPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : "";
  return <ArticleArchiveContent locale="en" query={query} page={parsePage(params.page)} type={parseWorkType(params.type)} />;
}
