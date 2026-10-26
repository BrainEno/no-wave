import Link from "next/link";
import type { ArticleView, Locale } from "@/lib/content.ts";
import type { CategoryView } from "@/lib/api-content.ts";
import { archivePath, articlePath, authorPath, homePath } from "@/lib/content.ts";

function categoryIndexPageHref(indexPath: string, query: string, page: number) {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  params.set("page", String(page));
  return `${indexPath}?${params.toString()}`;
}

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

export function CategoryIndexContent({ locale, categories, query = "", page = 1, hasNextPage = false }: { locale: Locale; categories: CategoryView[]; query?: string; page?: number; hasNextPage?: boolean }) {
  const english = locale === "en";
  const indexPath = english ? "/en/categories" : "/categories";
  return (
    <main lang={locale} style={{ maxWidth: 960, margin: "4rem auto", padding: "0 1.25rem" }}>
      <DiscoveryNavigation locale={locale} />
      <p>{english ? "THE READING ROOM / INDEX" : "阅读室 / 分类索引"}</p>
      <h1>{english ? "Explore by category" : "按分类发现作品"}</h1>
      <p>{english
        ? "Browse the publication's living taxonomy. Categories are maintained as real publication data, not a fixed list in the interface."
        : "從平台實際維護的作品分類進入閱讀。分類來自出版資料，而不是寫死在介面中的標籤清單。"}</p>
      <form action={indexPath} method="get" role="search" style={{ display: "flex", gap: ".5rem", margin: "1.5rem 0" }}>
        <label htmlFor="category-search">{english ? "Search categories" : "搜尋分類"}</label>
        <input id="category-search" name="q" type="search" defaultValue={query} placeholder={english ? "Enter a category name" : "輸入分類名稱"} />
        <button type="submit">{english ? "Search" : "搜尋"}</button>
        {query ? <Link href={indexPath}>{english ? "Clear" : "清除"}</Link> : null}
      </form>
      {categories.length === 0 ? (
        <p role="status">{page > 1
          ? (english ? "No more categories are available on this page." : "此頁沒有更多分類。")
          : query
            ? (english ? "No categories match your search." : "沒有符合搜尋條件的分類。")
            : (english ? "No categories have been published yet." : "目前尚無可瀏覽的作品分類。")}</p>
      ) : (
        <ol>
          {categories.map((category, index) => (
            <li key={category.slug} style={{ borderTop: "1px solid currentColor", padding: "1rem 0", display: "grid", gridTemplateColumns: "3rem minmax(0, 1fr) auto", gap: "1rem" }}>
              <span aria-hidden="true">{String((page - 1) * 20 + index + 1).padStart(2, "0")}</span>
              <div>
                <h2 style={{ margin: "0 0 .4rem" }}><Link href={`${locale === "en" ? "/en" : ""}/categories/${encodeURIComponent(category.slug)}`}>{category.name}</Link></h2>
                {category.description ? <p>{category.description}</p> : null}
              </div>
              <span>{category.articleCount} {english ? "works" : "篇作品"}</span>
            </li>
          ))}
        </ol>
      )}
      {categories.length > 0 || page > 1 ? (
        <nav aria-label={english ? "Category pages" : "分類頁面"} style={{ display: "flex", gap: "1rem", marginTop: "2rem" }}>
          {page > 1 ? <Link rel="prev" href={categoryIndexPageHref(indexPath, query, page - 1)}>{english ? "Previous categories" : "上一頁分類"}</Link> : null}
          {hasNextPage ? <Link rel="next" href={categoryIndexPageHref(indexPath, query, page + 1)}>{english ? "More categories" : "下一頁分類"}</Link> : null}
          <span aria-current="page">{english ? "Page " + page : "第 " + page + " 頁"}</span>
        </nav>
      ) : null}
    </main>
  );
}

export function CategoryDetailContent({ locale, category, articles, page = 1, hasNextPage = false }: { locale: Locale; category: CategoryView; articles: ArticleView[]; page?: number; hasNextPage?: boolean }) {
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
        <p role="status">{page > 1
          ? (english ? "No more works are available on this page." : "此頁沒有更多作品。")
          : (english ? "There are no published works in this category yet." : "此分類目前尚無已發表作品。")}</p>
      ) : (
        <ol>
          {articles.slice(0, 20).map((article, index) => (
            <li key={article.slug} style={{ borderTop: "1px solid currentColor", padding: "1.25rem 0" }}>
              <article>
                <p>{String((page - 1) * 20 + index + 1).padStart(2, "0")}</p>
                <h2><Link href={articlePath(article.slug, locale)}>{article.title}</Link></h2>
                {article.description ? <p>{article.description}</p> : null}
                <p>{english ? "By" : "作者"} <Link href={authorPath(article.author.username, locale)}>{article.author.displayName}</Link></p>
                <time dateTime={article.publishedAt}>{new Date(article.publishedAt).toLocaleDateString(locale, { dateStyle: "medium", timeZone: "UTC" })}</time>
              </article>
            </li>
          ))}
        </ol>
      )}
      <nav aria-label={english ? "Category pages" : "分類頁面"} style={{ display: "flex", gap: "1rem", marginTop: "2rem" }}>
        {page > 1 ? <Link rel="prev" href={"?page=" + (page - 1)}>{english ? "Previous works" : "上一頁作品"}</Link> : null}
        {hasNextPage ? <Link rel="next" href={"?page=" + (page + 1)}>{english ? "More works" : "下一頁作品"}</Link> : null}
        <span aria-current="page">{english ? "Page " + page : "第 " + page + " 頁"}</span>
      </nav>
    </main>
  );
}
