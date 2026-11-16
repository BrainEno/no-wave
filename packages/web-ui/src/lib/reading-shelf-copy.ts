import type { Locale } from "./content.ts";
import type { ShelfBackupProblem } from "./reading-shelf-backup.ts";
import type { ShelfProblem } from "./reading-shelf-store.ts";

const en = {
  title: "Reading list", intro: "A small shelf on this browser. No account, synchronization or reading history is sent to the site.",
  privacy: "Shared browser, shared list. Clearing site data removes it. Back up the list before changing devices.",
  loading: "Reading this browser’s list…", unavailable: "Local storage is unavailable, so changes cannot be confirmed. Previous entries may still exist. Check your browser settings and retry.",
  readOnly: "Safe cross-tab writes are unavailable in this browser. You can view and export existing entries, but changes are disabled.",
  retry: "Retry local storage", save: "Add to reading list", saved: "Added to this browser’s reading list.", savedAlready: "In your reading list", open: "Open reading list",
  status: "Reading state", later: "To read", reading: "Reading", finished: "Finished", all: "All states", allEditions: "All editions", chinese: "Chinese edition", english: "English edition",
  query: "Search this list", searchHint: "Title or author, on this device only", edition: "Edition", sort: "Sort list", recent: "Recently changed", savedSort: "Recently added", titleSort: "Title", progressSort: "Saved progress",
  empty: "Your list is empty. Add a work from its reading page.", noMatches: "No saved works match these filters.", reset: "Reset filters", browse: "Browse works",
  total: (visible: number, total: number) => `${visible} shown · ${total} saved on this browser`,
  stateChanged: "Reading state updated on this browser.", remove: "Remove", removeTitle: "Remove this work from your list?", removeHint: "Only this language edition and its saved position will be removed. Passage notes are not changed.", removed: "Work removed from this reading list.",
  clear: "Clear reading list", clearTitle: "Clear this browser’s reading list?", clearHint: "All editions, positions and unreadable reading-list records will be removed. Passage notes, theme and account data are not changed. Export a backup first if you need one.", cleared: "Reading list cleared.", cancel: "Cancel", confirmRemove: "Remove from this browser",
  invalid: (count: number) => `${count} reading-list records could not be read and have not been removed. A backup includes only readable records.`,
  progress: (percent: number) => `Saved position · ${Math.round(percent)}%`, noPosition: "No reading position saved", remember: "Remember my position on this browser", rememberHint: "Off by default. Only an explicitly saved work can record a position. Returning never scrolls automatically. Closing the tab can lose the last second of pending movement.",
  resume: "Continue from saved position", resetPosition: "Forget saved position", positionReset: "Saved position removed.", resumed: "Returned to your saved position.", changedText: "The work was updated. The same passage was found and your position restored.",
  missingPosition: "The saved passage is no longer in this edition. Start anywhere or forget this position; no approximate jump was made.", ambiguousPosition: "The saved passage appears more than once. Choose where to continue; no ambiguous jump was made.", fragment: "This link already points to a heading or shared passage. Use that location first; your saved position is unchanged.", interrupted: "Continue was cancelled because you moved elsewhere.", trackingOn: "Position memory enabled for this edition. Only deliberate reading movement will update it.", trackingOff: "Position memory stopped. The last saved position is kept until you remove it.",
  refreshMetadata: "Update saved title and author", metadataUpdated: "Saved work information updated.",
  entries: "Saved works", select: "Select edition", selectPage: "Select this page", clearSelection: "Clear selection", selected: (count: number) => `${count} editions selected, including other pages. Changing filters clears selection.`,
  bulkState: "State for selected editions", bulkApply: "Change selected states", bulkRemove: "Remove selected editions", bulkTitle: "Remove the selected editions?", bulkHint: (count: number) => `Remove ${count} selected language editions and their positions from this browser. Passage notes are unchanged.`, bulkDone: (count: number) => `${count} selected changes confirmed.`,
  previous: "Previous page", next: "Next page", pagination: "Reading-list pages", page: (current: number, total: number) => `Page ${current} of ${total}`, keyboard: "On a work link, use Up/Down or Home/End to move within this page.",
  transfer: "Backup and restore", export: "Download JSON backup", exported: "A local JSON backup was prepared. It contains public work labels and your saved positions, not passage notes or consent to track.", import: "Choose JSON backup", importHint: "At most 1 MiB and 200 editions. The file stays in this browser. Import never enables position memory.",
  importMode: "Existing editions", keep: "Keep my current entries", replace: "Replace matching entries from backup", preview: "Import preview", apply: "Apply this preview", discard: "Discard preview", stalePreview: "Your list changed after this preview. Review a fresh preview before importing.",
  previewCounts: (added: number, replaced: number, kept: number) => `${added} new · ${replaced} replaced · ${kept} kept`,
  imported: (count: number) => `${count} editions confirmed in local storage.`, partial: (count: number) => `${count} changes were confirmed before the operation stopped. Review the current list before retrying. Browser storage does not support a transaction across entries.`,
  exportFailed: "The browser could not prepare a download. Your list was not changed.", importReadFailed: "The file could not be read. Your list was not changed.",
};
const zh: typeof en = {
  title: "阅读清单", intro: "留在当前浏览器的一小架书。不需要账户，不同步，也不向网站发送阅读历史。",
  privacy: "共用浏览器也会共用清单。清除网站数据会移除它；更换设备前请先备份。",
  loading: "正在读取本机清单……", unavailable: "浏览器暂时无法使用本地存储，更改无法确认，以前的条目可能仍在。请检查浏览器设置后重试。",
  readOnly: "当前浏览器无法安全协调跨标签页写入，可以查看与导出已有条目，但不能更改清单。",
  retry: "重试本地存储", save: "加入阅读清单", saved: "已加入当前浏览器的阅读清单。", savedAlready: "已在阅读清单中", open: "打开阅读清单",
  status: "阅读状态", later: "待读", reading: "在读", finished: "读完", all: "全部状态", allEditions: "全部语言版本", chinese: "中文版本", english: "英文版本",
  query: "检索本机清单", searchHint: "作品名或作者，仅在本机检索", edition: "语言版本", sort: "清单排序", recent: "最近更改", savedSort: "最近加入", titleSort: "作品名称", progressSort: "已记住的进度",
  empty: "清单还是空的，可以从作品阅读页加入。", noMatches: "没有符合筛选条件的作品。", reset: "重置筛选", browse: "浏览作品",
  total: (visible, total) => `显示 ${visible} 部 · 本机共 ${total} 部`,
  stateChanged: "已更新本机阅读状态。", remove: "移除", removeTitle: "从清单移除这部作品？", removeHint: "只移除这个语言版本及其阅读位置，不影响划线笔记。", removed: "已从本机阅读清单移除。",
  clear: "清空阅读清单", clearTitle: "清空当前浏览器的阅读清单？", clearHint: "将移除全部语言版本、阅读位置及无法读取的清单记录，不影响划线、主题和账户数据。如需保留，请先导出备份。", cleared: "阅读清单已清空。", cancel: "取消", confirmRemove: "从本机移除",
  invalid: count => `${count} 条清单记录无法读取，尚未删除。导出备份只包含可读取的记录。`,
  progress: percent => `已记住的位置 · ${Math.round(percent)}%`, noPosition: "尚未记住阅读位置", remember: "在本机记住我的阅读位置", rememberHint: "默认关闭，只有主动加入清单的作品才能记住位置；再次打开时不会自动跳转，关闭标签页可能丢失最后一秒尚未确认的位置。",
  resume: "从上次位置续读", resetPosition: "忘记阅读位置", positionReset: "已移除记住的阅读位置。", resumed: "已回到上次阅读位置。", changedText: "作品已有更新，已找到相同文字并回到阅读位置。",
  missingPosition: "这个版本中已找不到上次阅读的段落。可以自行继续阅读或忘记位置，没有进行近似跳转。", ambiguousPosition: "上次阅读的文字出现了不止一次。请自行选择继续的位置，没有进行含糊跳转。", fragment: "当前链接已指向标题或共享段落，请先使用链接中的位置。原有阅读位置未变。", interrupted: "你已移向其他位置，本次续读已取消。", trackingOn: "已为此版本开启位置记忆，只有主动阅读时的移动才会更新。", trackingOff: "已停止记住新位置，最后的位置会保留，直到你主动移除。",
  refreshMetadata: "更新清单中的作品名与作者", metadataUpdated: "已更新清单中的作品信息。",
  entries: "已保存的作品", select: "选择语言版本", selectPage: "选择当前页", clearSelection: "取消选择", selected: count => `已选择 ${count} 个版本，可能包含其他页。更改筛选会取消选择。`,
  bulkState: "选中版本的目标状态", bulkApply: "批量更改状态", bulkRemove: "移除选中版本", bulkTitle: "移除选中的语言版本？", bulkHint: count => `将从当前浏览器移除 ${count} 个选中版本及其阅读位置，不影响划线笔记。`, bulkDone: count => `已确认 ${count} 项批量更改。`,
  previous: "上一页", next: "下一页", pagination: "阅读清单分页", page: (current, total) => `第 ${current} / ${total} 页`, keyboard: "聚焦作品链接后，可用上下方向键或 Home / End 在当前页移动。",
  transfer: "备份与恢复", export: "下载 JSON 备份", exported: "已准备本地 JSON 备份，包含公开作品信息与阅读位置，不含划线笔记，也不会携带记忆位置的许可。", import: "选择 JSON 备份", importHint: "文件不超过 1 MiB、200 个语言版本，仅在当前浏览器读取。导入不会开启位置记忆。",
  importMode: "遇到已有版本", keep: "保留本机现有记录", replace: "用备份替换同一版本", preview: "导入预览", apply: "应用此预览", discard: "取消预览", stalePreview: "预览之后清单已有变化，请重新检查预览再导入。",
  previewCounts: (added, replaced, kept) => `新增 ${added} 部 · 替换 ${replaced} 部 · 保留 ${kept} 部`,
  imported: count => `已在本机存储中确认 ${count} 部作品。`, partial: count => `操作停止前已确认 ${count} 项更改，请检查当前清单后再重试。浏览器存储不支持跨条目的事务。`,
  exportFailed: "浏览器未能准备下载，清单未改动。", importReadFailed: "未能读取文件，清单未改动。",
};

