import type { Metadata } from "next";
import { CategoryIndexContent } from "@/components/discovery-pages";
import { listPublicCategories } from "@/lib/api-content.mjs";

export const metadata: Metadata = {
  title: "作品分类",
  description: "从无浪潮实际维护的作品分类中发现值得阅读的文学作品。",
};

type PageProps = { searchParams: Promise<{ q?: string | string[] }> };

export default async function CategoriesPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : "";
  const categories = await listPublicCategories({ locale: "zh-TW", query });
  return <CategoryIndexContent locale="zh-TW" categories={categories} query={query} />;
}
