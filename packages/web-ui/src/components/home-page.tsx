import { HomePageView } from "@/components/public/home-view.tsx";
import { loadHomePage } from "@/lib/public-pages.ts";
import type { Locale } from "@/lib/content.ts";

/**
 * 首页 — App Router entry point.
 *
 * Same load/render split as the other public pages: `loadHomePage` performs the
 * two concurrent reads (articles, categories) and `HomePageView` renders the
 * result, so the React Router prototype serves the identical page from the
 * identical data despite having no async server components.
 */
export async function HomeContent({ locale }: { locale: Locale }) {
  const data = await loadHomePage({ locale });
  return <HomePageView {...data} />;
}
