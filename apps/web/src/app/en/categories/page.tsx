import type { Metadata } from "next";
import { CategoryIndexContent } from "@/components/discovery-pages";
import { listPublicCategories } from "@/lib/api-content.mjs";

export const metadata: Metadata = {
  title: "Categories",
  description: "Discover published writing through Nowave's maintained categories.",
};

type PageProps = { searchParams: Promise<{ q?: string | string[] }> };

export default async function EnglishCategoriesPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : "";
  const categories = await listPublicCategories({ locale: "en", query });
  return <CategoryIndexContent locale="en" categories={categories} query={query} />;
}
