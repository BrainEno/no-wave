import { useEffect, useRef, useState } from "react";
import type {
  PreparedWritingMerge,
  WritingMergeAnalysis,
  WritingMergeDecision,
} from "@/lib/writing-merge.ts";
import { writingMergeResultReview } from "@/lib/writing-merge-review.ts";
import { catalogueLocaleLabel } from "./catalogue-versions.tsx";
import { MERGE_ROLE_LABELS, MergeLiteral } from "./writing-merge-review.tsx";
import { WritingMergeImpactPanel } from "./writing-merge-impact.tsx";

export function WritingMergeResult({
  analysis,
  decisions,
  prepared,
  save,
}: {
  analysis: WritingMergeAnalysis;
  decisions: WritingMergeDecision[];
  prepared: PreparedWritingMerge;
  save: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const region = useRef<HTMLElement | null>(null);
  const report = writingMergeResultReview(analysis, decisions, prepared);
  const images = prepared.backup.draft.editorState!.root.children.filter(
    (node) => node.type === "image",
  );
  const inspection = prepared.inspection;
  useEffect(() => {
    region.current?.focus();
    region.current?.scrollIntoView({ block: "start" });
  }, []);
  return (
    <section
      tabIndex={-1}
      ref={region}
      className="nw-merge-result"
      aria-label="已校验的三方合并结果"
    >
      <h2>新文稿只读预览</h2>
      <p role="status">
        完整备份结构已校验：{report.blockCount} 个正文块，
        {new Intl.NumberFormat("zh-CN").format(prepared.bytes)}{" "}
        字节。原文件、编辑区和服务器均未改变。
      </p>
      <h3>{prepared.backup.draft.title || "（无标题）"}</h3>
      <p className="nw-merge-summary">
        {prepared.backup.draft.summary || "（没有摘要）"}
      </p>
      <p>
        {catalogueLocaleLabel(prepared.backup.draft.locale)} ·{" "}
        {prepared.backup.draft.workType} · 文字{" "}
        {inspection.statistics.characters} 字符 · 图片地址{" "}
        {inspection.statistics.images} 处 · 链接 {inspection.statistics.links}{" "}
        处
      </p>
      <dl className="nw-collection-statistics">
        {Object.entries(report.from).map(([role, count]) => (
          <div key={role}>
            <dt>
              取自{MERGE_ROLE_LABELS[role as keyof typeof MERGE_ROLE_LABELS]}
              的块
            </dt>
            <dd>{count}</dd>
          </div>
        ))}
      </dl>
      <p>
        相对各基线区间的块数净增加 {report.added}、净减少 {report.removed}
        ，不是文字增删统计，也不证明作者身份。人工覆盖无冲突建议{" "}
        {report.overridden} 项；冲突选择回到共同基线 {report.baseConflicts} 项。
      </p>
      {report.ambiguous ? (
        <p className="nw-merge-warning">
          有 {report.ambiguous}{" "}
          个正文区间因重复或顺序歧义而整体取舍，请特别核对没有丢掉需要的段落。
        </p>
      ) : null}
      {inspection.issues.length ? (
        <details>
          <summary>写作格式与内容提示（{inspection.issues.length}）</summary>
          <p>
            本机备份有效不等于可发布；既有编辑器、语言/类型限制、媒体所有权与服务端校验仍然适用。
          </p>
          <ul>
            {inspection.issues.map((issue, index) => (
              <li key={`${issue.code}-${index}`}>{issue.message}</li>
            ))}
          </ul>
        </details>
      ) : null}
      <ol className="nw-collection-blocks" aria-label="合并结果纯文本正文">
        {inspection.blocks.map((block) => (
          <li key={block.path.join(".")}>
            <p>
              {block.kind} · 节点{" "}
              {block.path.map((index) => index + 1).join(".")}
            </p>
            <MergeLiteral text={block.text} />
          </li>
        ))}
      </ol>
      {images.length ? (
        <details>
          <summary>结果中的图片地址（不会加载）</summary>
          <ul>
            {images.map((node, index) => (
              <li key={index}>
                <p>
                  {String(node.alt ?? "")} {String(node.caption ?? "")}
                </p>
                <code className="nw-collection-digest">
                  {String(node.src ?? "")}
                </code>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <details onToggle={(event) => setRawOpen(event.currentTarget.open)}>
        <summary>最终文稿完整 JSON（仅文字）</summary>
        {rawOpen ? <MergeLiteral text={prepared.text} /> : null}
      </details>
      <details>
        <summary>结果 SHA-256（不是签名或保存回执）</summary>
        <code className="nw-collection-digest">{prepared.digest}</code>
      </details>
      <WritingMergeImpactPanel
        analysis={analysis}
        decisions={decisions}
        prepared={prepared}
      />
      <p>
        下载为新的单篇文稿
        JSON，不包含图片字节，不自动恢复或发布。之后若要使用结果，请返回既有写作工具手动选择这个新文件、预览并选择字段。
      </p>
      <label className="nw-writing-check">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        我已核对输出，理解下载文件含未加密的私密文稿
      </label>
      <div className="nw-authoring-actions">
        <button
          className="nw-btn"
          type="button"
          disabled={!confirmed}
          onClick={save}
        >
          下载新的合并文稿 JSON
        </button>
      </div>
    </section>
  );
}
