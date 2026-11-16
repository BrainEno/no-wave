import type { Locale } from "./content.ts";

const en = {
  toggle: "Find in this work", query: "Words in this work", hint: "Searches the article body only. Words stay in this tab, not in URLs, backups or network requests. F3 / Shift+F3 moves through matches; Escape closes search.",
  caseSensitive: "Match case", foldWidth: "Treat full-width and half-width alike", next: "Next match", previous: "Previous match", close: "Close article search", clear: "Clear search", searching: "Searching this work…",
  count: (count: number) => `${count} matches in this work`, active: (index: number, total: number) => `Match ${index} of ${total}`,
  none: "No matching words in the searched body.", more: "Only the first 200 matches are shown. Use a more specific phrase.", limited: "Only the first 200,000 body characters are searched.", invalid: "Enter at most 100 characters, without control characters.",
  unsupported: "This browser cannot safely search text. Use the browser’s Find command; other reading tools are unchanged.",
  moved: "The article changed before this match could be located. Search again.", interrupted: "Location cancelled because you moved elsewhere.", noPaint: "This browser cannot paint search highlights. The results and location buttons still work.",
};
const zh: typeof en = {
  toggle: "在本文查找", query: "查找本文中的文字", hint: "只检索作品正文，查找词只留在当前标签页，不进入网址、备份或网络请求。F3 / Shift+F3 切换位置，Escape 关闭查找。",
  caseSensitive: "区分大小写", foldWidth: "全角半角视为相同", next: "下一处", previous: "上一处", close: "关闭正文查找", clear: "清除查找", searching: "正在查找正文……",
  count: count => `在本文找到 ${count} 处`, active: (index, total) => `第 ${index} / ${total} 处`,
  none: "已检索的正文中没有符合的文字。", more: "只显示前 200 处，请使用更具体的文字。", limited: "只检索正文的前 200,000 个字符。", invalid: "请输入不超过 100 个字符，不要包含控制字符。",
  unsupported: "当前浏览器无法查找正文，请使用浏览器自带的查找。",
  moved: "定位前正文已有变化，请重新查找。", interrupted: "你已移向其他位置，本次定位已取消。", noPaint: "当前浏览器不能绘制查找高亮，结果与定位按钮仍可使用。",
};
export function readerFindCopy(locale: Locale) { return locale === "en" ? en : zh; }
