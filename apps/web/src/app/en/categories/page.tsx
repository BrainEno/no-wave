import type { Metadata } from "next";
import { CategoryIndexContent } from "@/components/discovery-pages";
import { listPublicCategories } from "@/lib/api-content.mjs";

export const metadata: Metadata = {
  title: "Categories",
  description: "Discover published writing through Nowave's maintained categories.",
};

export default async function EnglishCategoriesPage() {
  const categories = await listPublicCategories({ locale: "en" });
  return <CategoryIndexContent locale="en" categories={categories} />;
}
