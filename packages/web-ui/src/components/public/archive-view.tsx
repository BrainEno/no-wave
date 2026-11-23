import { Link } from "@/lib/framework/link.tsx";
import { archivePath, articlePath, getMessages, type ArticleView, type Locale, type WorkType } from "@/lib/content.ts";
import { dateLabel } from "@/lib/format.ts";
import { pickDefaultCover } from "@/lib/covers.ts";
import { lengthLabel } from "@/lib/reading.ts";
import { articlePoemLines, articleReadingLength } from "@/lib/article-preview.ts";
import { PAGE_SIZE } from "@/lib/work-types.ts";
import { getUi } from "@/lib/ui-copy.ts";
import { EmptyState, hrefWith, Pager, TypeChip, TypeTabs, WorkRow } from "@/components/ui/parts.tsx";
import type { ArchivePageData } from "@/lib/public-pages.ts";
import { siteFeedLinks } from "@/lib/site-feed.ts";

/**
 * Presentational archive (作品目录).
 *
 * The component is synchronous and takes its data as props, so it renders the
 * identical tree from the identical `ArchivePageData` wherever it is mounted.
 * It names no router: links go through `@/lib/framework/link.tsx`.
 */
export function ArchivePageView({ locale, query, page, type, articles, hasNextPage }: ArchivePageData) {
  const ui = getUi(locale);
  const messages = getMessages(locale);
  const base = archivePath(locale);
  const showLead = page === 1 && !query && !type && articles.length > 0;
  const lead = showLead ? articles[0] : undefined;
  const rows = lead ? articles.slice(1) : articles;
  const poem = rows.find((article) => article.workType === "poetry");
  const poemLines = poem ? articlePoemLines(poem) : [];
  const poemAfter = Math.min(3, rows.length - 1);

  return (
    <main id="top" tabIndex={-1} lang={locale} className="nw-w">
      <header className="nw-head">
        <p className="nw-kicker nw-head-kicker">{messages.blogDescription}</p>
        <h1><span className="nw-zh">{ui.archive.title}</span> <i>{ui.archive.titleEn}</i></h1>
        <form className="nw-sf-form" action={base} method="get" role="search" aria-label={ui.archive.search}>
          {type ? <input type="hidden" name="type" value={type} /> : null}
          <div className="nw-fgrow"><label className="nw-lab" htmlFor="works-q">{ui.archive.search}</label><input id="works-q" className="nw-fld" type="search" name="q" defaultValue={query} placeholder={ui.archive.placeholder} /></div>
          <button className="nw-btn nw-sec" type="submit">{ui.archive.button}</button>
          {query || type ? <Link className="nw-btn" href={base}>{ui.archive.clear}</Link> : null}
        </form>
        {/*
          The same subscribe buttons a tag page has. Plain anchors, not the
          router's Link: the feeds are resource routes, and a client-side
          navigation into one would have no page to render. The feed is always
          the site-wide newest works, whatever is filtered.
        */}
        <nav aria-label={ui.archive.subscribe} data-site-feed style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 20 }}>
          {siteFeedLinks(locale).map((link) => (
            <a key={link.type} className="nw-btn nw-sec" href={link.href} type={link.type}>{link.label}</a>
          ))}
        </nav>
      </header>
      <div style={{ marginTop: 40 }}><TypeTabs locale={locale} base={base} current={type} params={{ q: query }} /></div>
      {type ? <p className="nw-m" style={{ marginTop: 8 }}>{ui.archive.limitNote}</p> : null}

      <div className="nw-bodygrid">
        {lead ? <ArchiveLead article={lead} locale={locale} label={ui.archive.lead} /> : null}
        {rows.length || lead ? (
          <div>
            {rows.map((article, index) => (
              <div key={article.slug}>
                <WorkRow article={article} locale={locale} index={(lead ? 2 : 1) + index + (page - 1) * PAGE_SIZE} withCover query={query} />
                {poem && poemLines.length && index === poemAfter ? (
                  <div className="nw-pi"><div className="nw-m">{ui.archive.poemFrom} · {poem.author.displayName} · 《{poem.title}》</div><p className="nw-po">{poemLines.map((line) => <span key={line}>{line}<br /></span>)}</p></div>
                ) : null}
              </div>
            ))}
            <Pager locale={locale} page={page} hasNextPage={hasNextPage} hrefFor={(next) => hrefWith(base, { q: query, type, page: next })} />
          </div>
        ) : (
          <EmptyState title={ui.archive.noResults} body={ui.archive.noResultsHint} href={base} action={ui.archive.clear} />
        )}
      </div>
      <div style={{ height: 140 }} />
    </main>
  );
}

function ArchiveLead({ article, locale, label }: { article: ArticleView; locale: Locale; label: string }) {
  const cover = pickDefaultCover(article.slug);
  const messages = getMessages(locale);
  return (
    <Link className="nw-ft" href={articlePath(article.slug, locale)} data-reveal>
      <div className="nw-ftp"><img src={cover.src} alt="" width={cover.width} height={cover.height} /></div>
      <div>
        <div className="nw-m"><span className="nw-gc" style={{ background: "var(--ink)", color: "var(--paper)" }}>{label}</span> <TypeChip type={article.workType} locale={locale} /> · {dateLabel(article.publishedAt, locale)}</div>
        <h2>{article.title}</h2>
        <p>{article.description}</p>
        <div className="nw-m">{article.author.displayName} · {lengthLabel(articleReadingLength(article, locale), locale)}</div>
        <span className="nw-btn nw-sec" style={{ marginTop: 20 }}>{messages.readArticle} →</span>
      </div>
    </Link>
  );
}
