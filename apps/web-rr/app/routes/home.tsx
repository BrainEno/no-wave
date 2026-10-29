import { Link, useLoaderData } from "react-router";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { SectionHeading, WorkRow } from "@/components/ui/parts.tsx";
import { homeMetadata, homePath, type Locale } from "@/lib/content.ts";
import { listPublicArticles } from "@/lib/api-content.ts";
import { metaDescriptors } from "../lib/meta.ts";
import { siteUrl } from "../lib/runtime.ts";

const locale: Locale = "zh-CN";

/**
 * Public list route.
 *
 * The data comes from the shared `listPublicArticles` helper (same REST client,
 * same fixture fallback as the Next.js home page), and the markup is rendered by
 * the **unmodified** shared components `SectionHeading` and `WorkRow`, whose
 * `next/link` imports resolve to the adapter in `app/shims/next-link.tsx`.
 */
export async function loader(_args: LoaderFunctionArgs) {
  const articles = await listPublicArticles({ locale, limit: 5 });
  return { articles };
}

export const meta: MetaFunction<typeof loader> = () => metaDescriptors(homeMetadata(locale, siteUrl()));

export default function HomeRoute() {
  const { articles } = useLoaderData<typeof loader>();
  return (
    <main className="nw-w" data-route="home">
      <h1 data-reveal>无浪潮 · No Wave</h1>
      <p className="nw-ep">以文学作品发表、认真阅读与深度交流为中心的独立数字出版平台。</p>
      <SectionHeading zh="最新作品" latin="Latest" />
      {articles.length === 0 ? <p className="nw-ep" data-empty-state>暂无已发布作品。</p> : (
        <div data-article-list>
          {articles.map((article, index) => (
            <WorkRow key={article.slug} article={article} locale={locale} index={index + 1} />
          ))}
        </div>
      )}
      <p><Link className="nw-btn" to={homePath("en")}>English</Link></p>
    </main>
  );
}
