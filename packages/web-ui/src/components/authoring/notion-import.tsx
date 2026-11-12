import { Link } from "@/lib/framework/link.tsx";
import { useState } from "react";
import { markdownEntriesToBundle, readMarkdownZip } from "@/lib/notion-markdown.ts";
import {
  ACTION_LABEL,
  asImportReport,
  bundleSelectionPages,
  selectBundlePages,
  describeImport,
  issueCounts,
  readBundleFile,
  type NotionImportReport,
} from "@/lib/notion-import.ts";

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

/** Explain conservative source-identity refusals without exposing private IDs. */
function importDetail(detail: string): string {
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

function dataOf(payload: unknown): unknown {
  return typeof payload === "object" && payload !== null ? (payload as { data?: unknown }).data : null;
}

export function NotionImport() {
  const [fileName, setFileName] = useState("");
  const [bundle, setBundle] = useState<Record<string, unknown> | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [report, setReport] = useState<NotionImportReport | null>(null);
  const [busy, setBusy] = useState<null | "dry-run" | "apply">(null);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [plannedBundle, setPlannedBundle] = useState<Record<string, unknown> | null>(null);

  async function send(next: Record<string, unknown>, apply: boolean): Promise<void> {
    const planToken = apply ? report?.planToken : undefined;
    if (apply && !planToken) { setError("请先重新试跑，再确认导入。"); return; }
    setBusy(apply ? "apply" : "dry-run");
    setError("");
    setReport(null);
    setPlannedBundle(null);
    try {
      const response = await fetch("/api/authoring/notion-import", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        // `apply` is omitted for a dry run rather than sent as `false`: the
        // endpoint's default *is* the dry run, and a body that cannot be
        // misunderstood is worth one fewer key.
        body: JSON.stringify(apply ? { bundle: next, apply: true, planToken } : { bundle: next }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (response.ok === false) {
        setError(failureMessage(payload, response.status));
        return;
      }
      const parsed = asImportReport(dataOf(payload));
      if (parsed === null) {
        // Never pretend a report was shown. The plan is the whole point of the
        // page, and "nothing was written" is the only safe thing to say.
        setError("导入接口的响应格式不符合约定，无法确认结果；部分内容可能已写入，请检查写作台后重新试跑。");
        return;
      }
      setReport(parsed);
      if (!apply && !parsed.applied) setPlannedBundle(next);
    } catch {
      setError("网络中断，无法确认导入结果。部分内容可能已写入；请检查写作台，再重新试跑。 ");
    } finally {
      setBusy(null);
    }
  }

  async function choose(files: File[]): Promise<void> {
    setFileName(files.map((file) => file.name).join("、"));
    setReport(null);
    setError("");
    setWarnings([]);
    setBundle(null);
    setPageCount(0);
    setSelected(new Set());
    setPlannedBundle(null);
    setBusy("dry-run");
    try {
      if (files.reduce((sum, file) => sum + file.size, 0) > 8 * 1024 * 1024) throw new Error("文件总大小超过 8 MB，请分批导入。");
      if (files.length === 1 && /\.json$/i.test(files[0]!.name)) {
        const file = files[0]!;
        const read = readBundleFile({ text: await file.text(), byteLength: file.size });
        if (!read.ok) throw new Error(read.message);
        setBundle(read.bundle); setPageCount(read.pages);
        setBusy(null);
        return;
      }
      const entries: { name: string; text: string }[] = [];
      for (const file of files) {
        if (/\.md$/i.test(file.name)) entries.push({ name: file.name, text: new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()) });
        else if (/\.zip$/i.test(file.name)) entries.push(...readMarkdownZip(new Uint8Array(await file.arrayBuffer())));
        else throw new Error(`${file.name}：请选择 Markdown、ZIP，或单个 JSON bundle。`);
      }
      const result = markdownEntriesToBundle(entries);
      setBundle(result.bundle); setPageCount(result.pages); setWarnings(result.warnings);
      setBusy(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : "文件无法读取，请重新选择。 ");
      setBusy(null);
    }
  }

  function changeSelection(next: ReadonlySet<number>) {
    setSelected(next);
    setReport(null);
    setPlannedBundle(null);
    setError("");
  }
  const choices = bundle === null ? [] : bundleSelectionPages(bundle);
  const outcome = report === null ? null : describeImport(report);
  const issues = report === null ? [] : issueCounts(report);

  return (
    <section className="nw-import">
      <div className="nw-import-head">
        <h1><span className="nw-zh">从 Notion 导入</span> <i>Import</i></h1>
        <Link className="nw-btn" href="/write">回到写作台</Link>
      </div>
      <p className="nw-ep">
        选择 Notion 导出的 Markdown 文件（可多选）或 ZIP 压缩包，也支持原有 JSON bundle。
        勾选想导入的文章，试跑并检查报告后再确认写入；未勾选的页面不会提交。已有文章可能被更新，请留意试跑结果。
      </p>
      <p className="nw-m">
        上限 {MAX_MEGABYTES} MB、一次最多 200 页。ZIP 内的本地图片目前不会导入，会在下方提示；在线 Notion 图片会尝试复制，失败则移除并报告。一次最多复制 8 张不同图片。未指定 Published 的文章默认为草稿。
      </p>

      <div className="nw-import-pick">
        <label className="nw-btn" htmlFor="notion-bundle-file">选择文件</label>
        <input
          accept=".md,.zip,.json,application/json,application/zip"
          multiple
          disabled={busy !== null}
          hidden
          id="notion-bundle-file"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            // Cleared so choosing the same file again is still a change event —
            // the second look at a bundle the author just edited is the common case.
            event.currentTarget.value = "";
            if (files.length) void choose(files);
          }}
          type="file"
        />
        <span className="nw-import-file" role="status">
          {fileName === "" ? "还没有选择文件" : `${fileName}${pageCount > 0 ? ` · ${pageCount} 页` : ""}`}
        </span>
      </div>

      {busy === "dry-run" ? <p className="nw-m" role="status">正在读取或试跑所选页面…</p> : null}
      {error !== "" ? <p className="nw-auth-error" role="alert">{error}</p> : null}
      {warnings.length > 0 ? <div role="status"><p>文件转换提示（请核对后再确认）：</p><ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div> : null}

      {bundle !== null && choices.length > 0 ? (
        <section className="nw-import-selection" aria-labelledby="notion-selection-title">
          <h2 id="notion-selection-title">选择要导入的文章</h2>
          <p className="nw-m">已选 {selected.size} / {choices.length} 页。关联的译文请一并选择；更改选择后须重新试跑。</p>
          <div className="nw-import-select-actions">
            <button type="button" className="nw-btn" disabled={busy !== null || selected.size === choices.length}
              onClick={() => changeSelection(new Set(choices.map((page) => page.index)))}>全选</button>
            <button type="button" className="nw-btn" disabled={busy !== null || selected.size === 0}
              onClick={() => changeSelection(new Set())}>清空选择</button>
          </div>
          <ul className="nw-import-selection-list">
            {choices.map((page) => (
              <li key={page.index}>
                <label className="nw-import-select-page">
                  <input type="checkbox" checked={selected.has(page.index)} disabled={busy !== null}
                    onChange={(event) => {
                      const next = new Set(selected);
                      if (event.currentTarget.checked) next.add(page.index); else next.delete(page.index);
                      changeSelection(next);
                    }} />
                  <span>{page.title}</span>
                </label>
                {page.preview ? <details><summary>查看正文摘录</summary><p className="nw-import-preview">{page.preview}</p></details> : null}
              </li>
            ))}
          </ul>
          <button className="nw-btn" type="button" disabled={busy !== null || selected.size === 0}
            onClick={() => void send(selectBundlePages(bundle, selected), false)}>试跑所选文章</button>
        </section>
      ) : null}
      {bundle !== null && choices.length === 0 ? <p className="nw-m">文件中没有可选择的页面。</p> : null}

      {report !== null && outcome !== null ? (
        <div className="nw-import-report">
          <p className="nw-import-headline" role="status">{outcome.headline}</p>
          {report.database.id !== "" ? (
            <p className="nw-import-source">
              bundle 里的数据库：{report.database.title ?? report.database.id}
            </p>
          ) : null}

          <ul className="nw-import-pages">
            {report.pages.map((page) => (
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

          {outcome.canApply && plannedBundle !== null ? (
            <div className="nw-import-confirm">
              <button
                className="nw-btn"
                disabled={busy !== null}
                onClick={() => void send(plannedBundle, true)}
                type="button"
              >
                {busy === "apply" ? "写入中…" : `确认导入（写入 ${outcome.writable} 件作品）`}
              </button>
              <p className="nw-m" role="alert">
                试跑计划在 15 分钟内有效，并绑定当前选择与作品版本。试跑后的编辑或来源变化会由服务器拒绝，
                请重新试跑后确认；同一作品的所有语言版本会一起写入或回滚，其他作品可独立成功。
              </p>
              <p className="nw-m">
                试跑没有写入任何内容。写入时状态跟着 bundle 走：「Published」为真的那一页会被直接发表，
                为假的或缺失的是草稿；系统以实际发表时间为准。确认前请先看清上面每一页的动作。
              </p>
            </div>
          ) : null}

          {report.applied ? (
            <p className="nw-import-done">
              <Link className="nw-btn" href="/write">去看写作台</Link>
            </p>
          ) : null}
        </div>
      ) : null}

    </section>
  );
}
