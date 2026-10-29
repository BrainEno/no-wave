import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArticleDetailContent } from "@/components/content-pages";
import { articleMetadata } from "@/lib/content.ts";
import { configuredSiteUrl } from "@/lib/site-metadata.ts";
import { getPublicArticle } from "@/lib/api-content.ts";

type PageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const article = await getPublicArticle(slug, "en");
  // 在流式外壳发出前抛出 notFound()，保证未知文章返回 404 状态码（而非软 404）。
  if (!article) notFound();
  return articleMetadata(article, configuredSiteUrl()) as Metadata;
}

export default async function EnglishArticlePage({ params }: PageProps) {
  const { slug } = await params;
  const article = await getPublicArticle(slug, "en");
  if (!article) notFound();
  return <ArticleDetailContent article={article} />;
}
