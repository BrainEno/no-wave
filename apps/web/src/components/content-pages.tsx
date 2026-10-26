import Link from "next/link";
import type { ArticleView, AuthorView, Locale } from "@/lib/content.ts";
import {
  archivePath,
  articlePath,
  authorPath,
  getMessages,
  homePath,
 } from "@/lib/content.ts";
import { listPublicArticles, listPublicCategories } from "@/lib/api-content.ts";
import { LiteraryHomePage } from "./home-page";

const ARCHIVE_PAGE_SIZE = 20;

function archivePageHref(locale: Locale, query: string, page: number) {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (page > 1) params.set("page", String(page));
  const suffix = params.toString();
  return suffix ? `${archivePath(locale)}?${suffix}` : archivePath(locale);
}

function SiteNavigation({ locale }: { locale: Locale }) {
  const copy = getMessages(locale);
  const alternateLocale: Locale = locale === "en" ? "zh-CN" : "en";
  return (
    <header>
      <nav aria-label={copy.primaryNavigation}>
        <Link href={homePath(locale)}>{locale === "en" ? "Nowave" : "无浪潮"}</Link>{" · "}
        <Link href={archivePath(locale)}>{locale === "en" ? "Latest works" : "最新发表"}</Link>{" · "}
        <Link href={locale === "en" ? "/en/categories" : "/categories"}>{locale === "en" ? "Categories" : "作品分类"}</Link>{" · "}
        <Link href={homePath(alternateLocale)} lang={alternateLocale}>{copy.switchLanguage}</Link>
      </nav>
    </header>
  );
}

export async function HomeContent({ locale }: { locale: Locale }) {
  const [articles, categories] = await Promise.all([
    listPublicArticles({ locale }),
    listPublicCategories({ locale }),
  ]);
  return <LiteraryHomePage locale={locale} articles={articles} categories={categories} />;
}

export async function ArticleArchiveContent({ locale, query, page = 1 }: { locale: Locale; query: string; page?: number }) {
  const copy = getMessages(locale);
  const articles = await listPublicArticles({
    locale,
    query,
    limit: ARCHIVE_PAGE_SIZE + 1,
    offset: (page - 1) * ARCHIVE_PAGE_SIZE,
  });
  const visibleArticles = articles.slice(0, ARCHIVE_PAGE_SIZE);
  const hasNextPage = page < 5001 && articles.length > ARCHIVE_PAGE_SIZE;
  return (
    <main lang={locale} style={{ maxWidth: 760, margin: "4rem auto", padding: "0 1.25rem" }}>
      <SiteNavigation locale={locale} />
      <h1>{copy.blogTitle}</h1>
      <p>{copy.blogDescription}</p>
      <form action={archivePath(locale)} method="get" role="search">
        <label htmlFor="article-search">{copy.searchLabel}</label>
        <input id="article-search" name="q" type="search" defaultValue={query} placeholder={copy.searchPlaceholder} />
        <button type="submit">{copy.searchButton}</button>
      </form>
      <p>{visibleArticles.length} {locale === "en" ? "works" : "篇作品"}</p>
      {visibleArticles.length === 0 ? <p role="status">{copy.emptyResults}</p> : (
        <ol>
          {visibleArticles.map((article) => (
            <li key={article.slug}>
              <article>
                <p>{copy.workTypeLabels[article.workType]}</p>
                <h2><Link href={articlePath(article.slug, locale)}>{article.title}</Link></h2>
                <p>{article.description}</p>
                <p>{copy.authorPrefix} <Link href={authorPath(article.author.username, locale)}>{article.author.displayName}</Link></p>
                <time dateTime={article.publishedAt}>{new Date(article.publishedAt).toLocaleDateString(locale, { dateStyle: "medium", timeZone: "UTC" })}</time>
              </article>
            </li>
          ))}
        </ol>
      )}
      {(page > 1 || hasNextPage) && (
        <nav aria-label={copy.blogTitle} style={{ display: "flex", gap: "1rem", justifyContent: "space-between", marginTop: "2rem" }}>
          {page > 1
            ? <Link rel="prev" href={archivePageHref(locale, query, page - 1)}>{copy.previousPage}</Link>
            : <span />}
          <span aria-current="page">{copy.pageLabel.replace("{page}", String(page))}</span>
          {hasNextPage
            ? <Link rel="next" href={archivePageHref(locale, query, page + 1)}>{copy.nextPage}</Link>
            : <span />}
        </nav>
      )}
    </main>
  );
}

export function ArticleDetailContent({ article }: { article: ArticleView }) {
  const copy = getMessages(article.locale);
  return (
    <main lang={article.locale} style={{ maxWidth: 760, margin: "4rem auto", padding: "0 1.25rem" }}>
      <SiteNavigation locale={article.locale} />
      <p><Link href={archivePath(article.locale)}>{copy.backToArticles}</Link></p>
      <article>
        <p>{copy.publishedOn} <time dateTime={article.publishedAt}>{new Date(article.publishedAt).toLocaleDateString(article.locale, { dateStyle: "medium", timeZone: "UTC" })}</time></p>
        <p>{copy.workTypeLabels[article.workType]}</p>
        <h1>{article.title}</h1>
        <p>{article.description}</p>
        <p>{copy.authorPrefix} <Link href={authorPath(article.author.username, article.locale)}>{article.author.displayName}</Link></p>
        <div className="article-body">
          {article.contentBlocks.map((block) => {
            switch (block.type) {
              case "paragraph":
                return <p key={block.id}>{block.text}</p>;
              case "heading": {
                const Heading = block.level === 4 ? "h4" : block.level === 3 ? "h3" : "h2";
                return <Heading key={block.id} id={block.anchor}>{block.text}</Heading>;
              }
              case "quote":
                return <blockquote key={block.id}><p>{block.text}</p>{block.attribution ? <cite>{block.attribution}</cite> : null}</blockquote>;
              case "list": {
                const List = block.ordered ? "ol" : "ul";
                return <List key={block.id}>{block.items.map((item, index) => <li key={String(index)}>{item}</li>)}</List>;
              }
              case "image":
                return <figure key={block.id}><img src={block.src} alt={block.alt} loading="lazy" />{block.caption ? <figcaption>{block.caption}</figcaption> : null}</figure>;
              case "code":
                return <pre key={block.id}><code data-language={block.language}>{block.code}</code></pre>;
            }
          })}
        </div>
      </article>
    </main>
  );
}

export async function AuthorProfileContent({ locale, author }: { locale: Locale; author: AuthorView }) {
  const copy = getMessages(locale);
  const articles = await listPublicArticles({ locale, authorUsername: author.username });
  return (
    <main lang={locale} style={{ maxWidth: 760, margin: "4rem auto", padding: "0 1.25rem" }}>
      <SiteNavigation locale={locale} />
      <h1>{author.displayName}</h1>
      <p>{author.bio}</p>
      <h2>{copy.authorProfile}</h2>
      {articles.length === 0 ? <p>{copy.noAuthorArticles}</p> : (
        <ul>
          {articles.map((article) => (
            <li key={article.slug}><Link href={articlePath(article.slug, locale)}>{article.title}</Link></li>
          ))}
        </ul>
      )}
    </main>
  );
}
