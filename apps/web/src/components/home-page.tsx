import Link from "next/link";
import { archivePath, articlePath, getMessages, type ArticleView, type Locale } from "@/lib/content.ts";
import { listPublicArticles, listPublicCategories, type CategoryView } from "@/lib/api-content.ts";
import { dateLabel, pad } from "@/lib/format.ts";
import { heroCover, pickDefaultCover } from "@/lib/covers.ts";
import { getUi } from "@/lib/ui-copy.ts";
import { HeroCanvas } from "@/components/motion/hero-canvas.tsx";
import { PageLoader } from "@/components/motion/page-loader.tsx";
import { HomeLatest, type LatestItem } from "@/components/home-latest.tsx";
import { EmptyState, SectionHeading } from "@/components/ui/parts.tsx";

const triptych = [
  { width: "min(500px, 100%)", ratio: "4 / 5", marginTop: 0, size: 28 },
  { width: "min(360px, 100%)", ratio: "1 / 1", marginTop: 160, size: 22 },
  { width: "min(240px, 100%)", ratio: "3 / 4", marginTop: 60, size: 20 },
] as const;

export async function HomeContent({ locale }: { locale: Locale }) {
  const ui = getUi(locale);
  const messages = getMessages(locale);
  const [articles, categories] = await Promise.all([
    listPublicArticles({ locale }),
    listPublicCategories({ locale, limit: 8 }).catch((): CategoryView[] => []),
  ]);
  const sorted = [...articles].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  const selected = sorted.slice(0, 3);
  const latest = sorted.slice(3, 9);
  const lead = sorted[0];
  const base = locale === "en" ? "/en" : "";
  const topics: { key: string; label: string; href: string }[] = categories.length
    ? categories.map((category) => ({ key: category.slug, label: category.name, href: `${base}/categories/${category.slug}` }))
    : (["novel", "short_story", "poetry", "essay", "criticism", "nonfiction"] as const).map((type) => ({ key: type, label: messages.workTypeLabels[type], href: `${archivePath(locale)}?type=${type}` }));
  const unit = ui.home.marquee;
  const latestItems: LatestItem[] = latest.map((article: ArticleView, index) => {
    const cover = pickDefaultCover(article.slug);
    return { href: articlePath(article.slug, locale), title: article.title, number: pad(index + 4), meta: `${messages.workTypeLabels[article.workType]} · ${article.author.displayName} · ${dateLabel(article.publishedAt, locale)}`, coverSrc: cover.src, coverWidth: cover.width, coverHeight: cover.height };
  });

  return (
    <main lang={locale} id="top">
      <PageLoader label="载入中 · LOADING" />
      <header className="nw-hero" data-hero>
        <img className="nw-hero-bg" src={heroCover.src} alt="" width={heroCover.width} height={heroCover.height} fetchPriority="high" />
        <HeroCanvas src={heroCover.src} />
        {lead ? (
          <Link className="nw-feature" href={articlePath(lead.slug, locale)}>
            <span className="nw-m">01</span><span className="nw-zh">{lead.title}</span><span aria-hidden="true">→</span>
          </Link>
        ) : null}
        <div className="nw-brand">
          {locale === "en" ? null : <p className="nw-cn nw-zh" data-intro aria-hidden="true"><i>无</i><i>浪</i><i>潮</i></p>}
          <h1 className="nw-wm" data-intro data-scatter aria-label="No Wave">
            <span className="nw-ss" aria-hidden="true"><i>N</i><i>o</i></span> <span className="nw-it" aria-hidden="true"><i>W</i><i>a</i><i>v</i><i>e</i></span>
            <span className="nw-sr">{ui.home.tagline}</span>
          </h1>
        </div>
      </header>

      <section className="nw-sel" id="selected" aria-label={ui.home.selected}>
        <div className="nw-wrap" style={{ maxWidth: 1280, margin: "0 auto" }}>
          <SectionHeading zh={ui.home.selected} latin={ui.home.selectedEn} aside={selected.length ? <span className="nw-m">01 — {pad(selected.length)}</span> : undefined} />
          {selected.length ? (
            <div className="nw-tri">
              {selected.map((article, index) => {
                const layout = triptych[index] ?? triptych[2];
                const cover = pickDefaultCover(article.slug);
                return (
                  <Link key={article.slug} className="nw-item" href={articlePath(article.slug, locale)} style={{ width: layout.width, marginTop: layout.marginTop }}>
                    <div className="nw-ph" style={{ aspectRatio: layout.ratio }} data-reveal="mask" data-parallax>
                      <img src={cover.src} alt="" width={cover.width} height={cover.height} loading={index === 0 ? "eager" : "lazy"} />
                    </div>
                    <span className="nw-cap">
                      <span className="nw-m">{pad(index + 1)} · {messages.workTypeLabels[article.workType]}</span>
                      <span className="nw-t" style={{ fontSize: layout.size }}>{article.title}</span>
                      <span className="nw-m">{article.author.displayName} · {dateLabel(article.publishedAt, locale)}</span>
                    </span>
                  </Link>
                );
              })}
            </div>
          ) : <div style={{ marginTop: 48 }}><EmptyState title={ui.home.empty} body="" /></div>}
        </div>
      </section>

      <div className="nw-band" aria-hidden="true">
        <div className="nw-tk" data-marquee="-1" data-copies="6">
          {Array.from({ length: 6 }, (_, copy) => (
            <span className="nw-u" key={copy}><b>{unit[0]}</b><i>/ {unit[1]} /</i><b>{unit[2]}</b><i>/ {unit[3]} /</i></span>
          ))}
        </div>
      </div>

      {latestItems.length ? (
        <section className="nw-lat" id="latest" aria-label={ui.home.latest}>
          <HomeLatest items={latestItems} allLabel={ui.home.allWorks} allHref={archivePath(locale)} heading={<SectionHeading zh={ui.home.latest} latin={ui.home.latestEn} />} />
        </section>
      ) : null}

      <section className="nw-top" id="topics" aria-label={ui.home.topics}>
        <div style={{ maxWidth: 1280, margin: "0 auto" }}>
          <div className="nw-m" style={{ marginBottom: 40 }}>{ui.home.topics} / {ui.home.topicsEn}</div>
          <div>
            {topics.map((topic, index) => (
              <Link key={topic.key} className="nw-tp" href={topic.href} data-reveal="wipe">{topic.label}<sup>{pad(index + 1)}</sup></Link>
            ))}
          </div>
          <Link className="nw-go" href={base ? `${base}/categories` : "/categories"}>{ui.home.allTopics} <span aria-hidden="true">→</span></Link>
        </div>
      </section>
    </main>
  );
}
