import type { Locale } from "./content.ts";

export type UiCopy = ReturnType<typeof zh>;

function zh() {
  return {
    brand: "无浪潮", brandLatin: "No Wave", homeAria: "无浪潮 No Wave 首页", rail: "无浪潮 · No Wave — 独立文学出版",
    nav: { selected: "精选", latest: "最新", works: "作品", write: "写作", topics: "分类", authors: "作者", search: "搜索", menu: "选单", close: "关闭", primary: "主导航", footer: "页尾导航", home: "首页", language: "切换语言", account: "账户", accountAria: "我的账户" },
    bell: { label: "通知", empty: "暂无通知", hint: "登录后，你关注的作者与讨论提醒会出现在这里。", signIn: "登录", loading: "载入中…", error: "通知暂时无法载入，请稍后重试。", markRead: "标记已读", markAllRead: "全部标为已读", unread: "条未读" },
    home: {
      eyebrow: "独立文学出版 · 阅读 · 交流", tagline: "为值得认真阅读的作品，留出位置。", start: "开始阅读", selected: "精选", selectedEn: "Selected",
      latest: "最新", latestEn: "Latest", topics: "主题", topicsEn: "Topics", allWorks: "全部作品", allTopics: "探索全部分类", empty: "还没有发表的作品。",
      // The shelf is picked by an editor, and says so — otherwise a reader cannot
      // tell the difference between "chosen" and "just the newest three".
      selectedNote: "由编辑挑选并排序", selectedFallback: "编辑还没有安排精选，下面是最近发表的作品。",
      popular: "最多收藏", popularEn: "Most saved", saves: (n: number) => `${n} 次收藏`,
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
      // 朗读：顺序与文案都在 read-aloud.ts 里决定，这里只管界面上的词。
      listen: "朗读", pause: "暂停", resume: "继续", stop: "停止", done: "朗读结束",
      unavailable: "这台浏览器没有可用的语音，朗读没能开始。",
      position: (n: number, total: number) => `正在朗读第 ${n} 段，共 ${total} 段`,
      // 划线：段落靠文字与上下文重新定位，标注只存在读者自己的浏览器里。
      passages: {
        shelf: "我的划线", empty: "还没有划线。选中正文里的一段，它就会留在这台设备上。",
        mark: "划线", note: "加注", edit: "修改", locate: "定位", remove: "删除", cancel: "取消", save: "保存",
        read: "朗读这段", readStop: "停止",
        placeholder: "写下你对这一段的想法……", count: (n: number, total: number) => `${n}/${total}`,
        saved: "已保存在这台设备上。", removed: "这条划线已删除。",
        full: "这篇作品的划线已经满了；先删掉一条，再加新的。", tooLong: "这一段太长了，一次划线的上限是 240 字。",
        storageError: "这台浏览器不允许保存，划线只留在这个页面上。", gone: "这段文字已经不在作品里了；划线还留着，等它回来。",
        // 分享：带走的是一条链接，里面只有作品本来就有的字。
        share: "分享", shareTitle: "分享这一段",
        shareHint: "链接里只有这段原文，不含你的笔记；它也不会发到服务器上。",
        copy: "复制链接", copied: "链接已复制", copyFailed: "这台浏览器不允许自动复制，请手动复制上面的链接。",
        shared: "有人和你分享了这一段", sharedSave: "保存到我的划线", sharedDismiss: "关闭",
        sharedSaved: "已经收进你的划线。",
        sharedGone: "这一段的文字已经不在作品里了，页面上没有画出来。",
      },
    },
    author: { profile: "作者", works: "作品目录", worksEn: "Catalogue", recent: "近期作品", none: "这位作者还没有公开发表的作品。", count: (n: number) => `${n} 篇作品`, limitNote: "目录取自最新的 100 篇作品。" },
    authors: {
      eyebrow: "阅读索引 / 作者", title: "按作者发现作品", intro: "这里是在本站发表过作品的作者。搜一个名字，就能走到他写的东西。", search: "搜索作者", placeholder: "输入作者名", button: "搜索", clear: "清除",
      works: (n: number) => `${n} 篇作品`, followers: (n: number) => `${n} 人关注`, none: "还没有作者在本站发表作品。", noMatch: "没有符合搜索条件的作者。", noMore: "此页没有更多作者。", all: "全部作者",
    },
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
    auth: {
      /**
       * What a form says instead of the API's own words.
       *
       * The API answers with a stable code and a deliberately generic English
       * sentence — it cannot know what the page around it is doing. The codes a
       * form can act on get a sentence here; everything else keeps what the
       * server said. See `lib/api-error.ts`.
       */
      emailTaken: "这个邮箱已经注册过了，直接登录即可。",
      failed: "请求失败，请稍后重试。",
    },
  };
}
function en(): UiCopy {
  return {
    brand: "No Wave", brandLatin: "No Wave", homeAria: "No Wave home", rail: "NO WAVE — INDEPENDENT LITERARY PUBLISHING",
    nav: { selected: "Selected", latest: "Latest", works: "Works", write: "Write", topics: "Topics", authors: "Authors", search: "Search", menu: "Menu", close: "Close", primary: "Primary navigation", footer: "Footer navigation", home: "Home", language: "Switch language", account: "Account", accountAria: "My account" },
    bell: { label: "Notifications", empty: "No notifications", hint: "Sign in to see reminders from the authors and discussions you follow.", signIn: "Sign in", loading: "Loading…", error: "Notifications could not be loaded. Please try again.", markRead: "Mark read", markAllRead: "Mark all read", unread: "unread" },
    home: {
      eyebrow: "INDEPENDENT LITERARY PUBLISHING", tagline: "Independent publishing for writing worth reading slowly.", start: "Start reading", selected: "Selected", selectedEn: "Selected",
      latest: "Latest", latestEn: "Latest", topics: "Topics", topicsEn: "Topics", allWorks: "All works", allTopics: "Explore all topics", empty: "Nothing has been published yet.",
      selectedNote: "Chosen and ordered by the editors", selectedFallback: "The editors have not arranged a selection yet — these are the most recent works.",
      popular: "Most saved", popularEn: "Most saved", saves: (n: number) => `${n} ${n === 1 ? "save" : "saves"}`,
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
      listen: "Listen", pause: "Pause", resume: "Resume", stop: "Stop", done: "Finished reading",
      unavailable: "This browser has no voice available, so nothing was read.",
      position: (n: number, total: number) => `Reading paragraph ${n} of ${total}`,
      passages: {
        shelf: "My marks", empty: "Nothing marked yet. Select a passage in the text and it stays on this device.",
        mark: "Mark", note: "Add a note", edit: "Edit", locate: "Find", remove: "Remove", cancel: "Cancel", save: "Save",
        read: "Read it", readStop: "Stop",
        placeholder: "What do you make of this passage?…", count: (n: number, total: number) => `${n}/${total}`,
        saved: "Saved on this device.", removed: "Mark removed.",
        full: "This work is full of marks; remove one before adding another.", tooLong: "That passage is too long — a mark holds up to 240 characters.",
        storageError: "This browser will not let the page store anything, so marks stay only on this page.", gone: "Those words are no longer in the work; the mark is kept until they come back.",
        share: "Share", shareTitle: "Share this passage",
        shareHint: "The link carries these words and nothing else — not your note, and not a single request to the server.",
        copy: "Copy link", copied: "Link copied", copyFailed: "This browser will not let the page copy; select the link above and copy it by hand.",
        shared: "Someone shared this passage with you", sharedSave: "Keep it in my marks", sharedDismiss: "Dismiss",
        sharedSaved: "It is on your shelf now.",
        sharedGone: "Those words are no longer in the work, so nothing has been marked.",
      },
    },
    author: { profile: "Author", works: "Catalogue", worksEn: "Catalogue", recent: "Recent work", none: "This author has no published work yet.", count: (n: number) => `${n} ${n === 1 ? "work" : "works"}`, limitNote: "Catalogue drawn from the latest 100 works." },
    authors: {
      eyebrow: "THE READING INDEX / AUTHORS", title: "Explore by author", intro: "Every writer who has published here. Search a name and go straight to what they wrote.", search: "Search authors", placeholder: "Enter an author name", button: "Search", clear: "Clear",
      works: (n: number) => `${n} ${n === 1 ? "work" : "works"}`, followers: (n: number) => `${n} ${n === 1 ? "follower" : "followers"}`, none: "No author has published here yet.", noMatch: "No authors match your search.", noMore: "No more authors on this page.", all: "All authors",
    },
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
    auth: {
      emailTaken: "That address already has an account. Sign in instead.",
      failed: "The request failed. Try again in a moment.",
    },
  };
}
export function getUi(locale: Locale): UiCopy { return locale === "en" ? en() : zh(); }
