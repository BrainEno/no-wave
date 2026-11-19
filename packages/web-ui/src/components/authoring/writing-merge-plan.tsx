import { useState } from "react";
import type {
  WritingMergeWorkbench,
  WritingMergeState,
} from "@/lib/writing-merge-controller.ts";
import type { WritingMergeAnalysis } from "@/lib/writing-merge.ts";
import type { WritingMergePlanPreview } from "@/lib/writing-merge-plan.ts";
import { writingMergeDecisionChanges } from "@/lib/writing-merge-review.ts";
import { catalogueDate } from "./catalogue-versions.tsx";
import {
  MERGE_ROLE_LABELS,
  writingMergeUnitLabel,
} from "./writing-merge-review.tsx";

type Feedback = (message: string, error?: boolean) => void;
function PlanPreview({
  controller,
  state,
  analysis,
  preview,
  feedback,
}: {
  controller: WritingMergeWorkbench;
  state: WritingMergeState;
  analysis: WritingMergeAnalysis;
  preview: WritingMergePlanPreview;
  feedback: Feedback;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const changes = writingMergeDecisionChanges(
    analysis,
    state.decisions,
    preview.decisions,
  );
  function apply() {
    if (!confirmed) return;
    try {
      controller.applyPlan(preview);
      feedback("已按刚才核对的计划完整替换人工取舍，尚未生成或下载结果。");
    } catch (error) {
      feedback(
        error instanceof Error ? error.message : "决策计划应用失败。",
        true,
      );
    }
  }
  return (
    <section
      className="nw-collection-plan-preview"
      aria-label="合并决策计划待确认预览"
    >
      <h3>计划只在预览，原人工取舍未改变</h3>
      <p>
        计划时间 {catalogueDate(preview.plan.createdAt)} UTC；列有{" "}
        {preview.manual} 项人工选择。应用后尚有 {preview.unresolved}{" "}
        项冲突未解决。
      </p>
      <p>
        应用将<strong>完整替换</strong>
        全部人工取舍，不是只补充下面这些项。计划未列出的旧选择会被清空，恢复建议或变回未解决冲突。
      </p>
      <p>将改变 {changes.length} 项人工选择：</p>
      {changes.length ? (
        <ol aria-label="计划取舍变更">
          {changes.map((change) => (
            <li key={change.unit.id}>
              <strong>{writingMergeUnitLabel(change.unit)}</strong>：
              {change.before
                ? `原人工取${MERGE_ROLE_LABELS[change.before]}`
                : "原来没有人工选择"}{" "}
              →{" "}
              {change.after
                ? `人工取${MERGE_ROLE_LABELS[change.after]}`
                : change.afterEffective
                  ? `清除人工选择，回到${MERGE_ROLE_LABELS[change.afterEffective]}建议`
                  : "清除人工选择，冲突重新未解决"}
            </li>
          ))}
        </ol>
      ) : (
        <p>人工选择与当前一致；仍须明确确认，不会自动应用。</p>
      )}
      <details>
        <summary>计划内全部人工选择（{preview.manual}）</summary>
        <ol>
          {preview.decisions.map((decision) => (
            <li key={decision.unit}>
              {writingMergeUnitLabel(
                analysis.units.find((unit) => unit.id === decision.unit)!,
              )}
              ：{MERGE_ROLE_LABELS[decision.choice]}
            </li>
          ))}
        </ol>
      </details>
      <details>
        <summary>计划摘要（不是作者签名）</summary>
        <code className="nw-collection-digest">{preview.plan.digest}</code>
      </details>
      <label className="nw-writing-check">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        我已核对全部变更，允许用此计划完整替换人工取舍
      </label>
      <div className="nw-authoring-actions">
        <button
          className="nw-btn"
          type="button"
          disabled={!confirmed}
          onClick={apply}
        >
          确认替换人工取舍
        </button>
        <button
          className="nw-btn"
          type="button"
          onClick={() => controller.cancelPlan()}
        >
          丢弃决策计划预览
        </button>
      </div>
    </section>
  );
}

export function WritingMergePlanPanel({
  controller,
  state,
  analysis,
  save,
  feedback,
}: {
  controller: WritingMergeWorkbench;
  state: WritingMergeState;
  analysis: WritingMergeAnalysis;
  save: () => void;
  feedback: Feedback;
}) {
  function choose(files: FileList | null) {
    if (!files?.length) return;
    if (files.length !== 1) {
      feedback("一次只预览一份人工取舍计划。", true);
      return;
    }
    void controller.loadPlan(files[0]!);
  }
  return (
    <section className="nw-merge-plan" aria-label="合并人工取舍计划">
      <h2>手动保存与核对取舍计划</h2>
      <p>
        计划最多 64
        KiB，只含三份来源摘要、算法版本、条目编号和选择，不含标题、正文或本机文件名。摘要仍可能用于关联文件；SHA-256
        不证明作者或来源，也不授权写入服务器。
      </p>
      <p>
        可保存尚未解决的计划，之后需手动重新选择同一角色的三份原始文件、确认基线并分析，才可重新预览。没有自动缓存或磁盘目录发现；文件改动（包括备份时间）会使旧计划失效。
      </p>
      <div className="nw-authoring-actions">
        <button
          className="nw-btn"
          type="button"
          disabled={state.planPreparing}
          onClick={() => {
            void controller.preparePlan();
          }}
        >
          准备人工取舍计划
        </button>
        <button
          className="nw-btn"
          type="button"
          disabled={!state.planArtifact || state.planPreparing}
          onClick={save}
        >
          下载人工取舍计划
        </button>
        {state.planPreparing ? (
          <button
            className="nw-btn"
            type="button"
            onClick={() => controller.cancelPlan()}
          >
            停止计划准备
          </button>
        ) : null}
      </div>
      {state.planPreparing ? (
        <p role="status">正在生成取舍计划与校验摘要……</p>
      ) : state.planArtifact ? (
        <p role="status">人工取舍计划已准备，尚未下载。</p>
      ) : null}
      <label className="nw-writing-file">
        预览人工取舍计划文件
        <input
          type="file"
          accept=".json,application/json"
          disabled={state.planLoading}
          onChange={(event) => {
            choose(event.currentTarget.files);
            event.currentTarget.value = "";
          }}
        />
      </label>
      {state.planLoading ? (
        <>
          <p role="status">正在只读校验计划，没有改变原人工取舍……</p>
          <button
            className="nw-btn"
            type="button"
            onClick={() => controller.cancelPlan()}
          >
            停止计划读取
          </button>
        </>
      ) : null}
      {state.planPreview ? (
        <PlanPreview
          key={state.planPreview.plan.digest}
          controller={controller}
          state={state}
          analysis={analysis}
          preview={state.planPreview}
          feedback={feedback}
        />
      ) : null}
    </section>
  );
}
