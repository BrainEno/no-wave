import Link from "next/link";
import type { ArticleView, Locale } from "@/lib/content.ts";
import type { CategoryView } from "@/lib/api-content.ts";
import { archivePath, articlePath, getMessages, homePath } from "@/lib/content.ts";
import styles from "./home-page.module.css";

function dateLabel(value: string, locale: Locale) {
  return new Date(value).toLocaleDateString(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "UTC",
  }).replaceAll("/", ".");
}

function Header({ locale }: { locale: Locale }) {
  const copy = getMessages(locale);
  const english = locale === "en";
  return (
    <>
      <a className={styles.rail} href={homePath(locale)} aria-label="Nowave home">
        <span>{english ? "NOWAVE · INDEPENDENT LITERARY JOURNAL" : "无浪潮 · 独立文学出版"}</span>
      </a>
      <header className={styles.header}>
        <Link className={styles.wordmarkSmall} href={homePath(locale)} aria-label="无浪潮 No Wave">
          <span>无浪潮</span><i>No Wave</i>
        </Link>
        <nav className={styles.nav} aria-label={copy.primaryNavigation}>
          <Link href={homePath(locale)}>{english ? "Selected" : "精选"}</Link>
          <Link href={archivePath(locale)}>{english ? "Works" : "作品"}</Link>
          <Link href={english ? "/en/categories" : "/categories"}>{english ? "Topics" : "主题"}</Link>
          <span className={styles.navDivider} aria-hidden="true" />
          <Link href={homePath("zh-CN")} lang="zh-CN" aria-current={!english ? "page" : undefined}>简</Link>
          <span className={styles.slash}>/</span>
          <Link href={homePath("en")} lang="en" aria-current={english ? "page" : undefined}>EN</Link>
          <Link className={styles.searchLink} href={archivePath(locale)} aria-label={english ? "Search works" : "搜索作品"}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.5" /><path d="m16 16 4.2 4.2" /></svg>
          </Link>
        </nav>
      </header>
    </>
  );
}

function Artwork({ variant = 0 }: { variant?: number }) {
  return (
    <div className={`${styles.artwork} ${styles[`artwork${variant % 3}`]}`} aria-hidden="true">
      <span className={styles.artSun} />
      <span className={styles.artLine} />
      <span className={styles.artBlock} />
      <span className={styles.artCaption}>NO. {String(variant + 1).padStart(2, "0")} / NOWAVE</span>
    </div>
  );
}

function ArticleMeta({ article, locale }: { article: ArticleView; locale: Locale }) {
  const copy = getMessages(locale);
  return (
    <div className={styles.meta}>
      <span>{copy.workTypeLabels[article.workType] ?? copy.blog}</span>
      <span aria-hidden="true">·</span>
      <time dateTime={article.publishedAt}>{dateLabel(article.publishedAt, locale)}</time>
    </div>
  );
}

