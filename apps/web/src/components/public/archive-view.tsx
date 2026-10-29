import Link from "next/link";
import { archivePath, articlePath, getMessages, type ArticleView, type Locale, type WorkType } from "@/lib/content.ts";
import { dateLabel } from "@/lib/format.ts";
import { pickDefaultCover } from "@/lib/covers.ts";
import { lengthLabel, textLength } from "@/lib/reading.ts";
import { PAGE_SIZE, firstLines } from "@/lib/work-types.ts";
import { getUi } from "@/lib/ui-copy.ts";
import { EmptyState, hrefWith, Pager, TypeChip, TypeTabs, WorkRow } from "@/components/ui/parts.tsx";
import type { ArchivePageData } from "@/lib/public-pages.ts";

/**
 * Presentational archive (作品目录).
 *
 * The component is synchronous and takes its data as props, so both the App
 * Router (through the `ArticleArchiveContent` wrapper) and the React Router
 * prototype render the identical tree from the identical `ArchivePageData`.
 * Only `next/link` remains framework-specific, and it is shimmed in the
 * prototype build.
 */
export function ArchivePageView({ locale, query, page, type, articles, hasNextPage }: ArchivePageData) {
  const ui = getUi(locale);
  const messages = getMessages(locale);
  const base = archivePath(locale);
  const showLead = page === 1 && !query && !type && articles.length > 0;
  const lead = showLead ? articles[0] : undefined;
  const rows = lead ? articles.slice(1) : articles;
  const poem = rows.find((article) => article.workType === "poetry");
  const poemParagraph = poem?.contentBlocks.find((block) => block.type === "paragraph");
  const poemLines = poemParagraph?.type === "paragraph" ? firstLines(poemParagraph.text, 2) : [];
  const poemAfter = Math.min(3, rows.length - 1);

  return (
    <main lang={locale} className="nw-w">
      <header className="nw-head">
        <div className="nw-m" style={{ marginBottom: 12 }}>{messages.blogDescription}</div>
        <h1><span className="nw-zh">{ui.archive.title}</span> <i>{ui.archive.titleEn}</i></h1>
        <form className="nw-sf-form" action={base} method="get" role="search" aria-label={ui.archive.search}>
          {type ? <input type="hidden" name="type" value={type} /> : null}
          <div className="nw-fgrow"><label className="nw-lab" htmlFor="works-q">{ui.archive.search}</label><input id="works-q" className="nw-fld" type="search" name="q" defaultValue={query} placeholder={ui.archive.placeholder} /></div>
          <button className="nw-btn nw-sec" type="submit">{ui.archive.button}</button>
          {query || type ? <Link className="nw-btn" href={base}>{ui.archive.clear}</Link> : null}
        </form>
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
        <div className="nw-m">{article.author.displayName} · {lengthLabel(textLength(article.contentBlocks, locale), locale)}</div>
        <span className="nw-btn nw-sec" style={{ marginTop: 20 }}>{messages.readArticle} →</span>
      </div>
    </Link>
  );
}
