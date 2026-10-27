import Link from "next/link";
import { archivePath } from "@/lib/content.ts";
import type { ArticleView, Locale } from "@/lib/content.ts";
import type { CategoryView } from "@/lib/api-content.ts";
import { pad } from "@/lib/format.ts";
import { getUi } from "@/lib/ui-copy.ts";
import { EmptyState, hrefWith, Pager, WorkRow } from "@/components/ui/parts.tsx";

const PAGE_SIZE = 20;

export function CategoryIndexContent({ locale, categories, query = "", page = 1, hasNextPage = false }: { locale: Locale; categories: CategoryView[]; query?: string; page?: number; hasNextPage?: boolean }) {
  const ui = getUi(locale);
  const base = locale === "en" ? "/en/categories" : "/categories";
  return (
    <main lang={locale} className="nw-w">
      <header className="nw-head">
        <div className="nw-m" style={{ marginBottom: 12 }}>{ui.categories.eyebrow}</div>
        <h1><span className="nw-zh">{ui.nav.topics}</span> <i>Topics</i></h1>
        <p className="nw-ep" style={{ marginTop: 20 }}>{ui.categories.intro}</p>
        <form className="nw-sf-form" action={base} method="get" role="search" aria-label={ui.categories.search}>
          <div className="nw-fgrow"><label className="nw-lab" htmlFor="cat-q">{ui.categories.search}</label><input id="cat-q" className="nw-fld" type="search" name="q" defaultValue={query} placeholder={ui.categories.placeholder} /></div>
          <button className="nw-btn nw-sec" type="submit">{ui.categories.button}</button>
          {query ? <Link className="nw-btn" href={base}>{ui.categories.clear}</Link> : null}
        </form>
      </header>
      <div className="nw-bodygrid" style={{ marginTop: 48 }}>
        {categories.length ? (
          <>
            {categories.map((category, index) => (
              <Link key={category.slug} className="nw-catrow" href={`${base}/${category.slug}`} data-reveal="row">
                <span className="nw-m">{pad(index + 1 + (page - 1) * PAGE_SIZE)}</span>
                <span><h2>{category.name}</h2>{category.description ? <p>{category.description}</p> : null}</span>
                <span className="nw-m">{ui.categories.works(category.articleCount)}</span>
              </Link>
            ))}
            <Pager locale={locale} page={page} hasNextPage={hasNextPage} hrefFor={(next) => hrefWith(base, { q: query, page: next })} />
          </>
        ) : <EmptyState title={page > 1 ? ui.categories.noMore : query ? ui.categories.noMatch : ui.categories.none} body="" href={query || page > 1 ? base : archivePath(locale)} action={query || page > 1 ? ui.categories.all : ui.nav.works} />}
      </div>
      <div style={{ height: 140 }} />
    </main>
  );
}

export function CategoryDetailContent({ locale, category, articles, page = 1, hasNextPage = false }: { locale: Locale; category: CategoryView; articles: ArticleView[]; page?: number; hasNextPage?: boolean }) {
  const ui = getUi(locale);
  const base = `${locale === "en" ? "/en/categories" : "/categories"}/${category.slug}`;
  return (
    <main lang={locale} className="nw-w">
      <header className="nw-head">
        <Link className="nw-ss" href={locale === "en" ? "/en/categories" : "/categories"} style={{ display: "inline-flex", alignItems: "center", minHeight: 44, fontWeight: 700, fontSize: 15 }}>← {ui.categories.all}</Link>
        <div className="nw-m" style={{ marginTop: 8 }}>{ui.categories.published(category.articleCount)}</div>
        <h1 className="nw-zh" style={{ fontSize: "clamp(56px, 9vw, 128px)", lineHeight: 1.1 }}>{category.name}</h1>
        {category.description ? <p className="nw-ep">{category.description}</p> : null}
      </header>
      <div className="nw-bodygrid" style={{ marginTop: 48 }}>
        {articles.length ? (
          <>
            {articles.map((article, index) => <WorkRow key={article.slug} article={article} locale={locale} index={index + 1 + (page - 1) * PAGE_SIZE} withCover />)}
            <Pager locale={locale} page={page} hasNextPage={hasNextPage} hrefFor={(next) => hrefWith(base, { page: next })} />
          </>
        ) : <EmptyState title={page > 1 ? ui.categories.noMoreWorks : ui.categories.emptyCategory} body="" href={archivePath(locale)} action={ui.nav.works} />}
      </div>
      <div style={{ height: 140 }} />
    </main>
  );
}
