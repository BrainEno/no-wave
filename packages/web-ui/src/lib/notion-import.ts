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

import { isRecord } from "@no-wave/web-http";

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
  planToken?: string;
  planExpiresAt?: string;
  database: { id: string; title: string | null };
  summary: Record<NotionImportAction, number>;
  pages: NotionImportPage[];
};

export type BundleFileResult =
  | { ok: true; bundle: Record<string, unknown>; pages: number }
  | { ok: false; message: string };

const ACTIONS: readonly NotionImportAction[] = ["create", "update", "skip", "refused", "failed"];

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
    ...(typeof value.planToken === "string" && value.planToken.length > 0 && value.planToken.length <= 512 * 1024 ? { planToken: value.planToken } : {}),
    ...(typeof value.planExpiresAt === "string" ? { planExpiresAt: value.planExpiresAt } : {}),
    database: {
      id: typeof database.id === "string" ? database.id : "",
      title: typeof database.title === "string" ? database.title : null,
    },
    summary,
    pages,
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
      headline: attention > 0
        ? `${writable > 0 ? "部分导入" : "未写入"}：${counts}。请检查报告后重新试跑。`
        : `已导入：${counts}。`,
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
    canApply: writable > 0 && typeof report.planToken === "string" && report.planToken.length > 0,
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

/** Explain conservative source-identity refusals without exposing private IDs. */
export function importDetail(detail: string): string {
  // `unsupported-block` names a sub-page or inline database by title: its body
  // is another Notion document and is deliberately not read into this work.
  const nested = /^(child_page|child_database)(?:: (.+))?$/su.exec(detail);
  if (nested !== null) {
    const what = nested[1] === "child_page" ? "子页面" : "数据库";
    const name = nested[2] === undefined ? what : `${what}「${nested[2]}」`;
    return `${name}未导入：它是独立的 Notion ${nested[1] === "child_page" ? "页面" : "数据库"}，正文不会并入本作品；如需发布请单独导入。`;
  }
  if (detail.startsWith("This Notion page is already owned by another account.")) {
    return "该 Notion 页面已由其他账号导入，不能跨语言重新认领。本作品的文章、标签和来源链接均未写入。" +
      (detail.includes("media library") ? "已准备的图片可能留在媒体库，请检查并删除未使用的图片。" : "");
  }
  if (detail.startsWith("The Notion page is already linked to another work or account.")) {
    return "该页面已关联到其他作品或账号，本作品的文章、标签和来源链接均未写入，请检查来源后重新试跑。" +
      (detail.includes("media library") ? "已准备的图片可能留在媒体库，请检查并删除未使用的图片。" : "");
  }
  if (detail.startsWith("The work or its import provenance changed.")) {
    return "作品或导入来源在试跑后已变化，本作品的文章、标签和来源链接均未写入，请重新试跑。" +
      (detail.includes("media library") ? "已准备的图片可能留在媒体库，请检查并删除未使用的图片。" : "");
  }
  if (detail.startsWith("This work could not be imported.")) {
    return "本作品导入失败，文章、标签和来源链接已全部回滚，请重新试跑。" +
      (detail.includes("media library") ? "已准备的图片可能留在媒体库，请检查并删除未使用的图片。" : "");
  }
  const messages: Record<string, string> = {
    "translation relation requires review before import": "翻译关联需要核对，暂不导入。",
    "Select all pages referenced by English before importing this work": "请选择 English 关联的所有页面后重新试跑。",
    "More than two pages are linked as translations; resolve the relation before importing": "有超过两页互相关联为译文，请先在 Notion 中核对关系。",
    "Parent/sub-item relations are not imported as translations": "父子层级关系不会导入；页面不会被当作译文合并。",
    "this page already has import provenance in another locale; review the original work and select the matching pages": "该页面此前已作为其他语言导入，请检查原作品并选择对应页面。",
    "this page is already imported into another account": "该页面已由其他账号导入，无法再次认领。",
    "the selected pages have conflicting import provenance; review the original works before importing": "所选页面已有的导入来源不一致，请先检查原作品。",
  };
  return messages[detail] ?? detail;
}

