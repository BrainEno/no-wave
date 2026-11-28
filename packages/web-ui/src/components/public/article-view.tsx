import { repeatsArticleOpening } from "@/lib/article-standfirst.ts";
import { ArticleTagLinks } from "@/components/public/tag-view.tsx";
import { Link } from "@/lib/framework/link.tsx";
import type { ReactNode } from "react";
import { archivePath, articlePath, authorPath, getMessages, type ArticleContentBlock, type ArticleView, type Locale } from "@/lib/content.ts";
import { getUi } from "@/lib/ui-copy.ts";
import { dateLabel, initial } from "@/lib/format.ts";
import { lengthLabel, minutesLabel, readingMinutes, textLength } from "@/lib/reading.ts";
import type { ArticleDetailPageData } from "@/lib/public-pages.ts";
import { ReaderBar, ReaderToc, ReadingProgress } from "@/components/reader/reader-tools.tsx";
import { ReadAloud } from "@/components/reader/read-aloud.tsx";
import { PassageAnnotations } from "@/components/reader/passage-annotations.tsx";
import { ArticleComments } from "@/components/comments/article-comments.tsx";
import { ArticleLike } from "@/components/public/article-like.tsx";
import { ArticleViewBeacon } from "@/components/public/article-view-beacon.tsx";
import { ArticleReadingList } from "@/components/reader/article-reading-list.tsx";
import { ReaderFind } from "@/components/reader/reader-find.tsx";
import { SectionHeading, TypeChip, WorkRow } from "@/components/ui/parts.tsx";
import { InlineRuns } from "@/components/ui/inline-runs.tsx";
import { blockInlineRuns, blockItemInlines, type InlineRun } from "@/lib/content-inline.ts";

/**
 * 阅读页 — the synchronous half of the article detail page (Phase 4a).
 *
 * Until now the prototype rendered a hand-written, reduced body: no reader
 * toolbar, no table of contents, no comment section. The markup was still there
 * in the App Router's `ArticleDetailContent`, but that component is `async` (it
 * awaits the scan for previous/next and related works), so the prototype could
 * not import it and quietly shipped less page instead.
 *
 * The split is the same one the rest of the migration uses:
 * `loadArticleDetailPage()` owns the data, this component owns the rendering, and
 * both frameworks render the same tree — including the interactive parts, which
 * is the point: `ArticleComments`, `ReaderBar`, `ReaderToc` and
 * `ReadingProgress` are client components, so they hydrate here exactly as they
 * do in Next.js.
 */

function headingId(block: Extract<ArticleContentBlock, { type: "heading" }>): string {
  return block.anchor || `h-${block.id}`;
}

/**
 * Every block carries its own id into the markup.
 *
 * The reader tools need it: 朗读 highlights the paragraph it is speaking, so
 * the element and the content block have to be findable from each other. The
 * id comes from the content itself, so it is the same on the server and after
 * hydration — unlike an index, which would move if a block were inserted.
 *
 * A block that carries inline runs is drawn from those runs, not from its
 * plain-text fallback. The fallback is what the reader tools and the excerpt
 * work with; the runs are what the author wrote. A version 0 document has no
 * runs and falls back to the text it always had.
 */
function blockBody(block: { id: string; text: string }, runs: readonly InlineRun[]): ReactNode {
  if (runs.length === 0) return block.text;
  return <InlineRuns runs={runs} idPrefix={block.id} />;
}

function renderBlock(block: ArticleContentBlock): ReactNode {
  switch (block.type) {
    case "paragraph": return <p key={block.id} data-block={block.id}>{blockBody(block, blockInlineRuns(block.inlines))}</p>;
    case "heading": {
      const id = headingId(block);
      const body = blockBody(block, blockInlineRuns(block.inlines));
      return block.level === 2
        ? <h2 key={block.id} id={id} data-block={block.id}>{body}</h2>
        : block.level === 3
        ? <h3 key={block.id} id={id} data-block={block.id}>{body}</h3>
        : <h4 key={block.id} id={id} data-block={block.id}>{body}</h4>;
    }
    case "quote": return <blockquote key={block.id} data-block={block.id}><p>{blockBody(block, blockInlineRuns(block.inlines))}</p>{block.attribution ? <cite>— {block.attribution}</cite> : null}</blockquote>;
    case "list": {
      const itemRuns = blockItemInlines(block.itemInlines);
      const items = block.items.map((item, index) => (
        <li key={index}>{itemRuns[index]?.length ? <InlineRuns runs={itemRuns[index]!} idPrefix={`${block.id}-${index}`} /> : item}</li>
      ));
      return block.ordered
        ? <ol key={block.id} data-block={block.id}>{items}</ol>
        : <ul key={block.id} data-block={block.id}>{items}</ul>;
    }
    case "image": return <figure key={block.id} data-block={block.id}><img src={block.src} alt={block.alt} loading="lazy" />{block.caption ? <figcaption>{block.caption}</figcaption> : null}</figure>;
    case "code": return <pre key={block.id} data-block={block.id}><code>{block.code}</code></pre>;
  }
}

