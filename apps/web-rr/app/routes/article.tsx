import { data, useLoaderData } from "react-router";
import type { HeadersFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { Link } from "react-router";
import { TypeChip } from "@/components/ui/parts.tsx";
import { articleMetadata, archivePath, getMessages } from "@/lib/content.ts";
import { getPublicArticle } from "@/lib/api-content.ts";
import { dateLabel } from "@/lib/format.ts";
import { lengthLabel, minutesLabel, readingMinutes, textLength } from "@/lib/reading.ts";
import { PUBLIC_PAGE_HEADERS } from "../lib/http-policy.ts";
import { metaDescriptors } from "../lib/meta.ts";
import { localeFor } from "../lib/locale.ts";
import { siteUrl } from "../lib/runtime.ts";

/**
 * Public article route, served for both `/articles/:slug` and `/en/articles/:slug`.
 *
 * Data is gathered in the loader so the component stays synchronous: React Router
 * has no async server components, and the shared `ArticleDetailContent` page is
 * one (it awaits `listPublicArticles` for related links). Hoisting that fetch into
 * the route loader is the Phase 3 change this prototype proves is necessary; the
 * shared leaf components (`TypeChip`, `WorkRow`, `SectionHeading`) render here
 * unchanged.
 */
export async function loader({ params, request }: LoaderFunctionArgs) {
  const locale = localeFor(request);
  const article = await getPublicArticle(params.slug ?? "", locale);
  // Throwing keeps the framework from committing a 200 shell before the status is
  // known, so an unknown article is a hard 404 rather than a soft 404 page.
  if (!article) throw data({ slug: params.slug ?? null, locale }, { status: 404 });
  return { article };
}

export const headers: HeadersFunction = () => PUBLIC_PAGE_HEADERS;

export const meta: MetaFunction<typeof loader> = ({ data: loaded }) => {
  if (!loaded) return [{ title: "页面未找到 | 无浪潮" }];
  return metaDescriptors(articleMetadata(loaded.article, siteUrl()));
};

export default function ArticleRoute() {
  const { article } = useLoaderData<typeof loader>();
  const locale = article.locale;
  const messages = getMessages(locale);
  const length = textLength(article.contentBlocks, locale);

  return (
    <main lang={locale} className="nw-w" data-route="article">
      <header className="nw-rh">
        <Link className="nw-ss" to={archivePath(locale)}>← {messages.backToArticles}</Link>
        <div className="nw-m" style={{ marginTop: 8 }}>
          <TypeChip type={article.workType} locale={locale} /> · {dateLabel(article.publishedAt, locale)} ·{" "}
          {lengthLabel(length, locale)} · {minutesLabel(readingMinutes(length, locale), locale)}
        </div>
        <h1 data-reveal>{article.title}</h1>
        <p className="nw-m" data-article-author>{article.author.displayName}</p>
      </header>
      <article data-article-body>
        {article.contentBlocks.map((block) => {
          switch (block.type) {
            case "heading":
              return block.level === 2
                ? <h2 key={block.id}>{block.text}</h2>
                : <h3 key={block.id}>{block.text}</h3>;
            case "quote":
              return (
                <blockquote key={block.id}>
                  {block.text}
                  {block.attribution ? <cite>— {block.attribution}</cite> : null}
                </blockquote>
              );
            case "list":
              return block.ordered
                ? <ol key={block.id}>{block.items.map((item, index) => <li key={index}>{item}</li>)}</ol>
                : <ul key={block.id}>{block.items.map((item, index) => <li key={index}>{item}</li>)}</ul>;
            case "image":
              // The production page renders these through its image component;
              // the prototype keeps the markup equivalent but avoids that coupling.
              return <img key={block.id} src={block.src} alt={block.alt} />;
            case "code":
              return <pre key={block.id}><code>{block.code}</code></pre>;
            default:
              return <p key={block.id}>{block.text}</p>;
          }
        })}
      </article>
      <p className="nw-ep" data-prototype-note>
        评论、阅读工具栏与相关作品由共享的客户端组件提供，属于 Phase 4 的范围，此原型未接线。
      </p>
    </main>
  );
}
