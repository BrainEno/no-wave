import type { MetadataRoute } from "next";
import {
  archivePath,
  articlePath,
  authorPath,
  homePath,
  supportedLocales
} from "@/lib/content.ts";
import { listPublicArticles } from "@/lib/api-content.ts";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://example.invalid";
  const result: MetadataRoute.Sitemap = [];
  const seenAuthors = new Set<string>();
  for (const locale of supportedLocales) {
    result.push({
      url: new URL(homePath(locale), baseUrl).toString(),
      changeFrequency: "daily",
      priority: 1
    });
    result.push({
      url: new URL(archivePath(locale), baseUrl).toString(),
      changeFrequency: "daily",
      priority: 0.8
    });
    const pageSize = 100;
    let offset = 0;
    while (true) {
      const articles = await listPublicArticles({ locale, limit: pageSize, offset });
      for (const article of articles) {
        result.push({
          url: new URL(articlePath(article.slug, locale), baseUrl).toString(),
          lastModified: new Date(article.publishedAt),
          changeFrequency: "weekly",
          priority: 0.7
        });
        const authorKey = locale + ":" + article.author.username;
        if (!seenAuthors.has(authorKey)) {
          seenAuthors.add(authorKey);
          result.push({
            url: new URL(authorPath(article.author.username, locale), baseUrl).toString(),
            changeFrequency: "weekly",
            priority: 0.5
          });
        }
      }
      if (articles.length < pageSize) break;
      offset += articles.length;
    }
  }
  return result;
}
