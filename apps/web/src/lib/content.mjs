export const siteUrl = "https://example.invalid";
export const defaultLocale = "zh-CN";
export const supportedLocales = ["zh-CN", "en"];

const messageCatalog = {
  "zh-CN": {
    primaryNavigation: "主导航",
    homeTitle: "以文学作品为中心，构建独立的数字出版空间",
    homeDescription: "发现值得认真阅读、讨论与反复阅读的文学作品。",
    blog: "作品",
    blogTitle: "作品",
    blogDescription: "阅读无浪潮发表的文学作品与评论。",
    latestArticles: "最新发表",
    searchLabel: "搜索作品",
    searchPlaceholder: "输入标题或摘要",
    searchButton: "搜索",
    emptyResults: "没有符合条件的作品。",
    readArticle: "阅读作品",
    authorPrefix: "作者",
    switchLanguage: "English",
    backToArticles: "返回作品列表",
    publishedOn: "发表于",
    authorProfile: "作者主页",
    noAuthorArticles: "这位作者还没有公开发表的作品。",
    previousPage: "上一页",
    nextPage: "下一页",
    pageLabel: "第 {page} 页",
    workTypeLabels: {
      novel: "长篇小说", short_story: "短篇小说", poetry: "诗歌", essay: "散文",
      criticism: "评论", literary_criticism: "文学批评", nonfiction: "非虚构", serial: "连载", other: "作品"
    }
  },
  "zh-TW": {
    primaryNavigation: "主要導覽",
    homeTitle: "以內容為中心，逐步打造新的網路空間",
    homeDescription: "從文章開始，探索 BOT THK 的內容。",
    blog: "文章", blogTitle: "文章", blogDescription: "瀏覽 BOT THK 的文章與觀點。",
    latestArticles: "最新文章", searchLabel: "搜尋文章", searchPlaceholder: "輸入標題或摘要",
    searchButton: "搜尋", emptyResults: "沒有符合條件的文章。", readArticle: "閱讀文章",
    authorPrefix: "作者", switchLanguage: "简体中文", backToArticles: "返回文章列表",
    publishedOn: "發布於", authorProfile: "作者資料", noAuthorArticles: "此作者目前沒有可顯示的文章。",
    previousPage: "上一頁", nextPage: "下一頁", pageLabel: "第 {page} 頁",
    workTypeLabels: {
      novel: "长篇小说", short_story: "短篇小说", poetry: "诗歌", essay: "散文",
      criticism: "评论", literary_criticism: "文学批评", nonfiction: "非虚构", serial: "连载", other: "作品"
    }
  },
  en: {
    primaryNavigation: "Primary navigation",
    homeTitle: "A home for serious literature",
    homeDescription: "Discover literary work, sustained reading, and thoughtful exchange at Nowave.",
    blog: "Blog",
    blogTitle: "Articles",
    blogDescription: "Browse published literary work, essays, criticism, and nonfiction.",
    latestArticles: "Latest articles",
    searchLabel: "Search articles",
    searchPlaceholder: "Enter a title or summary",
    searchButton: "Search",
    emptyResults: "No articles match your search.",
    readArticle: "Read article",
    authorPrefix: "By",
    switchLanguage: "简体中文",
    backToArticles: "Back to articles",
    publishedOn: "Published",
    authorProfile: "Author profile",
    noAuthorArticles: "This author has no articles to display yet.",
    previousPage: "Previous",
    nextPage: "Next",
    pageLabel: "Page {page}",
    workTypeLabels: {
      novel: "Novel", short_story: "Short story", poetry: "Poetry", essay: "Essay",
      criticism: "Criticism", literary_criticism: "Literary criticism", nonfiction: "Nonfiction", serial: "Serial", other: "Work"
    }
  }
};

const authorRecords = [{
  username: "bot-thk-team",
  displayNames: {
    "zh-CN": "无浪潮编辑部",
    "zh-TW": "BOT THK 團隊",
    en: "BOT THK Team"
  },
  bios: {
    "zh-CN": "专注于严肃文学创作、发表与交流的编辑团队。",
    "zh-TW": "BOT THK 的內容與產品團隊。",
    en: "The team behind BOT THK."
  }
}];

const articleRecords = [{
  slug: "portable-web-foundation",
  publishedAt: "2026-10-01T10:00:00Z",
  authorUsername: "bot-thk-team",
  workType: "essay",
  categories: [],
  tags: [],
  translations: {
    "zh-CN": {
      title: "文学作品的数字出版空间",
      description: "以作品本身为中心，探索严肃文学发表、阅读与交流的可能。",
      contentBlocks: [
        { id: "intro", type: "paragraph", text: "无浪潮希望为值得认真阅读的文学作品，提供一个能够持续被发现、阅读与讨论的空间。" },
        { id: "foundation", type: "heading", level: 2, text: "让作品回到中心" },
        { id: "separation", type: "paragraph", text: "小说、诗歌、散文与文学批评应保有各自的表达节奏，而不是被统一压缩成信息流里的同一种内容。" }
      ]
    },
    "zh-TW": {
      title: "可移植的 Web 基礎架構",
      description: "為具備搜尋友善能力、並與 API 獨立部署的網誌建立可測試的起點。",
      contentBlocks: [
        { id: "intro", type: "paragraph", text: "這是一篇示例文章，用來驗證可被搜尋引擎讀取的內容頁與路由中繼資料。" },
        { id: "foundation", type: "heading", level: 2, text: "可測試的基礎架構" },
        { id: "separation", type: "paragraph", text: "內容資料、路由與頁面中繼資料應保持分離，讓後續設計更新可以專注於表現方式。" }
      ]
    },
    en: {
      title: "A Portable Web Foundation",
      description: "A small, testable starting point for a search-friendly blog with an independently deployed API.",
      contentBlocks: [
        { id: "intro", type: "paragraph", text: "This example article verifies crawlable HTML and route metadata." },
        { id: "foundation", type: "heading", level: 2, text: "A testable foundation" },
        { id: "separation", type: "paragraph", text: "Content data, routes, and page metadata should stay separate so a later design refresh can focus on presentation." }
      ]
    }
  }
}];

