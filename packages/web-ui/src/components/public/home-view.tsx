import { Link } from "@/lib/framework/link.tsx";
import { archivePath, articlePath, getMessages, type ArticleView, type Locale } from "@/lib/content.ts";
import { dateLabel, pad } from "@/lib/format.ts";
import { heroCover, pickDefaultCover } from "@/lib/covers.ts";
import { getUi } from "@/lib/ui-copy.ts";
import { HeroCanvas } from "@/components/motion/hero-canvas.tsx";
import { HeroGrain } from "@/components/motion/hero-grain.tsx";
import { HomeLatest, type LatestItem } from "@/components/home-latest.tsx";
import { EmptyState, SectionHeading } from "@/components/ui/parts.tsx";
import type { HomePageData } from "@/lib/public-pages.ts";

/**
 * One compact row: a running number, the title, its author, and — when the
 * shelf is ordered by saves — the count that put it there.
 *
 * The same three-column grid `HomeLatest` uses (`56px 1fr auto`), so the two
 * rows the reader scrolls past belong to the same page; the third column is
 * where the number lives, which is what makes "most saved" legible as a
 * ranking rather than another list of titles.
 */
function ShelfRow({ article, locale, index, count }: { article: ArticleView; locale: Locale; index: number; count?: string }) {
  const messages = getMessages(locale);
  return (
    <Link className="nw-row" href={articlePath(article.slug, locale)} data-reveal="row">
      <span className="nw-m nw-rn">{pad(index + 1)}</span>
      <span className="nw-rb">
        <span className="nw-t">{article.title}</span>
        <span className="nw-m">{messages.workTypeLabels[article.workType]} · {article.author.displayName} · {dateLabel(article.publishedAt, locale)}</span>
      </span>
      {count ? <span className="nw-m">{count}</span> : null}
    </Link>
  );
}

/**
 * Presentational home page.
 *
 * Synchronous and data-in/props-out, so every route that mounts it renders the
 * same tree. The client components it composes — `HeroCanvas` (WebGL),
 * `HeroGrain` (the moving film grain over the hero) and `HomeLatest`
 * (hover/focus image switch) — are framework-neutral, reaching the
 * router only through `@/lib/framework/link.tsx`; hydration is what makes them
 * interactive, and that is exactly what Phase 4 covers. The intro curtain
 * (`PageLoader`) is not here: it is mounted by the site chrome, outside the
 * ScrollSmoother content, because a fixed layer inside a transformed ancestor
 * is positioned against that ancestor rather than the viewport.
 *
 * Every derived list (the triptych, the shelf rows) is computed here from the
 * loaded articles, so the loader stays I/O only; the genre columns arrive
 * already grouped because `/categories` groups the same window the same way.
 */
