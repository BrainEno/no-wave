import type { Metadata } from "next";
import { CategoryIndexContent } from "@/components/discovery-pages";
import { listPublicCategories } from "@/lib/api-content.mjs";

export const metadata: Metadata = {
  title: "Categories",
  description: "Discover published writing through Nowave's maintained categories.",
};

type PageProps = { searchParams: Promise<{ q?: string | string[]; page?: string | string[] }> };

export default async function EnglishCategoriesPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : "";
  const requestedPage = typeof params.page === "string" ? Number(params.page) : 1;
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, 50001) : 1;
  const pageSize = 20;
  const results = await listPublicCategories({ locale: "en", query, limit: pageSize + 1, offset: (page - 1) * pageSize });
  return <CategoryIndexContent locale="en" categories={results.slice(0, pageSize)} query={query} page={page} hasNextPage={results.length > pageSize} />;
}
