import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CategoryDetailContent } from "@/components/discovery-pages";
import { getPublicCategory, listPublicCategoryArticles } from "@/lib/api-content.mjs";

type PageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const category = await getPublicCategory(slug, "zh-TW");
  return category ? {
    title: category.name,
    description: category.description || `瀏覽「${category.name}」分類中的已發表作品。`,
  } : {};
}

export default async function CategoryPage({ params }: PageProps) {
  const { slug } = await params;
  const category = await getPublicCategory(slug, "zh-TW");
  if (!category) notFound();
  const articles = await listPublicCategoryArticles(slug, "zh-TW");
  return <CategoryDetailContent locale="zh-TW" category={category} articles={articles} />;
}