export function HomePageView({ locale, featured, latest, popular, genres }: HomePageData) {
  const ui = getUi(locale);
  const messages = getMessages(locale);
  // Three shelves, three different reasons a work is on the page: an editor
  // chose it, it is new, or readers kept it. Only the first can be empty, and
  // when it is, the newest works stand in — but the page says so, because a
  // shelf that says "selected" while showing whatever is newest is a lie the
  // reader cannot detect.
  const curated = featured;
  const fallback = curated.length === 0;
  const selected = fallback ? latest.slice(0, 3) : curated.slice(0, 3);
  const selectedRest = fallback ? [] : curated.slice(3, 6);
  const latestRest = fallback ? latest.slice(3) : latest.slice(0, 6);
  const base = locale === "en" ? "/en" : "";
  const unit = ui.home.marquee;
  const latestItems: LatestItem[] = latestRest.map((article: ArticleView, index) => {
    const cover = pickDefaultCover(article.slug);
    return { href: articlePath(article.slug, locale), title: article.title, number: pad(index + 4), meta: `${messages.workTypeLabels[article.workType]} · ${article.author.displayName} · ${dateLabel(article.publishedAt, locale)}`, coverSrc: cover.src, coverWidth: cover.width, coverHeight: cover.height };
  });

  return (
    <main lang={locale} id="top" tabIndex={-1}>
      <header className="nw-hero" data-hero>
        <img className="nw-hero-bg" src={heroCover.src} alt="" width={heroCover.width} height={heroCover.height} fetchPriority="high" draggable={false} />
        <HeroCanvas src={heroCover.src} />
        <div className="nw-brand">
          {locale === "en" ? null : <p className="nw-cn nw-zh" data-intro aria-hidden="true"><i>无</i><i>浪</i><i>潮</i></p>}
          <h1 className="nw-wm" data-intro data-scatter aria-label="No Wave">
            <span className="nw-ss" aria-hidden="true"><i>N</i><i>o</i></span> <span className="nw-it" aria-hidden="true"><i>W</i><i>a</i><i>v</i><i>e</i></span>
            <span className="nw-sr">{ui.home.tagline}</span>
          </h1>
        </div>
        <HeroGrain />
      </header>

      <section className="nw-sel" id="selected" aria-label={ui.home.selected}>
        <div className="nw-container">
          <SectionHeading zh={ui.home.selected} latin={ui.home.selectedEn} locale={locale} aside={selected.length ? <span className="nw-m">{fallback ? "" : ui.home.selectedNote}</span> : undefined} />
          {fallback ? <p className="nw-m" data-featured-fallback>{ui.home.selectedFallback}</p> : null}
          {selected.length ? (
            <div className="nw-tri">
              {selected.map((article, index) => {
                const cover = pickDefaultCover(article.slug);
                return (
                  <Link key={article.slug} className={`nw-item nw-item--${index + 1}`} href={articlePath(article.slug, locale)}>
                    <div className="nw-ph" data-reveal="mask" data-parallax>
                      <img src={cover.src} alt="" width={cover.width} height={cover.height} loading={index === 0 ? "eager" : "lazy"} />
                    </div>
                    <span className="nw-cap">
                      <span className="nw-m">{pad(index + 1)} · {messages.workTypeLabels[article.workType]}</span>
                      <span className="nw-t">{article.title}</span>
                      <span className="nw-m">{article.author.displayName} · {dateLabel(article.publishedAt, locale)}</span>
                    </span>
                  </Link>
                );
              })}
            </div>
          ) : <div className="nw-mt-48"><EmptyState title={ui.home.empty} body="" /></div>}
          {/*
            Works four to six of the shelf. They are rows rather than images
            because the triptych is a stage and a stage holds three; the order
            the editor chose still runs straight through both halves.
          */}
          {selectedRest.length ? (
            <div className="nw-shelf" data-reveal="row">
              {selectedRest.map((article, index) => (
                <ShelfRow key={article.slug} article={article} locale={locale} index={index + 3} />
              ))}
            </div>
          ) : null}
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
          <HomeLatest items={latestItems} allLabel={ui.home.allWorks} allHref={archivePath(locale)} heading={<SectionHeading zh={ui.home.latest} latin={ui.home.latestEn} locale={locale} />} />
        </section>
      ) : null}

      {popular.length ? (
        <section className="nw-pop" id="popular" aria-label={ui.home.popular}>
          <div className="nw-container">
            <SectionHeading zh={ui.home.popular} latin={ui.home.popularEn} locale={locale} aside={locale === "en" ? <span className="nw-m">{ui.home.popularEn}</span> : undefined} />
            <div className="nw-shelf" data-reveal="row">
              {popular.map((article, index) => (
                <ShelfRow
                  key={article.slug}
                  article={article}
                  locale={locale}
                  index={index}
                  count={article.likeCount > 0 ? ui.home.saves(article.likeCount) : undefined}
                />
              ))}
            </div>
          </div>
        </section>
      ) : null}

      {/*
        The three genres (ADR 0054), each with its newest works. The section
        keeps the `#topics` anchor because the header's 分类 link scrolls to it
        on the home page. A genre with nothing in the window keeps its column
        and says so: three columns that become two would read as a layout bug.
      */}
      <section className="nw-top" id="topics" aria-label={ui.home.topics}>
        <div className="nw-container">
          <div className="nw-m nw-mb-40">{locale === "en" ? ui.home.topics : `${ui.home.topics} / ${ui.home.topicsEn}`}</div>
          <div className="nw-gen" data-home-genres>
            {genres.map((genre, index) => {
              const label = messages.workTypeLabels[genre.type];
              const href = `${archivePath(locale)}?type=${genre.type}`;
              return (
                <div key={genre.type} className="nw-gen-col" data-genre={genre.type}>
                  <Link className="nw-tp" href={href} data-reveal="wipe">{label}<sup>{pad(index + 1)}</sup></Link>
                  <p className="nw-m">{ui.genres.count(genre.count, genre.countIsLowerBound)}</p>
                  {genre.newest.length ? (
                    <ol className="nw-gen-list">
                      {genre.newest.map((article) => (
                        <li key={article.slug}>
                          <Link href={articlePath(article.slug, locale)}>
                            <span className="nw-t">{article.title}</span>
                            <span className="nw-m">{article.author.displayName} · {dateLabel(article.publishedAt, locale)}</span>
                          </Link>
                        </li>
                      ))}
                    </ol>
                  ) : <p className="nw-gen-empty">{ui.home.genreEmpty}</p>}
                  {genre.count ? <Link className="nw-gen-all" href={href}>{ui.genres.all(label)} <span aria-hidden="true">→</span></Link> : null}
                </div>
              );
            })}
          </div>
          <Link className="nw-go" href={base ? `${base}/categories` : "/categories"}>{ui.home.allTopics} <span aria-hidden="true">→</span></Link>
        </div>
      </section>
    </main>
  );
}
