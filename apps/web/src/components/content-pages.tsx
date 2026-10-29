import Link from "next/link";
import type { ReactNode } from "react";
import { archivePath, articlePath, authorPath, getMessages, type ArticleContentBlock, type ArticleView, type AuthorView, type Locale, type WorkType } from "@/lib/content.ts";
import { listPublicArticles } from "@/lib/api-content.ts";
import { dateLabel, initial } from "@/lib/format.ts";
import { lengthLabel, minutesLabel, readingMinutes, textLength } from "@/lib/reading.ts";
import { getUi } from "@/lib/ui-copy.ts";
import { loadArchivePage, loadAuthorPage } from "@/lib/public-pages.ts";
import { ArchivePageView } from "@/components/public/archive-view.tsx";
import { AuthorPageView } from "@/components/public/author-view.tsx";
import { ReaderBar, ReaderToc, ReadingProgress } from "@/components/reader/reader-tools.tsx";
import { ArticleComments } from "@/components/comments/article-comments.tsx";
import { Highlight, SectionHeading, TypeChip, WorkRow } from "@/components/ui/parts.tsx";

export { HomeContent } from "@/components/home-page.tsx";

/* ---------------------------------------------------------------- 作品目录 */

/**
 * 作品目录 — App Router entry point.
 *
 * The data is loaded by the framework-neutral `loadArchivePage` and rendered by
 * the synchronous `ArchivePageView`, which is what lets the React Router prototype
 * serve the same page from the same data without an async server component.
 */
export async function ArticleArchiveContent({ locale, query = "", page = 1, type = null }: { locale: Locale; query?: string; page?: number; type?: WorkType | null }) {
  const data = await loadArchivePage({ locale, query, page, type });
  return <ArchivePageView {...data} />;
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

      <ArticleComments slug={article.slug} locale={locale} />

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

/**
 * 作者主页 — App Router entry point (same load/render split as the archive).
 */
export async function AuthorProfileContent({ locale, author, type = null, page = 1 }: { locale: Locale; author: AuthorView; type?: WorkType | null; page?: number }) {
  const data = await loadAuthorPage({ locale, author, type, page });
  return <AuthorPageView {...data} />;
}

export { Highlight };
