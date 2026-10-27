import Link from "next/link";
import type { ReactNode } from "react";
import { archivePath, articlePath, authorPath, getMessages, type ArticleContentBlock, type ArticleView, type AuthorView, type Locale, type WorkType } from "@/lib/content.ts";
import { listPublicArticles } from "@/lib/api-content.ts";
import { dateLabel, initial, pad } from "@/lib/format.ts";
import { pickDefaultCover } from "@/lib/covers.ts";
import { lengthLabel, minutesLabel, readingMinutes, textLength } from "@/lib/reading.ts";
import { firstLines, PAGE_SIZE, paginate } from "@/lib/work-types.ts";
import { getUi } from "@/lib/ui-copy.ts";
import { ReaderBar, ReaderToc, ReadingProgress } from "@/components/reader/reader-tools.tsx";
import { EmptyState, hrefWith, Highlight, Pager, SectionHeading, TypeChip, TypeTabs, WorkRow } from "@/components/ui/parts.tsx";

export { HomeContent } from "@/components/home-page.tsx";

/* ---------------------------------------------------------------- 作品目录 */

export async function ArticleArchiveContent({ locale, query, page = 1, type = null }: { locale: Locale; query: string; page?: number; type?: WorkType | null }) {
  const ui = getUi(locale);
  const messages = getMessages(locale);
  const base = archivePath(locale);
  let visible: ArticleView[];
  let hasNextPage: boolean;
  if (type) {
    // API 暂无作品类型参数：在最新 100 篇匹配作品中筛选并分页
    const matches = (await listPublicArticles({ locale, query, limit: 100 })).filter((article) => article.workType === type);
    ({ visible, hasNextPage } = paginate(matches, page));
  } else {
    const results = await listPublicArticles({ locale, query, limit: PAGE_SIZE + 1, offset: (page - 1) * PAGE_SIZE });
    visible = results.slice(0, PAGE_SIZE);
    hasNextPage = results.length > PAGE_SIZE;
  }
  const showLead = page === 1 && !query && !type && visible.length > 0;
  const lead = showLead ? visible[0] : undefined;
  const rows = lead ? visible.slice(1) : visible;
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

/* ---------------------------------------------------------------- 阅读页 */

function headingId(block: Extract<ArticleContentBlock, { type: "heading" }>): string {
  return block.anchor || `h-${block.id}`;
}

function renderBlock(block: ArticleContentBlock): ReactNode {
  switch (block.type) {
    case "paragraph": return <p key={block.id}>{block.text}</p>;
    case "heading": {
      const id = headingId(block);
      return block.level === 2 ? <h2 key={block.id} id={id}>{block.text}</h2> : block.level === 3 ? <h3 key={block.id} id={id}>{block.text}</h3> : <h4 key={block.id} id={id}>{block.text}</h4>;
    }
    case "quote": return <blockquote key={block.id}><p>{block.text}</p>{block.attribution ? <cite>— {block.attribution}</cite> : null}</blockquote>;
    case "list": return block.ordered
      ? <ol key={block.id}>{block.items.map((item, index) => <li key={index}>{item}</li>)}</ol>
      : <ul key={block.id}>{block.items.map((item, index) => <li key={index}>{item}</li>)}</ul>;
    case "image": return <figure key={block.id}><img src={block.src} alt={block.alt} loading="lazy" />{block.caption ? <figcaption>{block.caption}</figcaption> : null}</figure>;
    case "code": return <pre key={block.id}><code>{block.code}</code></pre>;
  }
}

export async function ArticleDetailContent({ article }: { article: ArticleView }) {
  const locale = article.locale;
  const ui = getUi(locale);
  const messages = getMessages(locale);
  const length = textLength(article.contentBlocks, locale);
  const everything = (await listPublicArticles({ locale, limit: 100 }).catch((): ArticleView[] => [])).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  const position = everything.findIndex((candidate) => candidate.slug === article.slug);
  const newer = position > 0 ? everything[position - 1] : undefined;
  const older = position >= 0 ? everything[position + 1] : undefined;
  const others = everything.filter((candidate) => candidate.slug !== article.slug);
  const sameAuthor = others.filter((candidate) => candidate.author.username === article.author.username);
  const related = [...sameAuthor, ...others.filter((candidate) => candidate.author.username !== article.author.username)].slice(0, 3);
  const toc = article.contentBlocks.flatMap((block) => block.type === "heading" && block.level === 2 ? [{ id: headingId(block), text: block.text }] : []);
  const poem = article.workType === "poetry";
  const labels = {
    smaller: ui.reader.fontSmaller, larger: ui.reader.fontLarger, theme: ui.reader.theme, dark: ui.reader.dark, light: ui.reader.light,
    copy: ui.reader.copyLink, copied: ui.reader.copied, sizeLabel: ui.reader.fontSize(0).replace("0", "{n}"),
  };

  return (
    <main lang={locale} className="nw-w">
      <ReadingProgress label={ui.reader.progress} />
      <header className="nw-rh">
        <Link className="nw-ss" href={archivePath(locale)} style={{ display: "inline-flex", alignItems: "center", minHeight: 44, fontWeight: 700, fontSize: 15 }}>← {ui.reader.back}</Link>
        <div className="nw-m" style={{ marginTop: 8 }}><TypeChip type={article.workType} locale={locale} /> · {dateLabel(article.publishedAt, locale)} · {lengthLabel(length, locale)} · {minutesLabel(readingMinutes(length, locale), locale)}</div>
        <h1 data-reveal>{article.title}</h1>
        {article.description ? <p className="nw-ep">{article.description}</p> : null}
        <div className="nw-by">
          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
            <div className="nw-avatar" aria-hidden="true">{initial(article.author.displayName)}</div>
            <div><Link className="nw-zh" href={authorPath(article.author.username, locale)} style={{ fontSize: 20 }}>{article.author.displayName}</Link><div className="nw-m">{ui.reader.by} · {messages.publishedOn} {dateLabel(article.publishedAt, locale)}</div></div>
          </div>
          <ReaderBar labels={labels} />
        </div>
      </header>

      <div className="nw-rg">
        <div />
        <article className="nw-rd" id="nw-article" data-form={poem ? "poem" : "prose"} aria-label={article.title}>
          {article.contentBlocks.map(renderBlock)}
          <span className="nw-end">{ui.reader.end}</span>
          {article.categories.length || article.tags.length ? (
            <p className="nw-m" style={{ textAlign: "center", marginTop: 24, textIndent: 0 }}>{[...article.categories, ...article.tags.map((tag) => `#${tag}`)].join(" · ")}</p>
          ) : null}
        </article>
        <aside className="nw-ra" aria-label={ui.reader.toc}>{toc.length >= 2 ? <ReaderToc items={toc} title={ui.reader.toc} /> : null}</aside>
      </div>

      <section style={{ maxWidth: 640, margin: "96px auto 0" }} aria-label={ui.reader.aboutAuthor}>
        <div className="nw-au">
          <div className="nw-avatar" aria-hidden="true">{initial(article.author.displayName)}</div>
          <div>
            <div className="nw-m">{ui.reader.aboutAuthor}</div>
            <div className="nw-zh" style={{ fontSize: 28, lineHeight: 1.3 }}>{article.author.displayName}</div>
            {article.author.bio ? <p className="nw-m" style={{ margin: "6px 0 0", maxWidth: "34em", fontSize: 14 }}>{article.author.bio}</p> : null}
          </div>
          <Link className="nw-btn" href={authorPath(article.author.username, locale)}>{ui.reader.allWorks} →</Link>
        </div>
      </section>

      {newer || older ? (
        <section style={{ marginTop: 120 }}>
          <nav className="nw-pn" aria-label={`${ui.reader.prev} / ${ui.reader.next}`}>
            {older ? <Link href={articlePath(older.slug, locale)}><span className="nw-m">← {ui.reader.prev}</span><span className="nw-zh">{older.title}</span></Link> : <span />}
            {newer ? <Link href={articlePath(newer.slug, locale)}><span className="nw-m">{ui.reader.next} →</span><span className="nw-zh">{newer.title}</span></Link> : <span />}
          </nav>
        </section>
      ) : null}

      {related.length ? (
        <section style={{ marginTop: 120, paddingBottom: 140 }}>
          <SectionHeading zh={ui.reader.related} latin={ui.reader.relatedEn} />
          <div style={{ marginTop: 40 }}>{related.map((item, index) => <WorkRow key={item.slug} article={item} locale={locale} index={index + 1} withExcerpt={false} />)}</div>
        </section>
      ) : <div style={{ height: 140 }} />}
    </main>
  );
}

/* ---------------------------------------------------------------- 作者主页 */

export async function AuthorProfileContent({ locale, author, type = null, page = 1 }: { locale: Locale; author: AuthorView; type?: WorkType | null; page?: number }) {
  const ui = getUi(locale);
  const messages = getMessages(locale);
  const base = authorPath(author.username, locale);
  const works = (await listPublicArticles({ locale, authorUsername: author.username, limit: 100 })).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
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

export { Highlight };
