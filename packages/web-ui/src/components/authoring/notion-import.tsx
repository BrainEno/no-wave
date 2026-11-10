import { Link } from "@/lib/framework/link.tsx";
import { useState } from "react";
import { markdownEntriesToBundle, readMarkdownZip } from "@/lib/notion-markdown.ts";
import {
  ACTION_LABEL,
  asImportReport,
  describeImport,
  issueCounts,
  readBundleFile,
  type NotionImportReport,
} from "@/lib/notion-import.ts";

/**
 * Import a Notion bundle into the author's own works (ADR 0036, phase 4).
 *
 * Three decisions this page makes, and the reasoning matters more than the markup:
 *
 *  1. **The file is read in the browser and sent as text.** A bundle is a
 *     document the author exported, not bytes a server needs to parse for them:
 *     reading it here is what lets the page say "this is not JSON" or "this is a
 *     saved API response" before a megabyte travels, and the API stays the
 *     authority on what a bundle *is*.
 *  2. **Choosing a file starts a dry run, and nothing else.** The author never
 *     has to know that the plan and the write are two requests — they see the
 *     plan first because that is what the page asks the server for, and writing is
 *     a second, explicit press. A dry run reports `applied: false`; the button
 *     only exists while that is true and there is something to write.
 *  3. **The report is shown as the server wrote it.** Page actions, per-page
 *     issues and the reasons a page was refused are the mapping's answers, and a
 *     page that re-worded them could say something the import did not do. Only the
 *     action names are translated, because those are a vocabulary this page owns.
 *
 * It is shared UI (`@bot-thk/web-ui`), so it reaches the router only through
 * `@/lib/framework/*` and names no framework of its own.
 */

const MAX_MEGABYTES = 8;

/** The API's answers that have a sentence of their own; the rest are its message. */
function failureMessage(payload: unknown, status: number): string {
  const message = typeof payload === "object" && payload !== null
    ? (payload as { error?: { message?: unknown } }).error?.message
    : undefined;
  if (status === 401) return "登录状态已失效，请重新登录后再导入。";
  if (status === 413) return `文件超过 ${MAX_MEGABYTES} MB 的上限，请在 Notion 里分批导出。`;
  if (status === 415) return "这个请求必须是 JSON。";
  // Anything else is the API's own refusal — a bundle it cannot map, a limit it
  // enforces — and its sentence names the page and the field. Replacing it with
  // "导入失败" would throw away the only part the author can act on.
  return typeof message === "string" ? message : `导入没有完成（HTTP ${status}）。`;
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

  async function send(next: Record<string, unknown>, apply: boolean): Promise<void> {
    setBusy(apply ? "apply" : "dry-run");
    setError("");
    try {
      const response = await fetch("/api/authoring/notion-import", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        // `apply` is omitted for a dry run rather than sent as `false`: the
        // endpoint's default *is* the dry run, and a body that cannot be
        // misunderstood is worth one fewer key.
        body: JSON.stringify(apply ? { bundle: next, apply: true } : { bundle: next }),
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
    setBusy("dry-run");
    try {
      if (files.reduce((sum, file) => sum + file.size, 0) > 8 * 1024 * 1024) throw new Error("文件总大小超过 8 MB，请分批导入。");
      if (files.length === 1 && /\.json$/i.test(files[0]!.name)) {
        const file = files[0]!;
        const read = readBundleFile({ text: await file.text(), byteLength: file.size });
        if (!read.ok) throw new Error(read.message);
        setBundle(read.bundle); setPageCount(read.pages);
        await send(read.bundle, false);
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
      await send(result.bundle, false);
    } catch (error) {
      setError(error instanceof Error ? error.message : "文件无法读取，请重新选择。 ");
      setBusy(null);
    }
  }

  const outcome = report === null ? null : describeImport(report);
  const issues = report === null ? [] : issueCounts(report);

  return (
    <section className="nw-import">
      <div className="nw-import-head">
        <h1><span className="nw-zh">从 Notion 导入</span> <i>Import</i></h1>
        <Link className="nw-btn" href="/write">回到写作台</Link>
      </div>
      <p className="nw-ep">
        选择 Notion 导出的 Markdown 文件（可多选）或 ZIP 压缩包，也支持原有 JSON bundle。第一次只是试跑：服务端会把每一页会发生什么算出来，
        你先读这份报告，确认之后才写入。写入只发生在你自己名下的作品里 —— 不会改动别人的作品，也不会重建页面之间的关系。
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

      {busy === "dry-run" ? <p className="nw-m" role="status">正在试跑，正在读每一页…</p> : null}
      {error !== "" ? <p className="nw-auth-error" role="alert">{error}</p> : null}
      {warnings.length > 0 ? <div role="status"><p>文件转换提示（请核对后再确认）：</p><ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div> : null}

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
                  <small className="nw-import-reason" key={`${issue.code}:${index}`}>{issue.detail}</small>
                ))}
                {page.detail !== "" ? <small className="nw-import-reason">{page.detail}</small> : null}
              </li>
            ))}
          </ul>

          {issues.length > 0 ? (
            <p className="nw-import-issues-summary">
              没有带过来的内容：
              {issues.map(({ code, count }) => `${code} ×${count}`).join("、")}
            </p>
          ) : null}

          {outcome.canApply && bundle !== null ? (
            <div className="nw-import-confirm">
              <button
                className="nw-btn"
                disabled={busy !== null}
                onClick={() => void send(bundle, true)}
                type="button"
              >
                {busy === "apply" ? "写入中…" : `确认导入（写入 ${outcome.writable} 件作品）`}
              </button>
              <p className="nw-m">
                试跑没有写入任何内容。写入时状态跟着 bundle 走：「Published」为真的那一页会被直接发表，
                为假的是草稿；发布日期取那一页的「Date」。确认前请先看清上面每一页的动作。
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