function normalizeLocale(locale) {
  return ["zh-CN", "zh-TW", "en"].includes(locale) ? locale : defaultLocale;
}

export function getMessages(locale = defaultLocale) {
  return messageCatalog[normalizeLocale(locale)];
}

export function homePath(locale = defaultLocale) {
  const normalized = normalizeLocale(locale);
  return normalized === defaultLocale ? "/" : "/" + normalized;
}

export function archivePath(locale = defaultLocale) {
  const normalized = normalizeLocale(locale);
  return homePath(normalized) === "/" ? "/articles" : homePath(normalized) + "/articles";
}

export function articlePath(slug, locale = defaultLocale) {
  return archivePath(locale) + "/" + encodeURIComponent(slug);
}

export function authorPath(username, locale = defaultLocale) {
  const normalized = normalizeLocale(locale);
  const prefix = normalized === defaultLocale ? "" : "/" + normalized;
  return prefix + "/authors/" + encodeURIComponent(username);
}

function localizeAuthor(record, locale) {
  const normalized = normalizeLocale(locale);
  return {
    username: record.username,
    displayName: record.displayNames[normalized],
    bio: record.bios[normalized],
    locale: normalized,
    availableLocales: Object.keys(record.displayNames).filter((locale) => supportedLocales.includes(locale))
  };
}

export function getAuthorByUsername(username, locale = defaultLocale) {
  const record = authorRecords.find((author) => author.username === username);
  return record ? localizeAuthor(record, locale) : null;
}

function localizeArticle(record, locale) {
  const normalized = normalizeLocale(locale);
  const translation = record.translations[normalized];
  if (!translation) return null;
  const authorRecord = authorRecords.find((author) => author.username === record.authorUsername);
  if (!authorRecord) return null;
  return {
    slug: record.slug,
    title: translation.title,
    description: translation.description,
    contentBlocks: translation.contentBlocks,
    publishedAt: record.publishedAt,
    author: localizeAuthor(authorRecord, normalized),
    categories: record.categories,
    tags: record.tags,
    workType: record.workType ?? "other",
    locale: normalized,
    availableLocales: Object.keys(record.translations).filter((locale) => supportedLocales.includes(locale))
  };
}

export function getArticleBySlug(slug, locale = defaultLocale) {
  const record = articleRecords.find((article) => article.slug === slug);
  return record ? localizeArticle(record, locale) : null;
}

export function listArticles({ locale = defaultLocale, query = "", authorUsername = null, limit, offset = 0 } = {}) {
  const normalized = normalizeLocale(locale);
  const needle = typeof query === "string" ? query.trim().toLocaleLowerCase(normalized) : "";
  return articleRecords
    .filter((article) => !authorUsername || article.authorUsername === authorUsername)
    .map((article) => localizeArticle(article, normalized))
    .filter((article) => article !== null)
    .filter((article) => {
      if (!needle) return true;
      return [article.title, article.description, article.author.displayName]
        .some((value) => value.toLocaleLowerCase(normalized).includes(needle));
    })
    .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt))
    .slice(offset, limit === undefined ? undefined : offset + limit);
}

function languageAlternates(paths, baseUrl) {
  return Object.fromEntries(
    paths.map(([locale, path]) => [locale, new URL(path, baseUrl).toString()])
  );
}

export function articleMetadata(article, baseUrl = siteUrl) {
  const canonical = new URL(articlePath(article.slug, article.locale), baseUrl).toString();
  const languages = languageAlternates(
    article.availableLocales.map((locale) => [locale, articlePath(article.slug, locale)]),
    baseUrl
  );
  return {
    title: article.title,
    description: article.description,
    alternates: { canonical, languages },
    openGraph: {
      type: "article",
      title: article.title,
      description: article.description,
      url: canonical,
      locale: article.locale
    }
  };
}

export function archiveMetadata(locale = defaultLocale, baseUrl = siteUrl) {
  const normalized = normalizeLocale(locale);
  const copy = getMessages(normalized);
  const languages = languageAlternates(
    supportedLocales.map((item) => [item, archivePath(item)]),
    baseUrl
  );
  return {
    title: copy.blogTitle,
    description: copy.blogDescription,
    alternates: {
      canonical: new URL(archivePath(normalized), baseUrl).toString(),
      languages
    }
  };
}

export function homeMetadata(locale = defaultLocale, baseUrl = siteUrl) {
  const normalized = normalizeLocale(locale);
  const copy = getMessages(normalized);
  const languages = languageAlternates(
    supportedLocales.map((item) => [item, homePath(item)]),
    baseUrl
  );
  return {
    title: copy.homeTitle,
    description: copy.homeDescription,
    alternates: {
      canonical: new URL(homePath(normalized), baseUrl).toString(),
      languages
    }
  };
}

export function authorMetadata(author, baseUrl = siteUrl) {
  const canonical = new URL(authorPath(author.username, author.locale), baseUrl).toString();
  const languages = languageAlternates(
    author.availableLocales.map((locale) => [locale, authorPath(author.username, locale)]),
    baseUrl
  );
  return {
    title: author.displayName,
    description: author.bio,
    alternates: { canonical, languages }
  };
}

export const articleFixture = getArticleBySlug("portable-web-foundation", defaultLocale);
