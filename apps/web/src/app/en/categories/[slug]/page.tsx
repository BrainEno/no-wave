import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CategoryDetailContent } from "@/components/discovery-pages";
import { getPublicCategory, listPublicCategoryArticles } from "@/lib/api-content.mjs";

type PageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const category = await getPublicCategory(slug, "en");
  return category ? {
    title: category.name,
    description: category.description || `Published works in the “${category.name}” category.`,
  } : {};
}

export default async function EnglishCategoryPage({ params }: PageProps) {
  const { slug } = await params;
  const category = await getPublicCategory(slug, "en");
  if (!category) notFound();
  const articles = await listPublicCategoryArticles(slug, "en");
  return <CategoryDetailContent locale="en" category={category} articles={articles} />;
}
