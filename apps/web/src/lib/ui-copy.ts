import type { Locale } from "./content.ts";

export type UiCopy = ReturnType<typeof zh>;

function zh() {
  return {
    brand: "无浪潮", brandLatin: "No Wave", homeAria: "无浪潮 No Wave 首页", rail: "无浪潮 · No Wave — 独立文学出版",
    nav: { works: "作品", topics: "分类", search: "搜索", menu: "选单", close: "关闭", primary: "主导航", footer: "页尾导航", home: "首页", language: "切换语言" },
    bell: { label: "通知", empty: "暂无通知", hint: "登录后，你关注的作者与讨论提醒会出现在这里。", signIn: "登录" },
    home: {
      eyebrow: "独立文学出版 · 阅读 · 交流", tagline: "为值得认真阅读的作品，留出位置。", start: "开始阅读", selected: "精选", selectedEn: "Selected",
      latest: "最新发表", latestEn: "Latest", topics: "主题", topicsEn: "Topics", allWorks: "全部作品", allTopics: "探索全部分类", empty: "还没有发表的作品。",
      marquee: ["No Wave", "无浪潮", "Archive", "档案"], issue: "VOL. 01", scroll: "向下阅读",
    },
    archive: {
      title: "作品", titleEn: "Works", all: "全部", search: "搜索作品", placeholder: "输入标题、摘要或作者", button: "搜索", clear: "清除筛选",
      count: (n: number) => `${n} 篇作品`, lead: "最新发表", poemFrom: "诗歌摘句", noResults: "没有符合条件的作品", noResultsHint: "试试取消类型筛选，或换一个更短的关键词。",
      limitNote: "类型筛选作用于最新的 100 篇匹配作品。", typeLabel: "作品类型",
    },
    pager: { prev: "上一页", next: "下一页", page: (n: number) => `第 ${n} 页`, label: "分页" },
    reader: {
      back: "返回作品列表", published: "发表于", by: "作者", fontSmaller: "减小字号", fontLarger: "增大字号", theme: "切换纸色或墨色背景", dark: "墨", light: "纸",
      copyLink: "复制链接", copied: "链接已复制", toc: "目录", end: "全文完", aboutAuthor: "关于作者", allWorks: "全部作品", prev: "更早的作品", next: "更新的作品",
      related: "继续阅读", relatedEn: "Related", progress: "阅读进度", fontSize: (n: number) => `正文字号 ${n}px`, share: "分享",
    },
    author: { profile: "作者", works: "作品目录", worksEn: "Catalogue", recent: "近期作品", none: "这位作者还没有公开发表的作品。", count: (n: number) => `${n} 篇作品`, limitNote: "目录取自最新的 100 篇作品。" },
    categories: {
      eyebrow: "阅读索引 / 分类", title: "按分类发现作品", intro: "分类来自平台实际维护的出版数据，而不是写死在界面里的标签。", search: "搜索分类", placeholder: "输入分类名称", button: "搜索", clear: "清除",
      works: (n: number) => `${n} 篇作品`, none: "目前尚无可浏览的作品分类。", noMatch: "没有符合搜索条件的分类。", noMore: "此页没有更多分类。", all: "全部分类", published: (n: number) => `${n} 篇已发表作品`,
      emptyCategory: "此分类目前尚无已发表作品。", noMoreWorks: "此页没有更多作品。",
    },
    search: {
      title: "搜索", label: "搜索作品、作者与分类", placeholder: "输入关键词", button: "搜索", works: "作品", authors: "作者", categories: "分类", recent: "最近搜索",
      intro: "输入标题、摘要或作者名。", none: (q: string) => `没有找到与「${q}」相关的结果`, hint: "检查是否有错别字，或换一个更短、更常见的词。也可以直接按类型浏览。",
      browse: "按类型浏览", total: (n: number) => `共 ${n} 条结果`, authorWorks: (n: number) => `${n} 篇相关作品`,
    },
    states: {
      loading: "载入中…", errorTitle: "页面加载失败", errorBody: "服务暂时不可用，请稍后重试。你的阅读位置不会丢失。", retry: "重试", errorPrefix: "错误：",
      notFoundTitle: "找不到这个页面", notFoundBody: "你访问的内容不存在，或已被移除。", backHome: "回到首页",
    },
    footer: { rights: "无浪潮 No Wave", language: "简体中文", signIn: "登录" },
    signIn: { title: "登录", body: "身份验证尚未在当前阶段实现。登录、关注与通知将在后端就绪后接入。" },
  };
}
function en(): UiCopy {
  return {
    brand: "No Wave", brandLatin: "No Wave", homeAria: "No Wave home", rail: "NO WAVE — INDEPENDENT LITERARY PUBLISHING",
    nav: { works: "Works", topics: "Topics", search: "Search", menu: "Menu", close: "Close", primary: "Primary navigation", footer: "Footer navigation", home: "Home", language: "Switch language" },
    bell: { label: "Notifications", empty: "No notifications", hint: "Sign in to see reminders from the authors and discussions you follow.", signIn: "Sign in" },
    home: {
      eyebrow: "INDEPENDENT LITERARY PUBLISHING", tagline: "Independent publishing for writing worth reading slowly.", start: "Start reading", selected: "Selected", selectedEn: "Selected",
      latest: "Latest", latestEn: "Latest", topics: "Topics", topicsEn: "Topics", allWorks: "All works", allTopics: "Explore all topics", empty: "Nothing has been published yet.",
      marquee: ["No Wave", "Archive", "Index", "Read slowly"], issue: "VOL. 01", scroll: "Scroll to read",
    },
    archive: {
      title: "Works", titleEn: "Works", all: "All", search: "Search works", placeholder: "Title, summary or author", button: "Search", clear: "Clear filters",
      count: (n: number) => `${n} ${n === 1 ? "work" : "works"}`, lead: "Latest", poemFrom: "From a poem", noResults: "No works match", noResultsHint: "Try clearing the type filter or using a shorter keyword.",
      limitNote: "Type filters apply to the latest 100 matching works.", typeLabel: "Work type",
    },
    pager: { prev: "Previous", next: "Next", page: (n: number) => `Page ${n}`, label: "Pagination" },
    reader: {
      back: "Back to works", published: "Published", by: "By", fontSmaller: "Decrease text size", fontLarger: "Increase text size", theme: "Toggle paper or ink background", dark: "Ink", light: "Paper",
      copyLink: "Copy link", copied: "Link copied", toc: "Contents", end: "End", aboutAuthor: "About the author", allWorks: "All works", prev: "Earlier work", next: "Later work",
      related: "Keep reading", relatedEn: "Related", progress: "Reading progress", fontSize: (n: number) => `Text size ${n}px`, share: "Share",
    },
    author: { profile: "Author", works: "Catalogue", worksEn: "Catalogue", recent: "Recent work", none: "This author has no published work yet.", count: (n: number) => `${n} ${n === 1 ? "work" : "works"}`, limitNote: "Catalogue drawn from the latest 100 works." },
    categories: {
      eyebrow: "THE READING INDEX / CATEGORIES", title: "Explore by category", intro: "Categories are maintained as real publication data, not a fixed list in the interface.", search: "Search categories", placeholder: "Enter a category name", button: "Search", clear: "Clear",
      works: (n: number) => `${n} ${n === 1 ? "work" : "works"}`, none: "No categories have been published yet.", noMatch: "No categories match your search.", noMore: "No more categories on this page.", all: "All categories", published: (n: number) => `${n} published ${n === 1 ? "work" : "works"}`,
      emptyCategory: "There are no published works in this category yet.", noMoreWorks: "No more works on this page.",
    },
    search: {
      title: "Search", label: "Search works, authors and categories", placeholder: "Enter a keyword", button: "Search", works: "Works", authors: "Authors", categories: "Categories", recent: "Recent searches",
      intro: "Enter a title, summary or author name.", none: (q: string) => `No results for “${q}”`, hint: "Check the spelling, or try a shorter, more common word. You can also browse by type.",
      browse: "Browse by type", total: (n: number) => `${n} ${n === 1 ? "result" : "results"}`, authorWorks: (n: number) => `${n} matching ${n === 1 ? "work" : "works"}`,
    },
    states: {
      loading: "Loading…", errorTitle: "This page failed to load", errorBody: "The service is temporarily unavailable. Your reading position is kept.", retry: "Retry", errorPrefix: "Error: ",
      notFoundTitle: "Page not found", notFoundBody: "The content does not exist or has been removed.", backHome: "Back to home",
    },
    footer: { rights: "No Wave", language: "English", signIn: "Sign in" },
    signIn: { title: "Sign in", body: "Authentication is not implemented at this stage. Sign-in, following and notifications will be connected once the backend is ready." },
  };
}
export function getUi(locale: Locale): UiCopy { return locale === "en" ? en() : zh(); }
