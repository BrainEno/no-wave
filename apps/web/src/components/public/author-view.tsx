import Link from "next/link";
import { archivePath, articlePath, authorPath, getMessages, type AuthorView, type Locale, type WorkType } from "@/lib/content.ts";
import { dateLabel, pad } from "@/lib/format.ts";
import { pickDefaultCover } from "@/lib/covers.ts";
import { lengthLabel, textLength } from "@/lib/reading.ts";
import { paginate } from "@/lib/work-types.ts";
import { getUi } from "@/lib/ui-copy.ts";
import { EmptyState, hrefWith, Pager, SectionHeading, TypeChip, TypeTabs } from "@/components/ui/parts.tsx";
import type { AuthorPageData } from "@/lib/public-pages.ts";

/**
 * Presentational author profile (作者主页).
 *
 * Type filtering and pagination are pure derivations of the loaded `works`, so
 * they live here rather than in the loader: the loader bounds the API cost, the
 * view decides what a visitor sees on a given page.
 */
export function AuthorPageView({ locale, author, type, page, works }: AuthorPageData) {
  const ui = getUi(locale);
  const messages = getMessages(locale);
  const base = authorPath(author.username, locale);
  const filtered = type ? works.filter((article) => article.workType === type) : works;
  const { visible, hasNextPage } = paginate(filtered, page);
  const recent = !type && page === 1 ? works.slice(0, 3) : [];
  const portrait = pickDefaultCover(author.username);

  return (
    <main lang={locale} className="nw-w">
      <div className="nw-ah">
        <aside className="nw-ai">
          <img className="nw-pt" src={portrait.src} alt="" width={portrait.width} height={portrait.height} />
          <div className="nw-m">{ui.author.profile} · {ui.author.count(works.length)}</div>
          <h1 data-reveal>{author.displayName}</h1>
          {author.bio ? <p className="nw-bio">{author.bio}</p> : null}
        </aside>
        <div>
          {recent.length ? (
            <section>
              <SectionHeading zh={ui.author.recent} latin="Recent" />
              <div style={{ marginTop: 32 }}>
                {recent.map((article, index) => (
                  <Link key={article.slug} className="nw-rp3" href={articlePath(article.slug, locale)} data-reveal="row">
                    <span className="nw-m" style={{ paddingTop: 12 }}>{pad(index + 1)}</span>
                    <span><span className="nw-m"><TypeChip type={article.workType} locale={locale} /> · {dateLabel(article.publishedAt, locale)}</span><span className="nw-t">{article.title}</span><span className="nw-x">{article.description}</span></span>
                  </Link>
                ))}
              </div>
            </section>
          ) : null}
          <section className={recent.length ? "nw-sec2" : undefined} id="catalogue">
            <SectionHeading zh={ui.author.works} latin={ui.author.worksEn} aside={<span className="nw-m">{ui.author.count(filtered.length)}</span>} />
            <div style={{ margin: "24px 0 8px" }}><TypeTabs locale={locale} base={base} current={type} /></div>
            {visible.length ? (
              <>
                {visible.map((article) => (
                  <Link key={article.slug} className="nw-cr" href={articlePath(article.slug, locale)}>
                    <span className="nw-m">{dateLabel(article.publishedAt, locale)}</span>
                    <span className="nw-zh">{article.title}</span>
                    <span className="nw-m"><TypeChip type={article.workType} locale={locale} /> {lengthLabel(textLength(article.contentBlocks, locale), locale)}</span>
                  </Link>
                ))}
                <Pager locale={locale} page={page} hasNextPage={hasNextPage} hrefFor={(next) => hrefWith(base, { type, page: next })} />
                <p className="nw-m" style={{ marginTop: 16 }}>{ui.author.limitNote}</p>
              </>
            ) : <EmptyState title={messages.noAuthorArticles} body={ui.author.none} href={archivePath(locale)} action={ui.archive.title} />}
          </section>
        </div>
      </div>
      <div style={{ height: 140 }} />
    </main>
  );
}
