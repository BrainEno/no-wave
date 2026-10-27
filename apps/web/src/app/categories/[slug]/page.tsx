import type { Metadata } from "next";
import { defaultLocale } from "@/lib/content.ts";
import { notFound } from "next/navigation";
import { CategoryDetailContent } from "@/components/discovery-pages";
import { getPublicCategory, listPublicCategoryArticles } from "@/lib/api-content.ts";

type PageProps = { params: Promise<{ slug: string }>; searchParams: Promise<{ page?: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const category = await getPublicCategory(slug, defaultLocale);
  // 在流式外壳发出前抛出 notFound()，保证未知分类返回 404 状态码（而非软 404）。
  if (!category) notFound();
  return {
    title: category.name,
    description: category.description || `浏览「${category.name}」分类中的已发表作品。`,
  };
}

export default async function CategoryPage({ params, searchParams }: PageProps) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const parsedPage = Number.parseInt(query.page ?? "1", 10);
  const page = Number.isSafeInteger(parsedPage) && parsedPage > 0 ? Math.min(parsedPage, 50001) : 1;
  const category = await getPublicCategory(slug, defaultLocale);
  if (!category) notFound();
  const pageSize = 20;
  const results = await listPublicCategoryArticles(slug, defaultLocale, pageSize + 1, (page - 1) * pageSize);
  return <CategoryDetailContent locale={defaultLocale} category={category} articles={results.slice(0, pageSize)} page={page} hasNextPage={results.length > pageSize} />;
}