export function ArticlePageView({ article, newer, older, related }: ArticleDetailPageData) {
  const locale: Locale = article.locale;
  const ui = getUi(locale);
  const messages = getMessages(locale);
  const length = textLength(article.contentBlocks, locale);
  const toc = article.contentBlocks.flatMap((block) => block.type === "heading" && block.level === 2 ? [{ id: headingId(block), text: block.text }] : []);
  const poem = article.workType === "poetry";
  const labels = {
    smaller: ui.reader.fontSmaller, larger: ui.reader.fontLarger, theme: ui.reader.theme, dark: ui.reader.dark, light: ui.reader.light,
    copy: ui.reader.copyLink, copied: ui.reader.copied, sizeLabel: ui.reader.fontSize(0).replace("0", "{n}"),
  };
  // 朗读只用一个浏览器能力：页上已经有了作品的每一个字，说出来的是读者自己的设备。
  const aloud = { listen: ui.reader.listen, pause: ui.reader.pause, resume: ui.reader.resume, stop: ui.reader.stop,
    done: ui.reader.done, position: ui.reader.position, unavailable: ui.reader.unavailable };

  return (
    <main id="top" tabIndex={-1} lang={locale} className="nw-w nw-reader">
      <ReadingProgress label={ui.reader.progress} />
      <header className="nw-rh">
        <div className="nw-rh-top">
          <Link className="nw-back" href={archivePath(locale)}>← {ui.reader.back}</Link>
          <div className="nw-m nw-rh-meta"><TypeChip type={article.workType} locale={locale} /> · {dateLabel(article.publishedAt, locale)} · {lengthLabel(length, locale)} · {minutesLabel(readingMinutes(length, locale), locale)}</div>
        </div>
        <h1 data-reveal="mask">{article.title}</h1>
        {article.description && !repeatsArticleOpening(article.description, article.contentBlocks) ? <p className="nw-ep">{article.description}</p> : null}
        <div className="nw-by">
          <div className="nw-by-author">
            <div className="nw-avatar" aria-hidden="true">{initial(article.author.displayName)}</div>
            <div><Link className="nw-zh nw-by-name" href={authorPath(article.author.username, locale)}>{article.author.displayName}</Link><div className="nw-m">{ui.reader.by} · {messages.publishedOn} {dateLabel(article.publishedAt, locale)}</div></div>
          </div>
          <div className="nw-dock">
            <ReaderBar labels={labels} />
            <ReadAloud blocks={article.contentBlocks} locale={locale} labels={aloud} />
          </div>
        </div>
      </header>

      <div className="nw-reader-tools">
        <ArticleReadingList article={article} />
        <ReaderFind key={`${locale}:${article.slug}`} locale={locale} edition={`${locale}:${article.slug}`} />
      </div>

      <div className="nw-rg">
        {/* 书口：竖排的题名与作者，只是版面上的装饰，正文与标题已经说过一遍。 */}
        <div className="nw-spine" aria-hidden="true"><span>{article.title}</span><i>{article.author.displayName}</i></div>
        <article className="nw-rd" id="nw-article" data-form={poem ? "poem" : "prose"} aria-label={article.title}>
          {article.contentBlocks.map(renderBlock)}
          <span className="nw-end">{ui.reader.end}</span>
          {article.categories.length ? (
            <p className="nw-m nw-rd-cats">{article.categories.join(" · ")}</p>
          ) : null}
          <ArticleTagLinks article={article} locale={locale} />
        </article>
        <aside className="nw-ra" aria-label={ui.reader.toc}>{toc.length >= 2 ? <ReaderToc items={toc} title={ui.reader.toc} /> : null}</aside>
      </div>

      {/* 划线：段落靠文字与上下文定位，标注只存在读者自己的浏览器里（ADR 0021）。 */}
      <PassageAnnotations slug={article.slug} locale={locale} labels={ui.reader.passages} />

      {/* 阅读数（ADR 0035）：页面挂载后发一次信标，不渲染任何东西。 */}
      <ArticleViewBeacon slug={article.slug} locale={locale} />

      {/* 收藏紧接正文之后。资源 key 隔离页面切换时尚未返回的写入。 */}
      <ArticleLike key={`${locale}:${article.slug}`} slug={article.slug} locale={locale} />

      <ArticleComments slug={article.slug} locale={locale} />

      <section className="nw-au-wrap" aria-label={ui.reader.aboutAuthor}>
        <div className="nw-au">
          <div className="nw-avatar" aria-hidden="true">{initial(article.author.displayName)}</div>
          <div>
            <div className="nw-kicker">{ui.reader.aboutAuthor}</div>
            <div className="nw-zh nw-au-name">{article.author.displayName}</div>
            {article.author.bio ? <p className="nw-m nw-au-bio">{article.author.bio}</p> : null}
          </div>
          <Link className="nw-btn" href={authorPath(article.author.username, locale)}>{ui.reader.allWorks} →</Link>
        </div>
      </section>

      {newer || older ? (
        <section className="nw-pn-wrap">
          <nav className="nw-pn" aria-label={`${ui.reader.prev} / ${ui.reader.next}`}>
            {older ? <Link href={articlePath(older.slug, locale)}><span className="nw-m">← {ui.reader.prev}</span><span className="nw-zh">{older.title}</span></Link> : <span />}
            {newer ? <Link href={articlePath(newer.slug, locale)}><span className="nw-m">{ui.reader.next} →</span><span className="nw-zh">{newer.title}</span></Link> : <span />}
          </nav>
        </section>
      ) : null}

      {related.length ? (
        <section className="nw-related">
          <SectionHeading zh={ui.reader.related} latin={ui.reader.relatedEn} locale={locale} />
          <div className="nw-related-list">{related.map((item, index) => <WorkRow key={item.slug} article={item} locale={locale} index={index + 1} withExcerpt={false} />)}</div>
        </section>
      ) : <div className="nw-related-gap" />}
    </main>
  );
}
