import type { Metadata } from "next";
import { defaultLocale } from "@/lib/content.ts";
import { CategoryIndexContent } from "@/components/discovery-pages";
import { listPublicCategories } from "@/lib/api-content.ts";

export const metadata: Metadata = {
  title: "作品分类",
  description: "从无浪潮实际维护的作品分类中发现值得阅读的文学作品。",
};

type PageProps = { searchParams: Promise<{ q?: string | string[]; page?: string | string[] }> };

export default async function CategoriesPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : "";
  const requestedPage = typeof params.page === "string" ? Number(params.page) : 1;
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, 50001) : 1;
  const pageSize = 20;
  const results = await listPublicCategories({ locale: defaultLocale, query, limit: pageSize + 1, offset: (page - 1) * pageSize });
  return <CategoryIndexContent locale={defaultLocale} categories={results.slice(0, pageSize)} query={query} page={page} hasNextPage={results.length > pageSize} />;
}