export function LiteraryHomePage({
  locale,
  articles,
  categories,
}: {
  locale: Locale;
  articles: ArticleView[];
  categories: CategoryView[];
}) {
  const english = locale === "en";
  const copy = getMessages(locale);
  const featured = articles.slice(0, 3);
  const latest = (articles.length > 1 ? articles.slice(1, 6) : articles.slice(0, 5));
  const subtitle = english
    ? "Independent publishing for writing worth reading slowly."
    : "为值得认真阅读的作品，留出位置。";
  return (
    <main className={styles.site} lang={locale}>
      <Header locale={locale} />
      <section className={styles.hero} aria-labelledby="home-heading">
        <Artwork variant={0} />
        <div className={styles.heroTopline}>
          <span>{english ? "INDEPENDENT LITERARY PUBLISHING" : "独立文学出版 · 阅读 · 交流"}</span>
          <span>VOL. 01 / 2026</span>
        </div>
        <div className={styles.heroCopy}>
          <p className={styles.heroChinese}>无浪潮</p>
          <h1 id="home-heading" className={styles.heroEnglish}><span>No</span> <i>Wave</i></h1>
          <p className={styles.heroSubtitle}>{subtitle}</p>
        </div>
        {featured[0] ? (
          <Link className={styles.heroFeature} href={articlePath(featured[0].slug, locale)}>
            <span className={styles.heroFeatureNumber}>01</span>
            <span>{featured[0].title}</span>
            <span aria-hidden="true">↗</span>
          </Link>
        ) : null}
        <div className={styles.heroFoot}>
          <span>{english ? "LITERATURE / CULTURE / CRITICISM" : "小说 / 诗歌 / 散文 / 文学批评"}</span>
          <span>{english ? "SCROLL TO DISCOVER ↓" : "向下阅读 ↓"}</span>
        </div>
      </section>

      <section className={styles.selected} aria-labelledby="selected-heading">
        <div className={styles.sectionHeading}>
          <h2 id="selected-heading"><span>{english ? "精选" : "精选"}</span> <i>Selected</i></h2>
          <span className={styles.sectionCount}>01 — {String(Math.max(featured.length, 1)).padStart(2, "0")}</span>
        </div>
        {featured.length ? (
          <>
            <p className={styles.featuredHint}>{english ? "A SELECTION OF WORKS · SCROLL HORIZONTALLY" : "本期选读 · 横向浏览作品"} <span aria-hidden="true">↔</span></p>
            <div className={styles.featuredGrid} aria-label={english ? "Selected works" : "精选作品"}>
              {featured.map((article, index) => (
                <Link className={`${styles.featureCard} ${styles[`featureCard${index + 1}`]}`} href={articlePath(article.slug, locale)} key={article.slug}>
                  <Artwork variant={index + 1} />
                  <span className={styles.featureCaption}>
                    <span className={styles.featureKicker}>{String(index + 1).padStart(2, "0")} · {copy.workTypeLabels[article.workType] ?? copy.blog}</span>
                    <strong>{article.title}</strong>
                    {article.description ? <span className={styles.featureDescription}>{article.description}</span> : null}
                    <ArticleMeta article={article} locale={locale} />
                  </span>
                </Link>
              ))}
            </div>
          </>
        ) : (
          <p className={styles.emptyState}>{copy.emptyResults}</p>
        )}
      </section>

      <div className={styles.marquee} aria-hidden="true">
        <span><i>No Wave</i> / 无浪潮 / 档案 / <i>No Wave</i> / 无浪潮 / 档案 / <i>No Wave</i> / 无浪潮 /</span>
      </div>

      <section className={styles.latest} aria-labelledby="latest-heading">
        <div className={styles.latestArtwork}><Artwork variant={2} /><span>{english ? "READ WITH ATTENTION" : "认真阅读，慢慢抵达。"}</span></div>
        <div className={styles.latestContent}>
          <div className={styles.sectionHeading}>
            <h2 id="latest-heading"><span>{english ? "最新发表" : "最近发表"}</span> <i>Latest</i></h2>
            <span className={styles.sectionCount}>{String(latest.length).padStart(2, "0")} {english ? "WORKS" : "篇作品"}</span>
          </div>
          {latest.length ? latest.map((article, index) => (
            <Link className={styles.latestRow} href={articlePath(article.slug, locale)} key={article.slug}>
              <span className={styles.latestNumber}>{String(index + 1).padStart(2, "0")}</span>
              <span className={styles.latestDetails}>
                <strong>{article.title}</strong>
                <ArticleMeta article={article} locale={locale} />
              </span>
              <span className={styles.latestArrow} aria-hidden="true">↗</span>
            </Link>
          )) : <p className={styles.emptyState}>{copy.emptyResults}</p>}
          <Link className={styles.textLink} href={archivePath(locale)}>{english ? "Browse all works" : "浏览全部作品"} <span aria-hidden="true">↗</span></Link>
        </div>
      </section>

      <section className={styles.topics} aria-labelledby="topics-heading">
        <div className={styles.topicsInner}>
          <p className={styles.topicsEyebrow} id="topics-heading">{english ? "THE READING INDEX / TOPICS" : "阅读索引 / 作品分类"}</p>
          {categories.length ? (
            <div className={styles.topicList}>
              {categories.slice(0, 8).map((category, index) => (
                <Link className={styles.topicLink} href={`${english ? "/en" : ""}/categories/${encodeURIComponent(category.slug)}`} key={category.slug}>
                  <span>{category.name}</span><sup>{String(index + 1).padStart(2, "0")}</sup>
                </Link>
              ))}
            </div>
          ) : (
            <div className={styles.topicFallback}>
              <p>{english ? "Fiction, poetry, essays, criticism — each work deserves its own space." : "小说、诗歌、散文与文学批评，各有自己的节奏与位置。"}</p>
            </div>
          )}
          <Link className={styles.topicButton} href={english ? "/en/categories" : "/categories"}>{english ? "Explore all topics" : "探索全部分类"} <span aria-hidden="true">↗</span></Link>
        </div>
      </section>

      <footer className={styles.footer}>
        <div className={styles.footerWordmark} aria-hidden="true"><span>No</span> <i>Wave</i></div>
        <div className={styles.footerBar}>
          <nav aria-label={english ? "Footer navigation" : "页尾导航"}>
            <Link href={homePath(locale)}>{english ? "Home" : "首页"}</Link>
            <Link href={archivePath(locale)}>{english ? "Works" : "作品"}</Link>
            <Link href={english ? "/en/categories" : "/categories"}>{english ? "Topics" : "分类"}</Link>
          </nav>
          <span>© {new Date().getFullYear()} 无浪潮 No Wave · {english ? "EN" : "简体中文"}</span>
        </div>
      </footer>
    </main>
  );
}
