import { Link } from "@/lib/framework/link.tsx";
import { archivePath, authorPath, getMessages, type Locale, type WorkType } from "@/lib/content.ts";
import type { CategoryView } from "@/lib/api-content.ts";
import { initial } from "@/lib/format.ts";
import { getUi } from "@/lib/ui-copy.ts";
import { EmptyState, Highlight, hrefWith, tabTypes, WorkRow } from "@/components/ui/parts.tsx";
import type { SearchPageData, SearchTab } from "@/lib/public-pages.ts";

/**
 * Presentational search results.
 *
 * Every tab is fed by the endpoint that owns it: works by the article list,
 * authors by the author directory (ADR 0024), categories by the taxonomy list.
 * Authors used to be aggregated here from the matching works, which meant a
 * writer could only be found through one of their titles — the tab that promises
 * to find writers could not find a writer by name.
 */
export function SearchPageView({ locale, query, tab, type, works, authors, categories }: SearchPageData) {
  const ui = getUi(locale);
  const messages = getMessages(locale);
  const base = locale === "en" ? "/en/search" : "/search";
  const q = query.trim();
  const shown = type ? works.filter((work) => work.workType === type) : works;
  const presentTypes = tabTypes.filter((candidate) => works.some((work) => work.workType === candidate));
  const total = works.length + authors.length + categories.length;
  const tabs: { key: SearchTab; label: string; count: number }[] = [
    { key: "works", label: ui.search.works, count: works.length },
    { key: "authors", label: ui.search.authors, count: authors.length },
    { key: "categories", label: ui.search.categories, count: categories.length },
  ];

  return (
    <main id="top" tabIndex={-1} lang={locale} className="nw-w">
      <header className="nw-head">
        <div className="nw-search-head">
          <h1 className="nw-kicker">{ui.search.title}</h1>
          <p className="nw-m">{q ? ui.search.total(total) : ui.search.intro}</p>
        </div>
        <form className="nw-sb" action={base} method="get" role="search" aria-label={ui.search.label}>
          <label className="nw-lab" htmlFor="site-q">{ui.search.label}</label>
          <input id="site-q" type="search" name="q" defaultValue={query} placeholder={ui.search.placeholder} autoComplete="off" />
          <button className="nw-btn nw-pri" type="submit">{ui.search.button}</button>
        </form>
      </header>

      {!q ? (
        <section className="nw-mt-56">
          <p className="nw-kicker">{ui.search.browse}</p>
          <div className="nw-chips">{tabTypes.map((candidate) => <Link key={candidate} href={`${archivePath(locale)}?type=${candidate}`}>{messages.workTypeLabels[candidate]}</Link>)}</div>
        </section>
      ) : total === 0 ? (
        <div className="nw-mt-56">
          <EmptyState title={ui.search.none(q)} body={ui.search.hint} href={archivePath(locale)} action={ui.nav.works} />
          <div className="nw-chips nw-chips--flush">{tabTypes.slice(0, 4).map((candidate) => <Link key={candidate} href={`${archivePath(locale)}?type=${candidate}`}>{messages.workTypeLabels[candidate]}</Link>)}</div>
        </div>
      ) : (
        <>
          <nav className="nw-tabs nw-mt-40" aria-label={ui.search.title}>
            {tabs.map((item) => <Link key={item.key} href={hrefWith(base, { q, tab: item.key === "works" ? null : item.key })} aria-current={tab === item.key ? "true" : undefined}>{item.label} <span className="nw-m">{item.count}</span></Link>)}
          </nav>
          {tab === "works" ? (
            <section className="nw-mt-24">
              {presentTypes.length > 1 ? (
                <div className="nw-chips nw-mb-16" role="group" aria-label={ui.archive.typeLabel}>
                  <Link href={hrefWith(base, { q })} aria-current={type === null ? "true" : undefined}>{ui.archive.all}</Link>
                  {presentTypes.map((candidate) => <Link key={candidate} href={hrefWith(base, { q, type: candidate })} aria-current={type === candidate ? "true" : undefined}>{messages.workTypeLabels[candidate]}</Link>)}
                </div>
              ) : null}
              {shown.length ? shown.map((work, index) => <WorkRow key={work.slug} article={work} locale={locale} index={index + 1} query={q} />) : <EmptyState title={ui.archive.noResults} body={ui.archive.noResultsHint} href={hrefWith(base, { q })} action={ui.archive.clear} />}
            </section>
          ) : null}
          {tab === "authors" ? (
            <section className="nw-mt-24">
              {authors.length ? authors.map((author) => (
                <Link key={author.username} className="nw-ar" href={authorPath(author.username, locale)}>
                  <span className="nw-avatar" aria-hidden="true">{initial(author.displayName)}</span>
                  <span><span className="nw-zh"><Highlight text={author.displayName} query={q} /></span><span className="nw-m nw-block">{ui.authors.works(author.workCount)}</span></span>
                  <span className="nw-m" aria-hidden="true">→</span>
                </Link>
              )) : <EmptyState title={ui.search.none(q)} body={ui.search.hint} />}
              {/* The tab is a window onto the directory, not the whole of it. */}
              {authors.length ? (
                <p className="nw-m nw-mt-24">
                  <Link href={locale === "en" ? "/en/authors" : "/authors"}>{ui.authors.all} →</Link>
                </p>
              ) : null}
            </section>
          ) : null}
          {tab === "categories" ? (
            <section className="nw-mt-24">
              {categories.length ? categories.map((category) => (
                <Link key={category.slug} className="nw-gr" href={`${locale === "en" ? "/en/categories" : "/categories"}/${category.slug}`}>
                  <span className="nw-zh"><Highlight text={category.name} query={q} /></span>
                  <span className="nw-m">{ui.categories.works(category.articleCount)} →</span>
                </Link>
              )) : <EmptyState title={ui.search.none(q)} body={ui.search.hint} />}
            </section>
          ) : null}
        </>
      )}
      <div className="nw-spacer" />
    </main>
  );
}
