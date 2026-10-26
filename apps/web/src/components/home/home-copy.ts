import type { Locale } from "@/lib/content.ts";

/**
 * Visual assets extracted from the homepage design demo. The content API has
 * no cover-image field yet, so the editorial artworks are shipped as static
 * files and cycled deterministically across cards and rows.
 */
export const HOME_IMAGES = {
  hero: "/home/hero.jpg",
  c1: "/home/c1.jpg",
  c2: "/home/c2.jpg",
  c3: "/home/c3.jpg",
} as const;

/** Image sequence used by the Latest showcase panel (matches the demo order). */
export const PANEL_IMAGE_SEQUENCE = [
  HOME_IMAGES.c2,
  HOME_IMAGES.c3,
  HOME_IMAGES.c1,
  HOME_IMAGES.hero,
  HOME_IMAGES.c3,
] as const;

export type HomeCopy = {
  loadingLabel: string;
  railLabel: (edition: string) => string;
  navSelected: string;
  navBlog: string;
  navTopics: string;
  searchLabel: string;
  bellUnreadLabel: string;
  bellReadLabel: string;
  notificationsTitle: string;
  markAllRead: string;
  notifications: [string, string, string];
  menuButton: string;
  menuClose: string;
  menuHome: string;
  menuSelected: string;
  menuLatest: string;
  menuTopics: string;
  selectedPrimary: string;
  selectedAccent: string;
  latestPrimary: string;
  latestAccent: string;
  browseAll: string;
  topicsEyebrow: string;
  exploreTopics: string;
  fallbackCover: string;
  emptyResults: string;
  footerHome: string;
  footerBlog: string;
  footerTopics: string;
  footerSearch: string;
  rights: (year: number) => string;
};

const zhCopy: HomeCopy = {
  loadingLabel: "载入中 · LOADING",
  railLabel: (edition) => `无浪潮 · No Wave — ${edition}`,
  navSelected: "精选",
  navBlog: "作品",
  navTopics: "主题",
  searchLabel: "搜索",
  bellUnreadLabel: "通知，3 条未读",
  bellReadLabel: "通知，没有未读",
  notificationsTitle: "通知",
  markAllRead: "全部标为已读",
  notifications: [
    "你关注的分类有新作品发表",
    "你的评论收到一条新回复",
    "有作者开始关注你",
  ],
  menuButton: "选单",
  menuClose: "关闭",
  menuHome: "首页",
  menuSelected: "精选",
  menuLatest: "最新",
  menuTopics: "主题",
  selectedPrimary: "精选",
  selectedAccent: "Selected",
  latestPrimary: "最新",
  latestAccent: "Latest",
  browseAll: "全部作品",
  topicsEyebrow: "主题 / Topics",
  exploreTopics: "探索全部主题",
  fallbackCover: "默认封面",
  emptyResults: "没有符合条件的作品。",
  footerHome: "首页",
  footerBlog: "作品",
  footerTopics: "主题",
  footerSearch: "搜索",
  rights: (year) => `© ${year} 无浪潮 No Wave · 简 / EN`,
};

const enCopy: HomeCopy = {
  loadingLabel: "LOADING",
  railLabel: (edition) => `NOWAVE · No Wave — ${edition}`,
  navSelected: "Selected",
  navBlog: "Works",
  navTopics: "Topics",
  searchLabel: "Search",
  bellUnreadLabel: "Notifications, 3 unread",
  bellReadLabel: "Notifications, no unread",
  notificationsTitle: "Notifications",
  markAllRead: "Mark all as read",
  notifications: [
    "A new work was published in a category you follow",
    "Your comment received a new reply",
    "An author started following you",
  ],
  menuButton: "Menu",
  menuClose: "Close",
  menuHome: "Home",
  menuSelected: "Selected",
  menuLatest: "Latest",
  menuTopics: "Topics",
  selectedPrimary: "Selected",
  selectedAccent: "精选",
  latestPrimary: "Latest",
  latestAccent: "最新",
  browseAll: "Browse all works",
  topicsEyebrow: "Topics / 主题",
  exploreTopics: "Explore all topics",
  fallbackCover: "Default cover",
  emptyResults: "No works match your search.",
  footerHome: "Home",
  footerBlog: "Works",
  footerTopics: "Topics",
  footerSearch: "Search",
  rights: (year) => `© ${year} 无浪潮 No Wave · EN / 简`,
};

export function getHomeCopy(locale: Locale): HomeCopy {
  return locale === "en" ? enCopy : zhCopy;
}

export function homeDateLabel(value: string, locale: Locale): string {
  return new Date(value)
    .toLocaleDateString(locale, { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "UTC" })
    .replaceAll("/", ".");
}

export function editionLabel(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}.${month}`;
}
