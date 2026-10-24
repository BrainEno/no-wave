import type { Metadata } from "next";
import { CategoryIndexContent } from "@/components/discovery-pages";
import { listPublicCategories } from "@/lib/api-content.mjs";

export const metadata: Metadata = {
  title: "作品分类",
  description: "从无浪潮实际维护的作品分类中发现值得阅读的文学作品。",
};

export default async function CategoriesPage() {
  const categories = await listPublicCategories({ locale: "zh-TW" });
  return <CategoryIndexContent locale="zh-TW" categories={categories} />;
}