/**
 * Bundle page ids and report `externalId`s name the same page, but the API
 * normalises the id it reports; compare them with dashes and case removed.
 */
export function pageKey(id: string): string {
  return id.replaceAll("-", "").toLowerCase();
}

/** The id of each bundle page, by index ("" for a page without one). */
export function bundlePageIds(bundle: Record<string, unknown>): string[] {
  if (!Array.isArray(bundle.pages)) return [];
  return bundle.pages.map((page: unknown) => isRecord(page) && typeof page.id === "string" ? page.id : "");
}

/** What a report row can be filtered by, after a dry run. */
export type ReportFilter = "all" | "changes" | "attention";

/**
 * "changes" is what confirming would write (create, update); "attention" is a
 * row the author must read before confirming: refused, failed, or carrying an
 * issue code (something that will not come across as it was in Notion).
 */
export function reportRowMatches(page: NotionImportPage, filter: ReportFilter): boolean {
  if (filter === "changes") return page.action === "create" || page.action === "update";
  if (filter === "attention") return page.action === "refused" || page.action === "failed" || page.issues.length > 0;
  return true;
}

/**
 * The bundle indices whose report row has one of `actions`. A report row is
 * only ever used to *choose* among bundle pages; the selection stays a set of
 * bundle indices, so what is sent is always exactly the author's source pages.
 */
export function indicesWithActions(bundle: Record<string, unknown>, report: NotionImportReport, actions: readonly NotionImportAction[]): Set<number> {
  const wanted = new Set(report.pages.filter((page) => actions.includes(page.action)).map((page) => pageKey(page.externalId)));
  const indices = new Set<number>();
  bundlePageIds(bundle).forEach((id, index) => { if (id && wanted.has(pageKey(id))) indices.add(index); });
  return indices;
}

/** The selected indices after toggling every one of `visible`. */
export function invertSelection(selected: ReadonlySet<number>, visible: readonly number[]): Set<number> {
  const next = new Set(selected);
  for (const index of visible) if (next.has(index)) next.delete(index); else next.add(index);
  return next;
}

