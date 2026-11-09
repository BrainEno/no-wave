import { Link } from "@/lib/framework/link.tsx";
import { useState } from "react";
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
        setError("导入接口的响应和约定的格式不一样，这一页没有改动，也没有写入任何内容。");
        return;
      }
      setReport(parsed);
    } catch {
      setError("网络中断，这次导入没有完成。请重试。");
    } finally {
      setBusy(null);
    }
  }

  async function choose(file: File): Promise<void> {
    setFileName(file.name);
    setReport(null);
    setError("");
    setBundle(null);
    setPageCount(0);
    let text: string;
    try {
      text = await file.text();
    } catch {
      setError("这个文件读不出来，请重新选择。");
      return;
    }
    const read = readBundleFile({ text, byteLength: file.size });
    if (read.ok === false) {
      setError(read.message);
      return;
    }
    setBundle(read.bundle);
    setPageCount(read.pages);
    await send(read.bundle, false);
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
        选一个从 Notion 导出的 bundle（JSON 文件）。第一次只是试跑：服务端会把每一页会发生什么算出来，
        你先读这份报告，确认之后才写入。写入只发生在你自己名下的作品里 —— 不会改动别人的作品，也不会重建页面之间的关系。
      </p>
      <p className="nw-m">
        上限 {MAX_MEGABYTES} MB、一次最多 200 页；同一个文件重复导入只会得到「跳过」，不会写第二遍。
      </p>

      <div className="nw-import-pick">
        <label className="nw-btn" htmlFor="notion-bundle-file">选择 bundle 文件</label>
        <input
          accept="application/json,.json"
          hidden
          id="notion-bundle-file"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            // Cleared so choosing the same file again is still a change event —
            // the second look at a bundle the author just edited is the common case.
            event.currentTarget.value = "";
            if (file) void choose(file);
          }}
          type="file"
        />
        <span className="nw-import-file" role="status">
          {fileName === "" ? "还没有选择文件" : `${fileName}${pageCount > 0 ? ` · ${pageCount} 页` : ""}`}
        </span>
      </div>

      {busy === "dry-run" ? <p className="nw-m" role="status">正在试跑，正在读每一页…</p> : null}
      {error !== "" ? <p className="nw-auth-error" role="alert">{error}</p> : null}

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
                {page.action === "refused" || page.action === "failed"
                  ? <small className="nw-import-reason">{page.detail}</small>
                  : null}
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
