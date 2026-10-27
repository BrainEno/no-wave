import Link from "next/link";
import type { ReactNode } from "react";
import { articlePath, getMessages, type ArticleView, type Locale, type WorkType } from "@/lib/content.ts";
import { dateLabel, pad } from "@/lib/format.ts";
import { pickDefaultCover } from "@/lib/covers.ts";
import { lengthLabel, textLength } from "@/lib/reading.ts";
import { firstLines, splitHighlight } from "@/lib/work-types.ts";
import { getUi } from "@/lib/ui-copy.ts";

export const tabTypes: readonly WorkType[] = ["novel", "short_story", "poetry", "essay", "criticism", "literary_criticism", "nonfiction", "serial"];

export function Highlight({ text, query }: { text: string; query?: string }) {
  if (!query?.trim()) return <>{text}</>;
  return <>{splitHighlight(text, query).map((part, index) => part.hit ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>)}</>;
}

export function TypeChip({ type, locale }: { type: WorkType; locale: Locale }) {
  return <span className="nw-gc">{getMessages(locale).workTypeLabels[type]}</span>;
}

/** 作品行：编号 · 类型 · 日期 / 标题 / 作者 · 篇幅 / 摘要（可选封面）。所有字段均来自 API 或由正文派生。 */
export function WorkRow({ article, locale, index, withCover = false, withExcerpt = true, query = "" }: {
  article: ArticleView; locale: Locale; index: number; withCover?: boolean; withExcerpt?: boolean; query?: string;
}) {
  const cover = pickDefaultCover(article.slug);
  const length = lengthLabel(textLength(article.contentBlocks, locale), locale);
  const firstText = article.contentBlocks.find((block) => block.type === "paragraph");
  const excerpt = article.workType === "poetry" && firstText?.type === "paragraph" ? firstLines(firstText.text, 2).join(" / ") : article.description;
  return (
    <Link className="nw-row" href={articlePath(article.slug, locale)} data-reveal="row">
      <span className="nw-m nw-rn">{pad(index)}</span>
      <span className="nw-rb">
        <span className="nw-m"><TypeChip type={article.workType} locale={locale} /> · {dateLabel(article.publishedAt, locale)}</span>
        <span className="nw-t"><Highlight text={article.title} query={query} /></span>
        <span className="nw-m">{article.author.displayName} · {length}</span>
        {withExcerpt && excerpt ? <span className="nw-rx"><Highlight text={excerpt} query={query} /></span> : null}
      </span>
      {withCover ? <img className="nw-rp" src={cover.src} alt="" width={cover.width} height={cover.height} loading="lazy" /> : null}
    </Link>
  );
}

export function SectionHeading({ zh, latin, aside }: { zh: string; latin: string; aside?: ReactNode }) {
  return <div className="nw-h2"><h2><span className="nw-zh">{zh}</span> <i>{latin}</i></h2>{aside}</div>;
}

export function EmptyState({ title, body, href, action }: { title: string; body: string; href?: string; action?: string }) {
  return (
    <div className="nw-stb" role="status">
      <div className="nw-big" aria-hidden="true">—</div>
      <h3>{title}</h3>
      <p>{body}</p>
      {href && action ? <Link className="nw-btn nw-sec" href={href}>{action} →</Link> : null}
    </div>
  );
}

export function hrefWith(base: string, params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== null && value !== undefined && value !== "" && !(key === "page" && value === 1)) search.set(key, String(value));
  const text = search.toString();
  return text ? `${base}?${text}` : base;
}

export function TypeTabs({ locale, base, current, params = {} }: { locale: Locale; base: string; current: WorkType | null; params?: Record<string, string | null | undefined> }) {
  const ui = getUi(locale);
  const labels = getMessages(locale).workTypeLabels;
  return (
    <nav className="nw-tabs" aria-label={ui.archive.typeLabel}>
      <Link href={hrefWith(base, { ...params, type: null })} aria-current={current === null ? "true" : undefined}>{ui.archive.all}</Link>
      {tabTypes.map((type) => <Link key={type} href={hrefWith(base, { ...params, type })} aria-current={current === type ? "true" : undefined}>{labels[type]}</Link>)}
    </nav>
  );
}

export function Pager({ locale, page, hasNextPage, hrefFor }: { locale: Locale; page: number; hasNextPage: boolean; hrefFor: (page: number) => string }) {
  const ui = getUi(locale);
  if (page === 1 && !hasNextPage) return null;
  return (
    <nav className="nw-pg" aria-label={ui.pager.label}>
      {page > 1 ? <Link href={hrefFor(page - 1)} rel="prev">← {ui.pager.prev}</Link> : <span />}
      <span className="nw-m">{ui.pager.page(page)}</span>
      {hasNextPage ? <Link href={hrefFor(page + 1)} rel="next">{ui.pager.next} →</Link> : <span />}
    </nav>
  );
}
