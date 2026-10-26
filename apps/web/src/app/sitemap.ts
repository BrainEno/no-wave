import type { MetadataRoute } from "next";
import {
  archivePath,
  articlePath,
  authorPath,
  homePath,
  listArticles,
  supportedLocales
} from "@/lib/content.ts";

export default function sitemap(): MetadataRoute.Sitemap {
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
    for (const article of listArticles({ locale })) {
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
  }
  return result;
}
