import { Link } from "@/lib/framework/link.tsx";
import { useEffect, useRef, useState } from "react";
import { markdownEntriesToBundle, readMarkdownZip } from "@/lib/notion-markdown.ts";
import {
  ACTION_LABEL,
  asImportReport,
  bundleSelectionPages,
  selectBundlePages,
  describeImport,
  issueCounts,
  importDetail,
  readBundleFile,
  englishPartners,
  indicesWithActions,
  invertSelection,
  withEnglishPartners,
  mergeReports,
  planImportBatches,
  reportCsv,
  reportRowMatches,
  type NotionImportReport,
  type ReportFilter,
} from "@/lib/notion-import.ts";
import {
  NOTION_PULL_ISSUE_TEXT,
  NOTION_PULL_MAX_ROWS,
  isRetryableNotionIssue,
  looksLikeNotionToken,
  proxyFetchPost,
  pullNotionPages,
  pullNotionRows,
  withPulledBlocks,
} from "@/lib/notion-fetch.ts";

/** Pick source pages first, then preview and apply precisely that selection. */

const MAX_MEGABYTES = 8;

/** The API's answers that have a sentence of their own; the rest are its message. */
function failureMessage(payload: unknown, status: number): string {
  const message = typeof payload === "object" && payload !== null
    ? (payload as { error?: { message?: unknown } }).error?.message
    : undefined;
  const code = typeof payload === "object" && payload !== null ? (payload as { error?: { code?: unknown } }).error?.code : null;
  if (code === "IMPORT_PLAN_INVALID") return "试跑计划已失效或与当前选择不符，没有执行本次写入。请重新试跑后确认。";
  if (status === 401) return "登录状态已失效，请重新登录后再导入。";
  if (status === 413) return `文件超过 ${MAX_MEGABYTES} MB 的上限，请在 Notion 里分批导出。`;
  if (status === 415) return "这个请求必须是 JSON。";
  // Anything else is the API's own refusal — a bundle it cannot map, a limit it
  // enforces — and its sentence names the page and the field. Replacing it with
  // "导入失败" would throw away the only part the author can act on.
  return typeof message === "string" ? message : `导入没有完成（HTTP ${status}）。`;
}

const FILTERS: readonly { id: ReportFilter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "changes", label: "新增/有变化" },
  { id: "attention", label: "需要确认" },
];

