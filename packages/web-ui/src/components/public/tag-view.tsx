import { Link } from "@/lib/framework/link.tsx";
import { archivePath, type ArticleView, type Locale } from "@/lib/content.ts";
import { articleTagItems, tagDetailHref, tagIndexHref, tagIndexPath, tagPath, TAG_PAGE_SIZE } from "@/lib/tag-discovery.ts";
import { getTagCopy } from "@/lib/tag-copy.ts";
import { tagFeedLinks } from "@/lib/tag-feed.ts";
import type { TagDetailData, TagIndexData } from "@/lib/tag-pages.ts";
import { pad } from "@/lib/format.ts";
import { EmptyState, Highlight, Pager, WorkRow } from "@/components/ui/parts.tsx";

/** No client-side catalogue filter: the URL and the bounded API page own the results. */
export function TagIndexView({ locale, tags, query, page, hasNextPage }: TagIndexData) {
  const copy = getTagCopy(locale);
  const base = tagIndexPath(locale);
  return (
    <main id="top" tabIndex={-1} lang={locale} className="nw-w">
      <header className="nw-head">
        <div className="nw-m" style={{ marginBottom: 12 }}>{copy.eyebrow}</div>
        <h1><span className="nw-zh">{copy.title}</span>{locale !== "en" ? <> <i>Tags</i></> : null}</h1>
        <p className="nw-ep" style={{ marginTop: 20 }}>{copy.intro}</p>
        <form className="nw-sf-form" action={base} method="get" role="search" aria-label={copy.search}>
          <div className="nw-fgrow">
            <label className="nw-lab" htmlFor="tag-q">{copy.search}</label>
            <input key={query} id="tag-q" className="nw-fld" type="search" name="q" maxLength={200} defaultValue={query} placeholder={copy.placeholder} />
          </div>
          <button className="nw-btn nw-sec" type="submit">{copy.submit}</button>
          {query ? <Link className="nw-btn" href={base}>{copy.clear}</Link> : null}
        </form>
      </header>
      <section className="nw-bodygrid" style={{ marginTop: 48 }} aria-label={copy.results}>
        {tags.length ? (
          <ul className="nw-tag-list">
            {tags.map((tag, index) => (
              <li key={tag.slug}>
                <Link className="nw-catrow nw-tag-row" href={tagPath(tag.slug, locale)} data-tag-slug={tag.slug} data-reveal="row">
                  <span className="nw-m" aria-hidden="true">{pad(index + 1 + (page - 1) * TAG_PAGE_SIZE)}</span>
                  <span><h2>#<Highlight text={tag.name} query={query} /></h2>{tag.description ? <p>{tag.description}</p> : null}</span>
                  <span className="nw-m">{copy.works(tag.articleCount)}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title={page > 1 ? copy.noMore : query ? copy.noMatch : copy.none} body={query ? copy.queryHint : ""}
            href={query || page > 1 ? base : archivePath(locale)} action={query || page > 1 ? copy.all : copy.browseWorks} />
        )}
        <Pager locale={locale} page={page} hasNextPage={hasNextPage} hrefFor={(next) => tagIndexHref(locale, query, next)} />
      </section>
      <div style={{ height: 140 }} />
    </main>
  );
}

export function TagDetailView({ locale, tag, articles, page, hasNextPage }: TagDetailData & { tag: NonNullable<TagDetailData["tag"]> }) {
  const copy = getTagCopy(locale);
  return (
    <main id="top" tabIndex={-1} lang={locale} className="nw-w">
      <header className="nw-head">
        <Link className="nw-ss nw-tag-back" href={tagIndexPath(locale)}>← {copy.all}</Link>
        <div className="nw-m" style={{ marginTop: 8 }}>{copy.works(tag.articleCount)}</div>
        <h1 className="nw-zh nw-tag-heading">#{tag.name}</h1>
        {tag.description ? <p className="nw-ep">{tag.description}</p> : null}
        <nav aria-label={copy.subscribe} style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 20 }}>
          {tagFeedLinks(tag.slug, locale).map((link) => (
            <a key={link.type} className="nw-btn nw-sec" href={link.href} type={link.type}>{link.title}</a>
          ))}
        </nav>
      </header>
      <section className="nw-bodygrid" style={{ marginTop: 48 }} aria-label={copy.works(tag.articleCount)}>
        {articles.length ? articles.map((article, index) => (
          <WorkRow key={article.slug} article={article} locale={locale} index={index + 1 + (page - 1) * TAG_PAGE_SIZE} withCover />
        )) : (
          <EmptyState title={page > 1 ? copy.noMoreWorks : copy.emptyTag} body=""
            href={page > 1 ? tagPath(tag.slug, locale) : archivePath(locale)} action={page > 1 ? copy.firstPage : copy.browseWorks} />
        )}
        <Pager locale={locale} page={page} hasNextPage={hasNextPage} hrefFor={(next) => tagDetailHref(tag.slug, locale, next)} />
      </section>
      <div style={{ height: 140 }} />
    </main>
  );
}

/** Optional references add navigation without deleting old name-only metadata. */
export function ArticleTagLinks({ article, locale }: { article: Pick<ArticleView, "tags" | "tagReferences">; locale: Locale }) {
  const items = articleTagItems(article.tags, article.tagReferences);
  if (!items.length) return null;
  return (
    <nav className="nw-article-tags nw-m" aria-label={getTagCopy(locale).articleTags}>
      {items.map((item) => item.slug
        ? <Link key={item.name} href={tagPath(item.slug, locale)} rel="tag">#{item.name}</Link>
        : <span key={item.name}>#{item.name}</span>)}
    </nav>
  );
}
