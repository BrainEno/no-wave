import type { Locale } from "./content.ts";

const english = {
  title: "Notifications", introduction: "Your notification history, in one place.", refresh: "Refresh notifications",
  loading: "Loading notifications…", empty: "No notifications yet.", emptyFiltered: "No loaded notifications match these filters.",
  remaining: "Older notifications may still match. Load more or refresh before concluding that the inbox is empty.",
  unseen: "Unread notifications remain. Refresh to retrieve the latest list.", view: "View", mark: "Mark read", markAll: "Mark all read",
  more: "Load more notifications", signIn: "Sign in again", signedOut: "Sign in to read your notifications.",
  filters: "Notification filters", statusFilter: "Read status", kindFilter: "Notification type", all: "All", unread: "Unread", read: "Read",
  comments: "Comments and replies", likes: "Likes", follows: "Followers", messages: "Messages", system: "Other notifications",
  today: "Today", yesterday: "Yesterday", undated: "Date unavailable", timezone: "Dates are shown in UTC.",
  loadedOnly: "Filters apply to loaded notifications, not the whole inbox.", reset: "Clear filters", keyboard: "When a notification row has focus, use Up, Down, Home or End to move between rows.",
  marked: "Notification marked read.", markedAll: "The loaded notifications were marked read. The total below is confirmed separately.", noneUnread: "No unread notifications remain.",
  refreshed: "Notifications refreshed.", moreLoaded: "More notifications loaded.", noMoreMatches: "This page added no matching notifications.",
  selectedWaiting: "Waiting for the selected notification…", selectedReady: "The selected notification is loaded.",
  selectedFiltered: "The selected notification is hidden by these filters.", selectedOlder: "The selected notification is not loaded yet. Load more to look for it; older history is never scanned automatically.",
  selectedMissing: "This notification is unavailable in the current inbox.", jump: "Jump to selected notification", showWithoutFilters: "Show without filters",
  failed: "The action was not fully confirmed. Review the error and refresh before retrying.", busy: "A notification request is already in progress.",
};
const chinese: typeof english = {
  title: "通知", introduction: "在同一处查看你的通知历史。", refresh: "刷新通知",
  loading: "载入中…", empty: "还没有通知。", emptyFiltered: "已载入的通知中没有符合筛选条件的内容。",
  remaining: "较早的通知仍可能符合条件，请加载更多或刷新后再确认收件箱是否为空。",
  unseen: "尚有未读通知，请刷新以取得最新列表。", view: "查看", mark: "标记已读", markAll: "全部标为已读",
  more: "加载更多通知", signIn: "重新登录", signedOut: "登录后查看你的通知。",
  filters: "通知筛选", statusFilter: "阅读状态", kindFilter: "通知类型", all: "全部", unread: "未读", read: "已读",
  comments: "评论与回复", likes: "喜欢", follows: "关注", messages: "私信", system: "其他通知",
  today: "今天", yesterday: "昨天", undated: "日期未知", timezone: "日期以 UTC 显示。",
  loadedOnly: "筛选仅作用于已载入的通知，不代表整个收件箱。", reset: "清除筛选", keyboard: "焦点位于通知行时，可用上、下、Home 或 End 键在通知之间移动。",
  marked: "通知已标为已读。", markedAll: "已载入的通知已标为已读，下方总数另由服务端确认。", noneUnread: "收件箱已没有未读通知。",
  refreshed: "通知已刷新。", moreLoaded: "已载入更多通知。", noMoreMatches: "本页没有新增符合条件的通知。",
  selectedWaiting: "正在等待所选通知…", selectedReady: "所选通知已载入。",
  selectedFiltered: "所选通知被当前筛选条件隐藏了。", selectedOlder: "所选通知尚未载入，可以加载更多来查找；系统不会自动扫描历史记录。",
  selectedMissing: "当前收件箱中找不到这条通知。", jump: "跳至所选通知", showWithoutFilters: "取消筛选并查看",
  failed: "操作尚未完整确认，请先查看错误并刷新，再决定是否重试。", busy: "已有通知请求正在进行。",
};

export function notificationInboxCopy(locale: Locale): typeof english {
  return locale === "en" ? english : chinese;
}
