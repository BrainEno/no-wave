import type { Metadata } from "next";
import { SearchContent, parseTab } from "@/components/search-page.tsx";
import { defaultLocale } from "@/lib/content.ts";
import { parseWorkType } from "@/lib/work-types.ts";

export const metadata: Metadata = { title: "搜索", description: "按作品、作者与分类搜索无浪潮发表的文学作品。", robots: { index: false, follow: true } };

type PageProps = { searchParams: Promise<{ q?: string | string[]; tab?: string | string[]; type?: string | string[] }> };

export default async function SearchPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q.slice(0, 100) : "";
  return <SearchContent locale={defaultLocale} query={query} tab={parseTab(params.tab)} type={parseWorkType(params.type)} />;
}
