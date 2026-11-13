import type { Locale } from "./content.ts";

type TagCopy = {
  title: string; eyebrow: string; intro: string; search: string; placeholder: string;
  submit: string; clear: string; all: string; results: string; articleTags: string;
  none: string; noMatch: string; noMore: string; emptyTag: string; noMoreWorks: string;
  browseWorks: string; firstPage: string; queryHint: string; subscribe: string;
  works: (count: number) => string;
};
const copy: Record<Locale, TagCopy> = {
  "zh-CN": {
    title: "标签", eyebrow: "阅读索引 / 标签", intro: "从作者使用的标签出发，寻找同一主题下已经发表的作品。",
    search: "搜索标签", placeholder: "输入标签名称，可带 #", submit: "搜索", clear: "清除搜索", all: "全部标签", results: "标签搜索结果", articleTags: "作品标签",
    none: "还没有可浏览的标签。", noMatch: "没有符合条件的标签。", noMore: "此页没有更多标签。",
    emptyTag: "这个标签下还没有已发表的作品。", noMoreWorks: "此页没有更多已发表的作品。",
    subscribe: "标签订阅", browseWorks: "浏览全部作品", firstPage: "返回第一页", queryHint: "可以尝试更短的名称，或清除搜索浏览全部标签。",
    works: (count) => `${count} 篇已发表作品`,
  },
  "zh-TW": {
    title: "標籤", eyebrow: "閱讀索引 / 標籤", intro: "從作者使用的標籤出發，尋找同一主題下已經發表的作品。",
    search: "搜尋標籤", placeholder: "輸入標籤名稱，可帶 #", submit: "搜尋", clear: "清除搜尋", all: "全部標籤", results: "標籤搜尋結果", articleTags: "作品標籤",
    none: "還沒有可瀏覽的標籤。", noMatch: "沒有符合條件的標籤。", noMore: "此頁沒有更多標籤。",
    emptyTag: "這個標籤下還沒有已發表的作品。", noMoreWorks: "此頁沒有更多已發表的作品。",
    subscribe: "標籤訂閱", browseWorks: "瀏覽全部作品", firstPage: "返回第一頁", queryHint: "可以嘗試更短的名稱，或清除搜尋瀏覽全部標籤。",
    works: (count) => `${count} 篇已發表作品`,
  },
  en: {
    title: "Tags", eyebrow: "Reading index / Tags", intro: "Follow community hashtags to discover published writing on a shared theme.",
    search: "Search tags", placeholder: "Enter a tag name, with or without #", submit: "Search", clear: "Clear search", all: "All tags", results: "Tag search results", articleTags: "Article tags",
    none: "There are no tags to browse yet.", noMatch: "No tags match your search.", noMore: "There are no more tags on this page.",
    emptyTag: "There are no published works under this tag yet.", noMoreWorks: "There are no more published works on this page.",
    subscribe: "Tag subscriptions", browseWorks: "Browse all works", firstPage: "Back to the first page", queryHint: "Try a shorter name, or clear the search to browse all tags.",
    works: (count) => `${count} published ${count === 1 ? "work" : "works"}`,
  },
};

export function getTagCopy(locale: Locale): TagCopy {
  return copy[locale];
}
