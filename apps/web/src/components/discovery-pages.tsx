import Link from "next/link";
import type { ArticleView, Locale } from "@/lib/content.mjs";
import type { CategoryView } from "@/lib/api-content.mjs";
import { archivePath, articlePath, authorPath, homePath } from "@/lib/content.mjs";

function DiscoveryNavigation({ locale }: { locale: Locale }) {
  const alternateLocale: Locale = locale === "en" ? "zh-CN" : "en";
  return (
    <header>
      <nav aria-label={locale === "en" ? "Primary navigation" : "主导航"}>
        <Link href={homePath(locale)}>{locale === "en" ? "Nowave" : "无浪潮"}</Link>{" · "}
        <Link href={archivePath(locale)}>{locale === "en" ? "Latest works" : "最新发表"}</Link>{" · "}
        <Link href={locale === "en" ? "/en/categories" : "/categories"}>{locale === "en" ? "Categories" : "作品分类"}</Link>{" · "}
        <Link href={homePath(alternateLocale)} lang={alternateLocale}>{locale === "en" ? "简体中文" : "English"}</Link>
      </nav>
    </header>
  );
}

export function CategoryIndexContent({ locale, categories }: { locale: Locale; categories: CategoryView[] }) {
  const english = locale === "en";
  return (
    <main lang={locale} style={{ maxWidth: 960, margin: "4rem auto", padding: "0 1.25rem" }}>
      <DiscoveryNavigation locale={locale} />
      <p>{english ? "THE READING ROOM / INDEX" : "阅读室 / 分类索引"}</p>
      <h1>{english ? "Explore by category" : "按分类发现作品"}</h1>
      <p>{english
        ? "Browse the publication's living taxonomy. Categories are maintained as real publication data, not a fixed list in the interface."
        : "從平台實際維護的作品分類進入閱讀。分類來自出版資料，而不是寫死在介面中的標籤清單。"}</p>
      {categories.length === 0 ? (
        <p role="status">{english ? "No categories have been published yet." : "目前尚無可瀏覽的作品分類。"}</p>
      ) : (
        <ol>
          {categories.map((category, index) => (
            <li key={category.slug} style={{ borderTop: "1px solid currentColor", padding: "1rem 0", display: "grid", gridTemplateColumns: "3rem minmax(0, 1fr) auto", gap: "1rem" }}>
              <span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
              <div>
                <h2 style={{ margin: "0 0 .4rem" }}><Link href={`${locale === "en" ? "/en" : ""}/categories/${encodeURIComponent(category.slug)}`}>{category.name}</Link></h2>
                {category.description ? <p>{category.description}</p> : null}
              </div>
              <span>{category.articleCount} {english ? "works" : "篇作品"}</span>
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}

export function CategoryDetailContent({ locale, category, articles }: { locale: Locale; category: CategoryView; articles: ArticleView[] }) {
  const english = locale === "en";
  return (
    <main lang={locale} style={{ maxWidth: 820, margin: "4rem auto", padding: "0 1.25rem" }}>
      <DiscoveryNavigation locale={locale} />
      <p><Link href={locale === "en" ? "/en/categories" : "/categories"}>{english ? "All categories" : "全部分類"}</Link></p>
      <p>{english ? "READING INDEX" : "作品分類"}</p>
      <h1>{category.name}</h1>
      {category.description ? <p>{category.description}</p> : null}
      <p>{category.articleCount} {english ? "published works" : "篇已發表作品"}</p>
      {articles.length === 0 ? (
        <p role="status">{english ? "There are no published works in this category yet." : "此分類目前尚無已發表作品。"}</p>
      ) : (
        <ol>
          {articles.map((article, index) => (
            <li key={article.slug} style={{ borderTop: "1px solid currentColor", padding: "1.25rem 0" }}>
              <article>
                <p>{String(index + 1).padStart(2, "0")}</p>
                <h2><Link href={articlePath(article.slug, locale)}>{article.title}</Link></h2>
                {article.description ? <p>{article.description}</p> : null}
                <p>{english ? "By" : "作者"} <Link href={authorPath(article.author.username, locale)}>{article.author.displayName}</Link></p>
                <time dateTime={article.publishedAt}>{new Date(article.publishedAt).toLocaleDateString(locale, { dateStyle: "medium", timeZone: "UTC" })}</time>
              </article>
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
