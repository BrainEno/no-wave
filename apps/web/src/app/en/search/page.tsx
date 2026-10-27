import type { Metadata } from "next";
import { SearchContent, parseTab } from "@/components/search-page.tsx";
import { parseWorkType } from "@/lib/work-types.ts";

export const metadata: Metadata = { title: "Search", description: "Search works, authors and categories published on No Wave.", robots: { index: false, follow: true } };

type PageProps = { searchParams: Promise<{ q?: string | string[]; tab?: string | string[]; type?: string | string[] }> };

export default async function EnglishSearchPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q.slice(0, 100) : "";
  return <SearchContent locale="en" query={query} tab={parseTab(params.tab)} type={parseWorkType(params.type)} />;
}
