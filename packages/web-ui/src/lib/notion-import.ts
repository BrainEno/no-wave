/**
 * The authoring desk's side of a Notion import (ADR 0036, phase 4).
 *
 * Two things live here, and both are decisions rather than markup:
 *
 *  - **What makes a chosen file obviously not a bundle.** The API's
 *    `parseNotionBundle` is the authority on what a bundle *is*, and its message
 *    is what an author sees when the shape is wrong in a way only the server can
 *    judge. But a file that is not JSON, or that is a saved API response, is worth
 *    saying before a megabyte travels: the browser checks exactly the things that
 *    make the answer certain, and nothing that would need a second implementation
 *    of the mapping to be sure about.
 *  - **What the report means.** The endpoint answers with per-page actions and a
 *    summary; "would this write anything?" and "which pages need my eyes?" are
 *    questions about that answer, not about React, so they are answered here and
 *    tested without a browser.
 */

/** The ceiling the API enforces on one import body (`MAX_NOTION_IMPORT_BYTES`). */
export const NOTION_BUNDLE_MAX_BYTES = 8 * 1024 * 1024;

/** The ceiling the API enforces on one bundle's pages (`MAX_IMPORT_PAGES`). */
export const NOTION_BUNDLE_MAX_PAGES = 200;

export type NotionImportAction = "create" | "update" | "skip" | "refused" | "failed";

export type NotionImportIssue = { code: string; detail: string };

/** One line of the API's per-page report. */
export type NotionImportPage = {
  externalId: string;
  title: string;
  locale: string;
  action: NotionImportAction;
  slug: string;
  articleId: string | null;
  detail: string;
  issues: NotionImportIssue[];
};

export type NotionImportReport = {
  applied: boolean;
  database: { id: string; title: string | null };
  summary: Record<NotionImportAction, number>;
  pages: NotionImportPage[];
  planToken?: string;
};

export type BundleFileResult =
  | { ok: true; bundle: Record<string, unknown>; pages: number }
  | { ok: false; message: string };

