import type { Locale, WorkType } from "@/lib/content.ts";
import { loadSearchPage, type SearchTab } from "@/lib/public-pages.ts";
import { SearchPageView } from "@/components/public/search-view.tsx";

/** Re-exported so existing App Router imports keep working unchanged. */
export { parseTab, type SearchTab } from "@/lib/public-pages.ts";
/**
 * 搜索 — App Router entry point.
 *
 * `loadSearchPage` performs the (at most two) API calls and returns plain data;
 * `SearchView` renders it. React Router uses the same two pieces, which is why
 * the load/render seam exists at all.
 */
export async function SearchContent({ locale, query, tab, type }: { locale: Locale; query: string; tab: SearchTab; type: WorkType | null }) {
  const data = await loadSearchPage({ locale, query, tab, type });
  return <SearchPageView {...data} />;
}