const csvCell = (value: string) => /[",\r\n]/.test(value) || /^[=+\-@\t]/.test(value)
  // A leading = + - @ would be run as a formula by a spreadsheet; the apostrophe
  // keeps a title like "=SUM(…)" a title.
  ? `"${(/^[=+\-@\t]/.test(value) ? `'${value}` : value).replaceAll('"', '""')}"`
  : value;

/**
 * The report as a CSV an author can keep or open in a spreadsheet: one row per
 * page, with the same facts the page shows. A BOM makes Excel read it as UTF-8.
 */
export function reportCsv(report: NotionImportReport): string {
  const header = ["action", "title", "locale", "slug", "articleId", "issues", "detail"];
  const rows = report.pages.map((page) => [
    page.action, page.title || page.externalId, page.locale, page.slug, page.articleId ?? "",
    page.issues.map((issue) => issue.code).join(" "),
    [page.detail, ...page.issues.map((issue) => issue.detail)].filter(Boolean).map(importDetail).join(" | "),
  ]);
  return "\uFEFF" + [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** Distinct Notion-hosted images the API copies per request (`imports.ts`: `attempted >= 8`). */
export const NOTION_IMPORT_MAX_IMAGES = 8;

export type ImportBatchLimits = { bytes: number; pages: number; images: number };
export const IMPORT_BATCH_LIMITS: ImportBatchLimits = Object.freeze({ bytes: NOTION_BUNDLE_MAX_BYTES, pages: NOTION_BUNDLE_MAX_PAGES, images: NOTION_IMPORT_MAX_IMAGES });

export type ImportBatchPlan = {
  /** Bundle indices per request, each in source order; the batches in source order. */
  batches: number[][];
  /** Indices that cannot be sent at all (one work larger than a request may be). */
  tooLarge: number[];
  /** Sentences the page shows: why a batch is shaped the way it is. */
  notes: string[];
};

const utf8 = new TextEncoder();

/** The Notion-hosted image URLs in a page's blocks (nested children included). */
function notionImages(page: unknown): string[] {
  const urls: string[] = [];
  const walk = (blocks: unknown) => {
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (!isRecord(block)) continue;
      const image = block.type === "image" && isRecord(block.image) ? block.image : null;
      if (image && image.type === "file" && isRecord(image.file) && typeof image.file.url === "string") urls.push(image.file.url);
      walk(block.children);
      if (typeof block.type === "string" && isRecord(block[block.type])) walk((block[block.type] as Record<string, unknown>).children);
    }
  };
  if (isRecord(page)) walk(page.blocks);
  return urls;
}

/** The page ids a page's `English` relation names — the API's translation link (`notion-bundle.ts`). */
export function englishRelationIds(page: unknown): string[] {
  if (!isRecord(page) || !isRecord(page.properties)) return [];
  const relation = (page.properties as Record<string, unknown>).English;
  if (!isRecord(relation) || !Array.isArray(relation.relation)) return [];
  return relation.relation.flatMap((link: unknown) => isRecord(link) && typeof link.id === "string" ? [link.id] : []);
}

/**
 * Split the selected pages into requests the API will accept, without changing
 * what any one request means.
 *
 * Each request stays under the same ceilings a single import has always had —
 * the serialised `{ bundle, apply }` under 8 MiB, at most 200 pages, at most 8
 * distinct Notion-hosted images (beyond that the API stops copying and the page
 * fails) — and **pages linked by `English` always travel together**: the API
 * checks a translation pair within one bundle, so splitting a pair would turn
 * a valid work into a `missing-translation-page` refusal. Packing is next-fit
 * in source order, so the batches are predictable and a re-run of the same
 * selection yields the same batches (and so the same plans).
 *
 * A work that alone exceeds the byte or page ceiling cannot be sent and is
 * returned in `tooLarge` — reported, never silently dropped. A work with more
 * than 8 images is sent on its own, with a note that some images will fail.
 */
export function planImportBatches(bundle: Record<string, unknown>, selection: ReadonlySet<number>, limits: ImportBatchLimits = IMPORT_BATCH_LIMITS): ImportBatchPlan {
  const pages: unknown[] = Array.isArray(bundle.pages) ? bundle.pages : [];
  const chosen = [...selection].filter((index) => index >= 0 && index < pages.length).sort((a, b) => a - b);
  // Union-find over the selected pages, joined by English relations either way.
  const parent = new Map<number, number>(chosen.map((index) => [index, index]));
  const find = (index: number): number => { let root = index; while (parent.get(root) !== root) root = parent.get(root)!; parent.set(index, root); return root; };
  const byKey = new Map<string, number>();
  for (const index of chosen) { const page = pages[index]; if (isRecord(page) && typeof page.id === "string") byKey.set(pageKey(page.id), index); }
  for (const index of chosen) for (const id of englishRelationIds(pages[index])) {
    const other = byKey.get(pageKey(id));
    if (other !== undefined) { const a = find(index), b = find(other); if (a !== b) parent.set(Math.max(a, b), Math.min(a, b)); }
  }
  const groups = new Map<number, number[]>();
  for (const index of chosen) { const root = find(index); groups.set(root, [...(groups.get(root) ?? []), index]); }

  const shell = utf8.encode(JSON.stringify({ bundle: { ...bundle, pages: [] }, apply: true })).length;
  const sizeOf = (index: number) => utf8.encode(JSON.stringify(pages[index] ?? null)).length;
  const batches: number[][] = []; const tooLarge: number[] = []; const notes: string[] = [];
  // The shell holds the brackets; each page adds its JSON and one comma, and
  // the first page's comma is not written — hence the starting `shell - 1`.
  const empty = shell - 1;
  let current: number[] = []; let bytes = empty; let images = new Set<string>();
  const close = () => { if (current.length) batches.push(current); current = []; bytes = empty; images = new Set(); };
  for (const group of [...groups.values()].sort((a, b) => a[0]! - b[0]!)) {
    const groupBytes = group.reduce((sum, index) => sum + sizeOf(index) + 1, 0);
    const groupImages = new Set(group.flatMap((index) => notionImages(pages[index])));
    if (empty + groupBytes > limits.bytes || group.length > limits.pages) { tooLarge.push(...group); continue; }
    const merged = new Set([...images, ...groupImages]);
    if (current.length && (bytes + groupBytes > limits.bytes || current.length + group.length > limits.pages || merged.size > limits.images)) close();
    if (groupImages.size > limits.images) {
      close();
      notes.push(`有一件作品含 ${groupImages.size} 张 Notion 图片，超过单次复制 ${limits.images} 张的上限，已单独成批；超出的图片会在报告中标为失败，可之后重新导入补齐。`);
      batches.push(group);
      continue;
    }
    current.push(...group); bytes += groupBytes; for (const url of groupImages) images.add(url);
  }
  close();
  for (const batch of batches) batch.sort((a, b) => a - b);
  return { batches, tooLarge, notes };
}

/**
 * Several batch reports read as one: pages in batch order, summaries summed.
 * `applied` is true only when every batch was applied; the plan tokens stay
 * with their batches and are deliberately not merged.
 */
export function mergeReports(reports: readonly NotionImportReport[]): NotionImportReport | null {
  if (!reports.length) return null;
  const summary: Record<NotionImportAction, number> = { create: 0, update: 0, skip: 0, refused: 0, failed: 0 };
  for (const report of reports) for (const action of ACTIONS) summary[action] += report.summary[action];
  return {
    applied: reports.every((report) => report.applied),
    database: reports[0]!.database,
    summary,
    pages: reports.flatMap((report) => report.pages),
  };
}

/** For one bundle page: the pages its `English` relation names, in the bundle or not. */
export type EnglishPartners = { inBundle: number[]; missing: string[] };

/**
 * Every page's English counterparts, by bundle index. A counterpart in the
 * bundle can be selected along with its page; one that is not in the bundle
 * cannot, and the API will refuse the work (`missing-translation-page`) until
 * the export includes it.
 */
export function englishPartners(bundle: Record<string, unknown>): Map<number, EnglishPartners> {
  const pages: unknown[] = Array.isArray(bundle.pages) ? bundle.pages : [];
  const byKey = new Map<string, number>();
  pages.forEach((page, index) => { if (isRecord(page) && typeof page.id === "string") byKey.set(pageKey(page.id), index); });
  const result = new Map<number, EnglishPartners>();
  pages.forEach((page, index) => {
    const ids = englishRelationIds(page).filter((id) => byKey.get(pageKey(id)) !== index);
    if (!ids.length) return;
    result.set(index, {
      inBundle: ids.flatMap((id) => byKey.has(pageKey(id)) ? [byKey.get(pageKey(id))!] : []),
      missing: ids.filter((id) => !byKey.has(pageKey(id))),
    });
  });
  return result;
}

/**
 * The selection after a change, with the English counterparts of every newly
 * selected page added (transitively). Only *additions* pull partners in: a
 * counterpart the author unchecks on purpose stays unchecked — the row says
 * what that means, and the API's refusal stays the authority.
 */
export function withEnglishPartners(previous: ReadonlySet<number>, next: ReadonlySet<number>, partners: ReadonlyMap<number, EnglishPartners>): { selection: Set<number>; added: number[] } {
  const selection = new Set(next); const added: number[] = [];
  const queue = [...next].filter((index) => !previous.has(index));
  while (queue.length) {
    const index = queue.shift()!;
    for (const partner of partners.get(index)?.inBundle ?? []) {
      if (selection.has(partner)) continue;
      selection.add(partner); added.push(partner); queue.push(partner);
    }
  }
  return { selection, added };
}