/** Download the report as a file the author keeps; nothing leaves the browser. */
function downloadReport(report: NotionImportReport): void {
  const url = URL.createObjectURL(new Blob([reportCsv(report)], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `notion-import-${report.applied ? "result" : "plan"}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoke on the next task: some browsers start the download asynchronously.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

type Target = { title: string; slug: string };

/**
 * One request's worth of the selection. A batch keeps its own plan token: a
 * token binds exactly the bundle it was issued for, so tokens are never merged.
 */
type Batch = {
  indices: number[];
  bundle: Record<string, unknown>;
  /** The latest plan or result for this batch. */
  report: NotionImportReport | null;
  /** Why this batch did not plan or write, in the author's words. */
  error: string;
  /** The plan was re-run once after the server refused its token; it needs a fresh confirm. */
  replanned: boolean;
};

type PostResult =
  | { ok: true; report: NotionImportReport }
  | { ok: false; status: number; code: string | null; message: string };

/** 429s waited out per request before giving up; each wait is the server's own Retry-After. */
const MAX_RATE_LIMIT_WAITS = 6;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A connected Notion database (ADR 0052). Rows are listed up front; a page's
 * blocks are read the first time it is part of a dry run, so pages the author
 * deselects are never read. The token lives here, in the page's memory, for as
 * long as this pull is on screen; it is not stored anywhere and leaves with the page.
 */
type PullSession = {
  token: string;
  /** Page ids whose blocks are in the bundle. */
  read: Set<string>;
  /** Page ids Notion will not give us however often we ask, with the reason. */
  unreadable: Map<string, string>;
};

function dataOf(payload: unknown): unknown {
  return typeof payload === "object" && payload !== null ? (payload as { data?: unknown }).data : null;
}

export function NotionImport() {
  const [fileName, setFileName] = useState("");
  const [bundle, setBundle] = useState<Record<string, unknown> | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const [progress, setProgress] = useState("");
  const [notes, setNotes] = useState<string[]>([]);
  const [autoNote, setAutoNote] = useState("");
  const [busy, setBusy] = useState<null | "pull" | "dry-run" | "apply">(null);
  // The direct pull is the default: it is the shortest way from a Notion database
  // to a plan. The file upload stays one click away and is chosen by itself as
  // soon as a file is picked.
  const [tab, setTab] = useState<"notion" | "file">("notion");
  const [token, setToken] = useState("");
  const [source, setSource] = useState("");
  const [pulling, setPulling] = useState(false);
  const pull = useRef<PullSession | null>(null);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ReportFilter>("all");
  // articleId → the work an `update` row would overwrite, read from the desk's
  // own list so the author sees *which* work changes, not only an id.
  const [targets, setTargets] = useState<ReadonlyMap<string, Target>>(new Map());
  const fileInput = useRef<HTMLInputElement>(null);
  // Set by "停止" (and on unmount): the batch in flight finishes, no further
  // request is sent, and a countdown ends without retrying.
  const stopped = useRef(false);
  useEffect(() => () => { stopped.current = true; }, []);

  const planned = batches?.filter((batch) => batch.report !== null) ?? [];
  const report = mergeReports(planned.map((batch) => batch.report!));

  const updateIds = report === null ? "" : report.pages.filter((page) => page.action === "update" && page.articleId !== null).map((page) => page.articleId).join(",");
  useEffect(() => {
    if (updateIds === "" || updateIds.split(",").every((id) => targets.has(id))) return;
    let live = true;
    void fetch("/api/authoring/articles?allLocales=true", { credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" } })
      .then((response) => response.ok ? response.json() : null)
      .then((payload: unknown) => {
        const items = dataOf(payload);
        if (!live || !Array.isArray(items)) return;
        const next = new Map(targets);
        for (const item of items as { id?: unknown; title?: unknown; slug?: unknown }[]) {
          if (typeof item.id === "string" && typeof item.title === "string") next.set(item.id, { title: item.title, slug: typeof item.slug === "string" ? item.slug : "" });
        }
        setTargets(next);
      })
      // Only a label is lost: the row still shows the slug the report gave.
      .catch(() => undefined);
    return () => { live = false; };
  }, [updateIds, targets]);

  /**
   * One request to the import endpoint. A 429 is waited out — the countdown is
   * the server's Retry-After — and the same request is sent again, so a long
   * import continues by itself instead of asking the author to come back.
   */
  async function post(body: Record<string, unknown>, label: string): Promise<PostResult> {
    for (let waits = 0; ; waits++) {
      let response: Response;
      try {
        response = await fetch("/api/authoring/notion-import", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          credentials: "same-origin",
          cache: "no-store",
          body: JSON.stringify(body),
        });
      } catch {
        return { ok: false, status: 0, code: null, message: "网络中断，无法确认导入结果。部分内容可能已写入；请检查写作台，再重新试跑。" };
      }
      const payload: unknown = await response.json().catch(() => null);
      if (response.status === 429 && waits < MAX_RATE_LIMIT_WAITS) {
        const header = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
        const seconds = Math.min(Math.max(Number.isFinite(header) ? header : 30, 1), 900);
        for (let left = seconds; left > 0; left--) {
          if (stopped.current) return { ok: false, status: 429, code: null, message: "已停止，这一批没有提交。" };
          setProgress(`导入请求过于频繁（每 10 分钟有次数上限）。${label}将在 ${left} 秒后自动继续…`);
          await sleep(1000);
        }
        continue;
      }
      const code = typeof payload === "object" && payload !== null ? (payload as { error?: { code?: unknown } }).error?.code : null;
      if (!response.ok) return { ok: false, status: response.status, code: typeof code === "string" ? code : null, message: failureMessage(payload, response.status) };
      const parsed = asImportReport(dataOf(payload));
      // Never pretend a report was shown: "nothing is known" is the only safe reading.
      if (parsed === null) return { ok: false, status: response.status, code: null, message: "导入接口的响应格式不符合约定，无法确认结果；部分内容可能已写入，请检查写作台后重新试跑。" };
      return { ok: true, report: parsed };
    }
  }

  /**
   * Dry-run the selection, split into requests the API accepts. Every batch is
   * planned before anything can be confirmed, so the author reads one merged
   * plan and confirms once; a batch that fails to plan is named, and the others
   * remain confirmable.
   */
  async function plan(requested: ReadonlySet<number>): Promise<void> {
    if (bundle === null) return;
    stopped.current = false;
    setError(""); setFilter("all");
    const read = await readPulledPages(bundle, requested);
    if (read === null) return;
    const { bundle: current, selection, notes: pullNotes } = read;
    const split = planImportBatches(current, selection);
    const titles = bundleSelectionPages(current);
    setNotes([
      ...pullNotes,
      ...split.notes,
      ...(split.tooLarge.length ? [`以下作品单件超过 ${MAX_MEGABYTES} MB 或 200 页，无法提交，未包含在计划中：${split.tooLarge.map((index) => `《${titles[index]?.title ?? index + 1}》`).join("、")}。`] : []),
    ]);
    const next: Batch[] = split.batches.map((indices) => ({ indices, bundle: selectBundlePages(current, new Set(indices)), report: null, error: "", replanned: false }));
    setBatches(next);
    if (!next.length) return;
    setBusy("dry-run");
    for (const [i, batch] of next.entries()) {
      if (stopped.current) { batch.error = `第 ${i + 1} 批没有试跑（已停止）。`; continue; }
      const label = next.length > 1 ? `第 ${i + 1}/${next.length} 批` : "试跑";
      setProgress(next.length > 1 ? `正在试跑${label}…` : "");
      // `apply` is omitted for a dry run rather than sent as `false`: the
      // endpoint's default *is* the dry run.
      const result = await post({ bundle: batch.bundle }, label);
      if (result.ok) batch.report = result.report;
      else batch.error = next.length > 1 ? `第 ${i + 1} 批试跑失败：${result.message}` : result.message;
      setBatches([...next]);
    }
    setProgress(""); setBusy(null);
  }

  /**
   * Write every planned batch, each with its own token, on the author's one
   * click. A failed batch does not stop the rest; a refused token (an expired
   * or no-longer-matching plan) is planned again once and waits for a fresh
   * confirm — it is never written without one.
   */
  async function applyAll(): Promise<void> {
    if (batches === null) return;
    const next = batches.map((batch) => ({ ...batch }));
    const pending = next.filter((batch) => batch.report !== null && !batch.report.applied && describeImport(batch.report).canApply);
    stopped.current = false;
    setError(""); setBusy("apply");
    for (const batch of pending) {
      const i = next.indexOf(batch);
      const label = next.length > 1 ? `第 ${i + 1}/${next.length} 批` : "写入";
      if (stopped.current) { batch.error = `${next.length > 1 ? `第 ${i + 1} 批` : "本批"}没有写入（已停止）。`; continue; }
      setProgress(next.length > 1 ? `正在写入${label}…` : "");
      const result = await post({ bundle: batch.bundle, apply: true, planToken: batch.report!.planToken }, label);
      const prefix = next.length > 1 ? `第 ${i + 1} 批：` : "";
      if (result.ok) {
        batch.report = result.report; batch.error = ""; batch.replanned = false;
      } else if (result.code === "IMPORT_PLAN_INVALID" && !batch.replanned) {
        setProgress(next.length > 1 ? `第 ${i + 1} 批的试跑计划已失效，正在重新试跑…` : "试跑计划已失效，正在重新试跑…");
        const again = await post({ bundle: batch.bundle }, label);
        if (again.ok) {
          batch.report = again.report; batch.replanned = true;
          batch.error = `${prefix}试跑计划已失效或与当前选择不符，没有执行本次写入。已自动重新试跑，请核对下面的新计划后再确认。`;
        } else {
          batch.report = null; batch.error = `${prefix}${again.message}`;
        }
      } else {
        // The plan stays visible, but this batch is no longer confirmable.
        batch.report = batch.report && { ...batch.report, planToken: undefined };
        batch.error = `${prefix}写入失败：${result.message}`;
      }
      setBatches([...next]);
    }
    setProgress(""); setBusy(null);
  }

  /**
   * For a pulled database, read the blocks of the selected pages that have none
   * yet, and plan only the pages that now have them. A page Notion would not give
   * us is named with its reason and left out of the plan — never imported without
   * its body. A failure that may pass (a timeout) is asked again on the next dry run.
   * Returns null when the pull itself failed or was stopped; the error is shown.
   */
  async function readPulledPages(current: Record<string, unknown>, selection: ReadonlySet<number>):
    Promise<{ bundle: Record<string, unknown>; selection: ReadonlySet<number>; notes: string[] } | null> {
    const session = pull.current;
    if (session === null) return { bundle: current, selection, notes: [] };
    const ids = (Array.isArray(current.pages) ? current.pages : []).map((page: unknown) =>
      typeof page === "object" && page !== null && typeof (page as { id?: unknown }).id === "string" ? (page as { id: string }).id : "");
    const missing = [...selection].map((index) => ids[index] ?? "").filter((id) => id !== "" && !session.read.has(id) && !session.unreadable.has(id));
    const reasons = new Map<string, string>(session.unreadable);
    let bundleWithBlocks = current;
    if (missing.length > 0) {
      setBusy("pull"); setPulling(true);
      const result = await pullNotionPages(session.token, missing, { post: proxyFetchPost(), onProgress: setProgress, isStopped: () => stopped.current });
      setPulling(false); setProgress(""); setBusy(null);
      if (!result.ok) { setError(result.message); return null; }
      for (const id of result.blocks.keys()) session.read.add(id);
      for (const issue of result.issues) {
        reasons.set(issue.id, issue.code);
        if (!isRetryableNotionIssue(issue.code)) session.unreadable.set(issue.id, issue.code);
      }
      bundleWithBlocks = withPulledBlocks(current, result.blocks);
      setBundle(bundleWithBlocks);
    }
    const left = [...selection].filter((index) => !session.read.has(ids[index] ?? ""));
    if (left.length === 0) return { bundle: bundleWithBlocks, selection, notes: [] };
    const titles = bundleSelectionPages(bundleWithBlocks);
    const kept = new Set([...selection].filter((index) => !left.includes(index)));
    setSelected(kept);
    return {
      bundle: bundleWithBlocks,
      selection: kept,
      notes: [`以下 ${left.length} 页没有从 Notion 读到正文，已取消勾选、未包含在计划中：${left.map((index) => {
        const code = reasons.get(ids[index] ?? "") ?? "fetch-failed";
        return `《${titles[index]?.title ?? index + 1}》（${NOTION_PULL_ISSUE_TEXT[code] ?? code}${isRetryableNotionIssue(code) ? "，重新勾选后试跑会再读一次" : ""}）`;
      }).join("、")}。`],
    };
  }

  /** Connect with the pasted token and list the database's rows; nothing is written. */
  async function connect(): Promise<void> {
    const pasted = token.trim();
    setBatches(null); setNotes([]); setAutoNote(""); setError(""); setWarnings([]);
    setBundle(null); setPageCount(0); setSelected(new Set()); setQuery(""); setFileName("");
    pull.current = null;
    if (!looksLikeNotionToken(pasted)) {
      setError("这不像 Notion 集成令牌：应以 ntn_（或旧版 secret_）开头，可在 Notion 的「设置 → 连接 → 开发或管理集成」里复制。");
      return;
    }
    if (source.trim() === "") { setError("请粘贴 Notion 数据库的链接（浏览器地址栏里的整段网址即可）。"); return; }
    stopped.current = false;
    setBusy("pull"); setPulling(true);
    const result = await pullNotionRows(pasted, source.trim(), { post: proxyFetchPost(), onProgress: setProgress, isStopped: () => stopped.current });
    setPulling(false); setProgress(""); setBusy(null);
    if (!result.ok) { setError(result.message); return; }
    pull.current = { token: pasted, read: new Set(), unreadable: new Map() };
    setFileName(`${result.bundle.database.title || "Notion 数据库"} · ${result.bundle.pages.length} 个条目`);
    setBundle(result.bundle); setPageCount(result.bundle.pages.length);
    setSelected(new Set(result.bundle.pages.map((_page, index) => index)));
    if (result.truncated) {
      setWarnings([`这个数据库超过 ${NOTION_PULL_MAX_ROWS} 个条目，只列出了前 ${NOTION_PULL_MAX_ROWS} 个，其余条目这次不会导入。请在 Notion 里拆分数据库后分别拉取，或改用导出文件。`]);
    }
  }

  async function choose(files: File[]): Promise<void> {
    pull.current = null;
    setTab("file");
    setFileName(files.map((file) => file.name).join("、"));
    setBatches(null); setNotes([]); setAutoNote("");
    setError("");
    setWarnings([]);
    setBundle(null);
    setPageCount(0);
    setSelected(new Set());
    setQuery("");
    setBusy("dry-run");
    try {
      if (files.reduce((sum, file) => sum + file.size, 0) > 8 * 1024 * 1024) throw new Error("文件总大小超过 8 MB，请分批导入。");
      if (files.length === 1 && /\.json$/i.test(files[0]!.name)) {
        const file = files[0]!;
        const read = readBundleFile({ text: await file.text(), byteLength: file.size });
        if (!read.ok) throw new Error(read.message);
        setBundle(read.bundle); setPageCount(read.pages);
        // Everything is selected to begin with: the common case is "import this
        // export", and the plan still has to be read and confirmed before a write.
        setSelected(new Set(bundleSelectionPages(read.bundle).map((page) => page.index)));
        setBusy(null);
        return;
      }
      const entries: { name: string; text: string }[] = [];
      for (const file of files) {
        // A database CSV only carries properties for the Markdown pages beside it.
        if (/\.(md|csv)$/i.test(file.name)) entries.push({ name: file.name, text: new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()) });
        else if (/\.zip$/i.test(file.name)) entries.push(...readMarkdownZip(new Uint8Array(await file.arrayBuffer())));
        else throw new Error(`${file.name}：请选择 Markdown（可附带数据库 CSV）、ZIP，或单个 JSON bundle。`);
      }
      const result = markdownEntriesToBundle(entries);
      setBundle(result.bundle); setPageCount(result.pages); setWarnings(result.warnings);
      setSelected(new Set(bundleSelectionPages(result.bundle).map((page) => page.index)));
      setBusy(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : "文件无法读取，请重新选择。 ");
      setBusy(null);
    }
  }

  function changeSelection(next: ReadonlySet<number>) {
    // A page whose English counterpart is in this export brings it along: the
    // API refuses a work whose counterpart was not sent with it.
    const { selection, added } = withEnglishPartners(selected, next, partners);
    setAutoNote(added.length ? `已自动为你勾上对照的英文页：${added.map((index) => `《${choices[index]?.title ?? index + 1}》`).join("、")}。` : "");
    setSelected(selection);
    setBatches(null); setNotes([]);
    setError("");
  }
  /** Change the selection from the plan, and plan that selection: one click, still no write. */
  function reselect(next: ReadonlySet<number>) {
    if (bundle === null || next.size === 0) return;
    setSelected(next);
    void plan(next);
  }
  /** Start over with another file, leaving this result behind. */
  function another() {
    // A pulled database starts over at the connect form, with the token still in
    // the field: "再导入一批" from the same workspace should not mean pasting again.
    const fromNotion = pull.current !== null;
    pull.current = null;
    setFileName(""); setBundle(null); setPageCount(0); setBatches(null); setNotes([]); setAutoNote(""); setError(""); setWarnings([]);
    setSelected(new Set()); setQuery(""); setFilter("all");
    if (!fromNotion) fileInput.current?.click();
  }
  const choices = bundle === null ? [] : bundleSelectionPages(bundle);
  const partners = bundle === null ? new Map<number, { inBundle: number[]; missing: string[] }>() : englishPartners(bundle);
  const needsEnglish = [...partners.entries()].filter(([, partner]) => partner.missing.length > 0).map(([index]) => index);
  const needle = query.trim().toLowerCase();
  const visible = needle === "" ? choices : choices.filter((page) => page.title.toLowerCase().includes(needle));
  const visibleIndices = visible.map((page) => page.index);
  const total = batches?.length ?? 0;
  const appliedCount = planned.filter((batch) => batch.report!.applied).length;
  const confirmable = planned.filter((batch) => !batch.report!.applied && describeImport(batch.report!).canApply);
  const writable = confirmable.reduce((sum, batch) => sum + describeImport(batch.report!).writable, 0);
  const batchErrors = (batches ?? []).map((batch) => batch.error).filter(Boolean);
  const base = report === null ? null : describeImport(report);
  // A merged report is either a plan, a result, or — after a partial write —
  // both; that last case gets its own sentence rather than a plan's.
  const outcome = base === null ? null : appliedCount > 0 && appliedCount < total
    ? { ...base, headline: `部分批次已写入：${appliedCount} / ${total} 批（新建 ${planned.filter((b) => b.report!.applied).reduce((n, b) => n + b.report!.summary.create, 0)} 件、更新 ${planned.filter((b) => b.report!.applied).reduce((n, b) => n + b.report!.summary.update, 0)} 件）。其余批次见下方说明。` }
    : base;
  const issues = report === null ? [] : issueCounts(report);
  const writableIndices = report === null || bundle === null || report.applied ? null : indicesWithActions(bundle, report, ["create", "update"]);
  const rows = report === null ? [] : report.pages.filter((page) => reportRowMatches(page, filter));

  return (
    <section className="nw-import">
      <div className="nw-import-head">
        <h1><span className="nw-zh">从 Notion 导入</span> <i>Import</i></h1>
        <Link className="nw-btn" href="/write">回到写作台</Link>
      </div>
      <p className="nw-ep">
        直接连接 Notion 数据库拉取，或上传 Notion 导出的文件。勾选想导入的文章，试跑并检查报告后再确认写入；
        未勾选的页面不会提交。已有文章可能被更新，请留意试跑结果。
      </p>

      <div className="nw-import-tabs" role="tablist" aria-label="导入方式">
        <button type="button" role="tab" id="notion-tab-pull" aria-controls="notion-panel-pull" aria-selected={tab === "notion"}
          className="nw-import-tab" disabled={busy !== null} onClick={() => setTab("notion")}>连接 Notion 直接拉取</button>
        <button type="button" role="tab" id="notion-tab-file" aria-controls="notion-panel-file" aria-selected={tab === "file"}
          className="nw-import-tab" disabled={busy !== null} onClick={() => setTab("file")}>上传导出文件</button>
      </div>

      {tab === "notion" ? (
        <form className="nw-import-connect" id="notion-panel-pull" role="tabpanel" aria-labelledby="notion-tab-pull"
          onSubmit={(event) => { event.preventDefault(); void connect(); }}>
          <ol className="nw-m nw-import-steps">
            <li>在 Notion 打开「设置 → 连接 → 开发或管理集成」，新建一个内部集成，复制它的 Internal Integration Secret。</li>
            <li>在要导入的数据库右上角「…」→「连接」里添加这个集成。</li>
            <li>把令牌和数据库链接粘贴到下面。</li>
          </ol>
          <label className="nw-import-field">
            <span>集成令牌</span>
            <input type="password" name="notion-token" autoComplete="off" spellCheck={false} placeholder="ntn_…" value={token}
              disabled={busy !== null} onChange={(event) => setToken(event.currentTarget.value)} />
          </label>
          <label className="nw-import-field">
            <span>数据库链接</span>
            <input type="text" inputMode="url" name="notion-source" autoComplete="off" spellCheck={false} placeholder="https://www.notion.so/…" value={source}
              disabled={busy !== null} onChange={(event) => setSource(event.currentTarget.value)} />
          </label>
          <p className="nw-m">
            令牌只用于这次拉取：经本站服务器转发给 Notion，不保存、不写入日志，刷新或离开页面即失效。建议给集成只开「读取内容」权限。
          </p>
          <div className="nw-import-pick">
            <button className="nw-btn" type="submit" disabled={busy !== null || token.trim() === "" || source.trim() === ""}>
              {busy === "pull" && bundle === null ? "正在读取…" : "连接并读取条目"}
            </button>
            {pull.current !== null && fileName !== "" ? <span className="nw-import-file" role="status">已连接：{fileName}</span> : null}
          </div>
          <p className="nw-m">
            先只读取条目列表；正文在试跑时只为勾选的页面读取。超过 {MAX_MEGABYTES} MB / 200 页（或 8 张在线 Notion 图片）会自动分批提交。
            在线 Notion 图片会尝试复制，失败则移除并报告。未指定 Published 的文章默认为草稿。
          </p>
        </form>
      ) : (
        <div id="notion-panel-file" role="tabpanel" aria-labelledby="notion-tab-file">
          <p className="nw-m">
            选择 Notion 导出的 Markdown 文件（可多选，可附带数据库 CSV）或 ZIP 压缩包，也支持原有 JSON bundle。
            导出包里的数据库 CSV 会用来补齐 Markdown 中缺失的日期、摘要、标签等属性，不会覆盖已有值。
          </p>
          <p className="nw-m">
            所选文件合计不超过 {MAX_MEGABYTES} MB。超过 {MAX_MEGABYTES} MB / 200 页（或 8 张在线 Notion 图片）会自动分批提交：先逐批试跑，再一次确认。ZIP 内的本地图片目前不会导入，会在下方提示；在线 Notion 图片会尝试复制，失败则移除并报告。未指定 Published 的文章默认为草稿。
          </p>
          <div className="nw-import-pick">
            <label className="nw-btn" htmlFor="notion-bundle-file">选择文件</label>
            <span className="nw-import-file" role="status">
              {fileName === "" || pull.current !== null ? "还没有选择文件" : `${fileName}${pageCount > 0 ? ` · ${pageCount} 页` : ""}`}
            </span>
          </div>
        </div>
      )}

      {/* Outside the panels so a file can be chosen from either; choosing one switches to the upload tab. */}
      <input
          accept=".md,.csv,.zip,.json,text/csv,application/json,application/zip"
          multiple
          disabled={busy !== null}
          hidden
          id="notion-bundle-file"
          ref={fileInput}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            // Cleared so choosing the same file again is still a change event —
            // the second look at a bundle the author just edited is the common case.
            event.currentTarget.value = "";
            if (files.length) void choose(files);
          }}
          type="file"
        />

      {busy === "dry-run" && progress === "" ? <p className="nw-m" role="status">正在读取或试跑所选页面…</p> : null}
      {progress !== "" ? (
        <p className="nw-import-progress" role="status">
          {progress}
          {pulling ? <button className="nw-btn" type="button" onClick={() => { stopped.current = true; }}>停止拉取</button>
            : total > 1 ? <button className="nw-btn" type="button" onClick={() => { stopped.current = true; }}>停止剩余批次</button> : null}
        </p>
      ) : null}
      {error !== "" || batchErrors.length > 0 ? (
        <div className="nw-auth-error" role="alert">
          {[error, ...batchErrors].filter(Boolean).map((message, index) => <p key={index}>{message}</p>)}
        </div>
      ) : null}
      {notes.length > 0 ? <ul className="nw-import-notes" role="status">{notes.map((note, index) => <li key={index}>{note}</li>)}</ul> : null}
      {warnings.length > 0 ? <div role="status"><p>文件转换提示（请核对后再确认）：</p><ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div> : null}

      {bundle !== null && choices.length > 0 ? (
        <section className="nw-import-selection" aria-labelledby="notion-selection-title">
          <h2 id="notion-selection-title">选择要导入的文章</h2>
          <p className="nw-m">已选 {selected.size} / {choices.length} 页，默认全选。关联的译文请一并选择；更改选择后须重新试跑。</p>
          {choices.length > 1 ? (
            <label className="nw-import-search">
              <span>按标题筛选</span>
              <input type="search" value={query} disabled={busy !== null} placeholder="输入标题中的字词" onChange={(event) => setQuery(event.currentTarget.value)} />
            </label>
          ) : null}
          {needle !== "" ? <p className="nw-m" role="status">筛选出 {visible.length} 页；下面的全选、清空、反选只作用于这些页面。</p> : null}
          {autoNote !== "" ? <p className="nw-import-auto" role="status">{autoNote}</p> : null}
          {needsEnglish.length > 0 ? (
            <p className="nw-import-hint">
              有 {needsEnglish.length} 页标注了「需先补齐英文版」：它们的 English 关联页不在这次的文件里，试跑会被拒绝。
              请在 Notion 导出时勾选「包含子页面」，或把对照的英文页一起导出后再选择。
            </p>
          ) : null}
          <div className="nw-import-select-actions">
            <button type="button" className="nw-btn" disabled={busy !== null || visibleIndices.every((index) => selected.has(index))}
              onClick={() => changeSelection(new Set([...selected, ...visibleIndices]))}>全选</button>
            <button type="button" className="nw-btn" disabled={busy !== null || !visibleIndices.some((index) => selected.has(index))}
              onClick={() => changeSelection(new Set([...selected].filter((index) => !visibleIndices.includes(index))))}>清空</button>
            <button type="button" className="nw-btn" disabled={busy !== null || visibleIndices.length === 0}
              onClick={() => changeSelection(invertSelection(selected, visibleIndices))}>反选</button>
          </div>
          <ul className="nw-import-selection-list">
            {visible.map((page) => (
              <li key={page.index}>
                <label className="nw-import-select-page">
                  <input type="checkbox" checked={selected.has(page.index)} disabled={busy !== null}
                    onChange={(event) => {
                      const next = new Set(selected);
                      if (event.currentTarget.checked) next.add(page.index); else next.delete(page.index);
                      changeSelection(next);
                    }} />
                  <span>{page.title}</span>
                  {partners.get(page.index)?.missing.length ? <span className="nw-import-badge">需先补齐英文版</span> : null}
                </label>
                {selected.has(page.index) ? (partners.get(page.index)?.inBundle ?? []).filter((partner) => !selected.has(partner)).map((partner) => (
                  <p className="nw-import-row-hint" key={partner}>
                    对照的英文页《{choices[partner]?.title}》未勾选：试跑时这件作品会被拒绝。
                    <button type="button" className="nw-import-inline" disabled={busy !== null}
                      onClick={() => changeSelection(new Set([...selected, partner]))}>一并勾上《{choices[partner]?.title}》</button>
                  </p>
                )) : null}
                {page.preview ? <details><summary>查看正文摘录</summary><p className="nw-import-preview">{page.preview}</p></details> : null}
              </li>
            ))}
          </ul>
          <button className="nw-btn" type="button" disabled={busy !== null || selected.size === 0}
            onClick={() => void plan(selected)}>试跑所选文章</button>
        </section>
      ) : null}
      {bundle !== null && choices.length === 0 ? <p className="nw-m">{pull.current !== null ? "这个数据库里没有条目。" : "文件中没有可选择的页面。"}</p> : null}

      {report !== null && outcome !== null ? (
        <div className="nw-import-report">
          <p className="nw-import-headline" role="status">{outcome.headline}</p>
          {total > 1 ? (
            <p className="nw-import-source">
              超过单次 {MAX_MEGABYTES} MB、200 页或 8 张 Notion 图片的上限，已自动分成 {total} 批提交；同一作品的各语言版本总在同一批。
              {appliedCount > 0 ? ` 已写入 ${appliedCount} 批。` : ""}
            </p>
          ) : null}
          {report.database.id !== "" ? (
            <p className="nw-import-source">
              {pull.current !== null ? "Notion 数据库" : "bundle 里的数据库"}：{report.database.title ?? report.database.id}
            </p>
          ) : null}

          <div className="nw-import-filter" role="group" aria-label="按结果筛选报告">
            {FILTERS.map(({ id, label }) => (
              <button key={id} type="button" className="nw-import-chip" aria-pressed={filter === id} onClick={() => setFilter(id)}>
                {label} {report.pages.filter((page) => reportRowMatches(page, id)).length}
              </button>
            ))}
            <button type="button" className="nw-import-chip nw-import-download" onClick={() => downloadReport(report)}>下载报告 CSV</button>
          </div>
          {writableIndices !== null && bundle !== null ? (
            <div className="nw-import-select-actions">
              {writableIndices.size > 0 && writableIndices.size < selected.size ? (
                <button type="button" className="nw-btn" disabled={busy !== null} onClick={() => reselect(writableIndices)}>
                  只导入会新建或更新的（{writableIndices.size} 页）
                </button>
              ) : null}
              {selected.size < choices.length ? (
                <button type="button" className="nw-btn" disabled={busy !== null} onClick={() => reselect(new Set(choices.map((page) => page.index)))}>
                  全选（含无变化的）
                </button>
              ) : null}
            </div>
          ) : null}

          {rows.length === 0 ? <p className="nw-m">没有符合这个筛选的页面。</p> : null}
          <ul className="nw-import-pages">
            {rows.map((page) => (
              <li
                className="nw-import-page"
                data-action={page.action}
                key={`${page.externalId}:${page.locale}`}
              >
                <span className="nw-import-action" data-action={page.action}>
                  {ACTION_LABEL[page.action]}
                </span>
                <span className="nw-import-title">{page.title === "" ? page.externalId : page.title}</span>
                <span className="nw-import-locale">{page.locale}</span>
                {page.action === "update" ? (
                  <small className="nw-import-target">
                    将更新：{page.articleId !== null && targets.has(page.articleId) ? `《${targets.get(page.articleId)!.title}》` : "已有作品"}
                    {page.slug !== "" ? ` · /${page.slug}` : ""}
                  </small>
                ) : page.slug !== "" && page.action === "create" ? <small className="nw-import-target">地址 /{page.slug}</small> : null}
                {page.issues.length > 0 ? (
                  <span className="nw-import-issues">{page.issues.map((issue) => issue.code).join("、")}</span>
                ) : null}
                {page.issues.filter((issue) => issue.code !== "expiring-image-url").map((issue, index) => (
                  <small className="nw-import-reason" key={`${issue.code}:${index}`}>{importDetail(issue.detail)}</small>
                ))}
                {page.detail !== "" ? <small className="nw-import-reason">{importDetail(page.detail)}</small> : null}
              </li>
            ))}
          </ul>

          {issues.length > 0 ? (
            <p className="nw-import-issues-summary">
              没有带过来的内容：
              {issues.map(({ code, count }) => `${code} ×${count}`).join("、")}
            </p>
          ) : null}

          {confirmable.length > 0 ? (
            <div className="nw-import-confirm">
              <button
                className="nw-btn"
                disabled={busy !== null}
                onClick={() => void applyAll()}
                type="button"
              >
                {busy === "apply" ? "写入中…" : `确认导入（写入 ${writable} 件作品${total > 1 ? `，${appliedCount > 0 ? "剩余 " : "分 "}${confirmable.length} 批` : ""}）`}
              </button>
              <p className="nw-m">
                试跑计划在 15 分钟内有效，并绑定当前选择与作品版本。试跑后的编辑或来源变化会由服务器拒绝，
                请重新试跑后确认；同一作品的所有语言版本会一起写入或回滚，其他作品可独立成功。
              </p>
              <p className="nw-m">
                试跑没有写入任何内容。写入时状态跟着 bundle 走：「Published」为真的那一页会被直接发表，
                为假的或缺失的是草稿；系统以实际发表时间为准。确认前请先看清上面每一页的动作。
              </p>
            </div>
          ) : null}

          {appliedCount > 0 && confirmable.length === 0 && busy === null ? (
            <p className="nw-import-done">
              <Link className="nw-btn nw-pri" href="/write">去看写作台</Link>
              <button className="nw-btn" type="button" onClick={another}>再导入一批</button>
            </p>
          ) : null}
        </div>
      ) : null}

    </section>
  );
}