export function readingShelfCopy(locale: Locale) { return locale === "en" ? en : zh; }
export function shelfProblemText(code: ShelfProblem | ShelfBackupProblem, locale: Locale): string {
  const english = locale === "en";
  switch (code) {
    case "unavailable": return readingShelfCopy(locale).unavailable;
    case "unsupported": return readingShelfCopy(locale).readOnly;
    case "quota": return english ? "Local storage is full or refused this write. Nothing unconfirmed is reported as saved; export or remove entries and retry." : "本地存储已满或拒绝了写入。不会把未确认的内容说成已保存，请先备份或移除条目后重试。";
    case "changed": return english ? "Another tab or action changed this entry. Review the current list and retry." : "其他标签页或操作已更改这条记录，请检查当前清单后重试。";
    case "corrupt": return english ? "An unreadable record occupies this edition. It was not overwritten. Export readable entries before explicitly clearing the list." : "这个版本已有无法读取的记录，未覆盖它。请先备份可读条目，再决定是否清空清单。";
    case "missing": return english ? "This edition was removed from the list. No position or state was written." : "这个版本已从清单移除，没有再写入位置或状态。";
    case "limit": return english ? "The list holds at most 200 editions. Existing or unreadable entries will not be discarded to make room." : "清单最多保留 200 个语言版本，不会自动丢弃已有或无法读取的条目来腾出位置。";
    case "size": return english ? "The backup exceeds 1 MiB. No entries were imported." : "备份超过 1 MiB，没有导入任何条目。";
    case "syntax": return english ? "This is not a readable JSON backup. Your list is unchanged." : "这不是可读取的 JSON 备份，清单未改动。";
    case "version": return english ? "This backup format or version is not supported. Your list is unchanged." : "不支持这个备份格式或版本，清单未改动。";
    case "duplicate": return english ? "The backup repeats a language edition. Resolve the duplicate before importing." : "备份中重复出现了同一语言版本，请解决重复后再导入。";
    default: return english ? "A backup entry is invalid. No approximate or unsafe entry was accepted." : "备份条目不完整或无效，没有猜测补齐或接受不安全的记录。";
  }
}
