import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArticleDetailContent } from "@/components/content-pages";
import { articleMetadata, defaultLocale } from "@/lib/content.mjs";
import { getPublicArticle } from "@/lib/api-content.mjs";

type PageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const article = await getPublicArticle(slug, defaultLocale);
  if (!article) return {};
  return articleMetadata(article, process.env.NEXT_PUBLIC_SITE_URL ?? "https://example.invalid") as Metadata;
}

export default async function ArticlePage({ params }: PageProps) {
  const { slug } = await params;
  const article = await getPublicArticle(slug, defaultLocale);
  if (!article) notFound();
  return <ArticleDetailContent article={article} />;
}
