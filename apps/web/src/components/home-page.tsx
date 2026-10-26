import type { ArticleView, Locale } from "@/lib/content.ts";
import type { CategoryView } from "@/lib/api-content.ts";
import { HomeExperience } from "./home/home-experience";

export function LiteraryHomePage({
  locale,
  articles,
  categories,
}: {
  locale: Locale;
  articles: ArticleView[];
  categories: CategoryView[];
}) {
  return <HomeExperience locale={locale} articles={articles} categories={categories} />;
}