const ACTIONS: readonly NotionImportAction[] = ["create", "update", "skip", "refused", "failed"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Read the chosen file, and refuse it only when the answer is certain.
 *
 * `byteLength` is the browser's own count, checked before the text is even parsed:
 * a 40 MB export is not a bundle this API will accept, and reading it to find that
 * out costs the browser more than the request would.
 */
export function readBundleFile(input: { text: string; byteLength: number }): BundleFileResult {
  if (input.byteLength > NOTION_BUNDLE_MAX_BYTES) {
    return {
      ok: false,
      message: `这个文件有 ${megabytes(input.byteLength)}，超过一次导入的 8 MB 上限。请在 Notion 里分批导出，再逐个导入。`,
    };
  }

  let parsed: unknown;
  try {
    // A byte-order mark is legal in a file Notion or an editor wrote, and
    // `JSON.parse` refuses it — the one difference worth papering over here.
    parsed = JSON.parse(input.text.replace(/^\uFEFF/, ""));
  } catch {
    return { ok: false, message: "这个文件不是有效的 JSON。" };
  }

  if (!isRecord(parsed)) {
    return { ok: false, message: "bundle 必须是一个 JSON 对象。" };
  }

  // A very easy mistake: saving the endpoint's answer instead of its `bundle`.
  // It parses, it is an object, and it is not a bundle — so say which one it is.
  if (isRecord(parsed.data) && isRecord((parsed.data as Record<string, unknown>).bundle)) {
    return { ok: false, message: "这是导入接口的响应；请选择响应里的 `data.bundle`。" };
  }

  if (parsed.version !== 1) {
    return { ok: false, message: 'bundle 缺少 `"version": 1`。' };
  }
  const pages = parsed.pages;
  if (!Array.isArray(pages)) {
    return { ok: false, message: "bundle 缺少 `pages` 数组。" };
  }
  if (pages.length > NOTION_BUNDLE_MAX_PAGES) {
    return {
      ok: false,
      message: `一次导入最多 ${NOTION_BUNDLE_MAX_PAGES} 页，这个 bundle 有 ${pages.length} 页。请在 Notion 里分批导出。`,
    };
  }
  // An empty `pages` array is *not* refused: the API answers it with an empty
  // report, which is a true statement ("there is nothing here") and one the page
  // can show. Refusing it locally would be this file inventing a rule.
  for (const [index, page] of pages.entries()) {
    if (!isRecord(page)) return { ok: false, message: `pages[${index}] 不是对象。` };
    if (typeof page.id !== "string" || page.id.length === 0) {
      return { ok: false, message: `pages[${index}] 缺少页面 id。` };
    }
    if (!isRecord(page.properties)) return { ok: false, message: `pages[${index}] 缺少 properties 对象。` };
    if (!Array.isArray(page.blocks)) return { ok: false, message: `pages[${index}] 缺少 blocks 数组。` };
  }

  return { ok: true, bundle: parsed, pages: pages.length };
}

function pageOf(value: unknown): NotionImportPage | null {
  if (!isRecord(value)) return null;
  // The id is how the report refers to a page at all — the document, the slug and
  // the link row are all addressed by it — so a page without one cannot be shown
  // as anything but a row that says nothing.
  if (typeof value.externalId !== "string" || value.externalId.length === 0) return null;
  const action = value.action;
  if (typeof action !== "string" || !ACTIONS.includes(action as NotionImportAction)) return null;
  const issues = Array.isArray(value.issues)
    ? value.issues.filter((issue): issue is NotionImportIssue =>
      isRecord(issue) && typeof issue.code === "string" && typeof issue.detail === "string")
    : [];
  return {
    externalId: value.externalId,
    title: typeof value.title === "string" ? value.title : "",
    locale: typeof value.locale === "string" ? value.locale : "",
    action: action as NotionImportAction,
    slug: typeof value.slug === "string" ? value.slug : "",
    articleId: typeof value.articleId === "string" ? value.articleId : null,
    detail: typeof value.detail === "string" ? value.detail : "",
    issues,
  };
}

/**
 * The API's report, or `null` when this is not one.
 *
 * The page list is filtered to what can be shown — a page whose `action` is not
 * one the contract names is dropped rather than rendered as a blank row — while
 * the summary is recomputed from the surviving pages. That keeps the two halves
 * of the page telling the same story even if a deployment is a release behind.
 */
export function asImportReport(value: unknown): NotionImportReport | null {
  if (!isRecord(value) || typeof value.applied !== "boolean" || !Array.isArray(value.pages)) return null;
  const pages = value.pages.map(pageOf).filter((page): page is NotionImportPage => page !== null);
  const counted = countActions(pages);
  const declared = isRecord(value.summary) ? value.summary : {};
  const summary: Record<NotionImportAction, number> = { create: 0, update: 0, skip: 0, refused: 0, failed: 0 };
  for (const action of ACTIONS) {
    const fromApi = declared[action];
    // The API's count is the truth when it is a count; the pages are the fallback
    // so an older or trimmed response still renders.
    summary[action] = typeof fromApi === "number" && Number.isFinite(fromApi) ? fromApi : counted[action];
  }
  const database = isRecord(value.database) ? value.database : {};
  return {
    applied: value.applied,
    database: {
      id: typeof database.id === "string" ? database.id : "",
      title: typeof database.title === "string" ? database.title : null,
    },
    summary,
    pages,
    ...(typeof value.planToken === "string" ? { planToken: value.planToken } : {}),
  };
}

function countActions(pages: readonly NotionImportPage[]): Record<NotionImportAction, number> {
  const counts: Record<NotionImportAction, number> = { create: 0, update: 0, skip: 0, refused: 0, failed: 0 };
  for (const page of pages) counts[page.action] += 1;
  return counts;
}

export const ACTION_LABEL: Readonly<Record<NotionImportAction, string>> = Object.freeze({
  create: "新建",
  update: "更新",
  skip: "跳过",
  refused: "拒绝",
  failed: "失败",
});

/** What one plan means, in the words the page needs and the decisions it makes. */
export type ImportOutcome = {
  applied: boolean;
  /** `create` + `update`: what pressing "confirm" would write. */
  writable: number;
  /** Pages that need the author's eyes: refused, or failed to write. */
  attention: number;
  /** One sentence stating exactly what happened, or what would. */
  headline: string;
  /** Only a plan that would write something can be applied. */
  canApply: boolean;
};

/**
 * Read the report as an outcome.
 *
 * A dry run that would write nothing is *not* a failure — it is the answer "there
 * is nothing new here", which is what a second import of an unchanged database
 * gets — so the confirm button stays out of the way instead of offering a write
 * the server has already said is unnecessary.
 */
export function describeImport(report: NotionImportReport): ImportOutcome {
  const { create, update, skip, refused, failed } = report.summary;
  const writable = create + update;
  const attention = refused + failed;
  const counts = `新建 ${create} 件、更新 ${update} 件、跳过 ${skip} 页` +
    (refused > 0 ? `、拒绝 ${refused} 页` : "") +
    (failed > 0 ? `、失败 ${failed} 页` : "");
  if (report.applied) {
    return {
      applied: true,
      writable,
      attention,
      headline: `已导入：${counts}。`,
      // Applying again is a second write of the same bundle, which the server
      // would answer with `skip`; the button is not offered twice.
      canApply: false,
    };
  }
  return {
    applied: false,
    writable,
    attention,
    headline: writable > 0
      ? `计划：${counts}。确认之前不会写入任何内容。`
      : `计划：${counts}。这次没有任何需要写入的内容。`,
    canApply: writable > 0,
  };
}

/**
 * Every issue code in the report, counted.
 *
 * The report is per page, and what an author wants to know before handing over a
 * manuscript is which *kinds* of thing were dropped and how often — the same
 * grouping the mapping's codes exist for. Sorted by count, then by code, so two
 * renders of the same report read the same way.
 */
export function issueCounts(report: NotionImportReport): { code: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const page of report.pages) {
    for (const issue of page.issues) counts.set(issue.code, (counts.get(issue.code) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code));
}

/** The selectable source pages are identified by their position, not a report ID:
 * the API scopes filename-based Markdown IDs to the authenticated owner and may
 * omit an invalid translation from the report. Never select from report rows. */
export function bundleSelectionPages(bundle: Record<string, unknown>): { index: number; title: string; preview: string }[] {
  if (!Array.isArray(bundle.pages)) return [];
  return bundle.pages.map((page: unknown, index: number) => {
    if (!isRecord(page)) return { index, title: `第 ${index + 1} 页`, preview: "" };
    const properties = isRecord(page.properties) ? Object.values(page.properties) : [];
    const titleProperty = properties.find((property) => isRecord(property) && property.type === "title");
    const text = (value: unknown): string => Array.isArray(value) ? value.map((part: unknown) =>
      isRecord(part) && typeof part.plain_text === "string" ? part.plain_text : "").join("") : "";
    const title = isRecord(titleProperty) ? text(titleProperty.title).trim() : "";
    const previews: string[] = [];
    if (Array.isArray(page.blocks)) for (const block of page.blocks as unknown[]) {
      if (!isRecord(block) || typeof block.type !== "string" || !isRecord(block[block.type])) continue;
      const body = block[block.type] as Record<string, unknown>;
      const bodyText = text(body.rich_text);
      if (bodyText.trim()) previews.push(bodyText);
      if (previews.join("\n").length >= 500) break;
    }
    const full = previews.join("\n");
    return { index, title: title || `第 ${index + 1} 页`, preview: full.length > 500 ? `${full.slice(0, 500)}…` : full };
  });
}

/** Return exactly the selected source pages, preserving the original order. */
export function selectBundlePages(bundle: Record<string, unknown>, indices: ReadonlySet<number>): Record<string, unknown> {
  if (!Array.isArray(bundle.pages)) throw new Error("bundle 缺少 pages 数组。");
  return { ...bundle, pages: bundle.pages.filter((_page: unknown, index: number) => indices.has(index)) };
}
