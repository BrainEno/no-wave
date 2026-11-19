import { useEffect, useMemo, useRef, useState } from "react";
import { collectionCanonicalJson } from "@/lib/writing-collection.ts";
import { writingTextDifference } from "@/lib/writing-compare.ts";
import {
  MERGE_ROLES,
  writingMergeCandidateText,
  writingMergeProgress,
  type WritingMergeAnalysis,
  type WritingMergeChoice,
  type WritingMergeDecision,
  type WritingMergeRole,
  type WritingMergeUnit,
} from "@/lib/writing-merge.ts";
import {
  MERGE_REVIEW_PAGE_SIZE,
  writingMergeConflictTarget,
  writingMergeReviewPage,
  writingMergeReviewRows,
  type MergeReviewFilter,
} from "@/lib/writing-merge-review.ts";
import type { WritingMergeWorkbench } from "@/lib/writing-merge-controller.ts";
import { inspectWritingMergeStructure } from "@/lib/writing-merge-structure.ts";

export const MERGE_ROLE_LABELS = {
  base: "共同基线",
  current: "当前稿",
  incoming: "另一稿",
};
const FIELD_LABELS = {
  title: "标题",
  summary: "摘要",
  locale: "语言",
  workType: "作品类型",
};
const STATUS_LABELS = {
  same: "三份相同",
  current: "仅当前稿改动",
  incoming: "仅另一稿改动",
  agreed: "两稿改动一致",
  conflict: "需要明确取舍",
};

export function writingMergeUnitLabel(unit: WritingMergeUnit): string {
  if (unit.kind === "field") return FIELD_LABELS[unit.field];
  if (unit.kind === "root") return "正文根结构";
  if (unit.start === unit.end) return `基线第 ${unit.start} 块之后的插入区间`;
  return `基线正文第 ${unit.start + 1}–${unit.end} 块`;
}

/** Only a screen excerpt is shortened; the author can explicitly expand the complete literal value. */
export function MergeLiteral({ text }: { text: string }) {
  const [full, setFull] = useState(false);
  const excerpt = useMemo(() => writingTextDifference("", text), [text]);
  return (
    <>
      <pre className="nw-merge-literal">
        {full ? text : excerpt.inserted || "（空值／此来源没有内容块）"}
      </pre>
      {excerpt.truncated ? (
        <>
          <p>屏幕片段已截短；不影响校验或最终下载。</p>
          <button
            className="nw-btn"
            type="button"
            onClick={() => setFull((value) => !value)}
          >
            {full ? "收起完整文字" : "显示完整文字"}
          </button>
        </>
      ) : null}
    </>
  );
}

function MergeStructure({
  unit,
  role,
}: {
  unit: WritingMergeUnit;
  role: WritingMergeRole;
}) {
  const [open, setOpen] = useState(false);
  const result = useMemo(
    () => (open ? inspectWritingMergeStructure(unit, role) : null),
    [open, unit, role],
  );
  if (role === "base") return null;
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{MERGE_ROLE_LABELS[role]}相对基线的结构差异</summary>
      <p>
        只按候选值内位置诊断，路径不是段落身份，也不是可执行编辑指令。数组长度改变时不猜测后续索引对应；请看精确
        JSON 核对完整内容。
      </p>
      {result ? (
        <>
          {result.ambiguous ? (
            <p>
              正文有重复或顺序歧义，未生成逐位置结构配对，请核对整个候选 JSON。
            </p>
          ) : (
            <>
              <p>
                已检查 {result.visited} 个值，显示 {result.changes.length}{" "}
                处结构差异。
              </p>
              {result.limited ? (
                <p role="note">
                  达到 4096 个值／40
                  处差异或深度预算，诊断不完整，不能据此断言没有其他变化。
                </p>
              ) : null}
              {!result.changes.length ? (
                <p>
                  {result.limited
                    ? "预算内未见差异，不代表完整候选相同。"
                    : "此候选与基线未见结构差异。"}
                </p>
              ) : (
                <ol
                  className="nw-merge-structure"
                  aria-label={`${MERGE_ROLE_LABELS[role]}结构差异路径`}
                >
                  {result.changes.map((change) => (
                    <li key={change.path}>
                      <code>
                        {change.path} · {change.kind}
                      </code>
                      <p>基线值：</p>
                      <pre className="nw-merge-literal">
                        {change.beforeMissing
                          ? "（字段不存在）"
                          : change.before}
                      </pre>
                      <p>候选值：</p>
                      <pre className="nw-merge-literal">
                        {change.afterMissing ? "（字段不存在）" : change.after}
                      </pre>
                      {change.kind === "array-length" ? (
                        <p>
                          这里只报告数组长度，未把位置偏移误报为逐项新增／删除。
                        </p>
                      ) : null}
                      {change.truncated ? (
                        <p>
                          值片段已截短，请展开精确 JSON
                          查看完整值；输出未被截短。
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}
        </>
      ) : null}
    </details>
  );
}

function MergeCandidate({
  unit,
  role,
  choice,
  group,
  choose,
}: {
  unit: WritingMergeUnit;
  role: WritingMergeRole;
  choice: WritingMergeChoice | null;
  group: string;
  choose: (choice: WritingMergeChoice) => void;
}) {
  const [rawOpen, setRawOpen] = useState(false);
  const text = useMemo(
    () => writingMergeCandidateText(unit, role),
    [unit, role],
  );
  const baseText = useMemo(
    () => writingMergeCandidateText(unit, "base"),
    [unit],
  );
  const structuralOnly =
    text === baseText &&
    collectionCanonicalJson(unit.values[role]) !==
      collectionCanonicalJson(unit.values.base);
  return (
    <div
      className="nw-merge-candidate"
      data-selected={choice === role ? "true" : "false"}
    >
      <label className="nw-writing-check">
        <input
          type="radio"
          name={group}
          checked={choice === role}
          onChange={() => choose(role)}
        />
        {MERGE_ROLE_LABELS[role]} · {writingMergeUnitLabel(unit)}
      </label>
      {unit.kind === "body" ? (
        <p>
          {unit.values[role].length} 个内容块；选择空区间表示明确删除／不插入。
        </p>
      ) : null}
      {structuralOnly ? (
        <p className="nw-merge-warning">
          纯文本相同，但结构、格式或链接地址不同。请展开 JSON
          核对，不能只看文字判断相等。
        </p>
      ) : null}
      <MergeLiteral text={text} />
      <MergeStructure unit={unit} role={role} />
      <details onToggle={(event) => setRawOpen(event.currentTarget.open)}>
        <summary>{MERGE_ROLE_LABELS[role]}的精确 JSON</summary>
        {rawOpen ? (
          <MergeLiteral text={JSON.stringify(unit.values[role], null, 2)} />
        ) : null}
      </details>
    </div>
  );
}

export function WritingMergeReview({
  controller,
  analysis,
  decisions,
}: {
  controller: WritingMergeWorkbench;
  analysis: WritingMergeAnalysis;
  decisions: WritingMergeDecision[];
}) {
  const [filter, setFilter] = useState<MergeReviewFilter>("changed");
  const [pageIndex, setPageIndex] = useState(0);
  const [target, setTarget] = useState<{ id: string } | null>(null);
  const fields = useRef(new Map<string, HTMLFieldSetElement>());
  const progress = writingMergeProgress(analysis, decisions);
  const rows = writingMergeReviewRows(analysis, decisions, filter);
  const page = writingMergeReviewPage(rows, pageIndex);
  useEffect(() => {
    if (!target) return;
    const element = fields.current.get(target.id);
    if (element) {
      element.focus();
      element.scrollIntoView({ block: "start" });
    }
  }, [target]);

  function jump(direction: -1 | 1) {
    const id = writingMergeConflictTarget(
      analysis,
      decisions,
      target?.id ?? null,
      direction,
    );
    if (!id) return;
    const conflicts = writingMergeReviewRows(analysis, decisions, "conflicts");
    const index = conflicts.findIndex((row) => row.unit.id === id);
    if (index < 0) return;
    setFilter("conflicts");
    setPageIndex(Math.floor(index / MERGE_REVIEW_PAGE_SIZE));
    setTarget({ id });
  }

  return (
    <section className="nw-merge-review" aria-label="三方逐项审阅">
      <h2>逐项审阅与冲突取舍</h2>
      <p role="status">
        {progress.changed} 项涉及改动，{progress.conflicts} 项冲突，尚有{" "}
        {progress.unresolved} 项未解决；已明确选择 {progress.manual}{" "}
        项。筛选、翻页不会改变任何取舍。
      </p>
      <p>
        每个区间只取一个来源，保留其完整格式、链接和原有顺序，不把两段文字拼接来猜测作者意图。可以覆盖无冲突建议；重置后恢复建议，冲突则重新变为未解决。
      </p>
      <p>
        独立逐来源守恒校验通过：共同基线 {analysis.coverage.base} 块、当前稿{" "}
        {analysis.coverage.current} 块、另一稿 {analysis.coverage.incoming}{" "}
        块，均按各自原始顺序完整消费一次。该校验不证明选对基线或作者身份。
      </p>
      <div className="nw-authoring-actions">
        <label>
          合并审阅筛选
          <select
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value as MergeReviewFilter);
              setPageIndex(0);
              setTarget(null);
            }}
          >
            <option value="changed">所有涉及改动</option>
            <option value="unresolved">仅未解决冲突</option>
            <option value="conflicts">所有冲突</option>
            <option value="manual">仅人工选择</option>
            <option value="all">全部含未改动</option>
          </select>
        </label>
        <button
          className="nw-btn"
          type="button"
          disabled={!progress.unresolved}
          onClick={() => jump(-1)}
        >
          上一个未解决冲突
        </button>
        <button
          className="nw-btn"
          type="button"
          disabled={!progress.unresolved}
          onClick={() => jump(1)}
        >
          下一个未解决冲突
        </button>
        <button
          className="nw-btn"
          type="button"
          disabled={!decisions.length}
          onClick={() => controller.resetDecisions(analysis)}
        >
          清空全部人工取舍
        </button>
      </div>
      <p>
        当前显示 {rows.length ? page.start + 1 : 0}–{page.end} / {rows.length}{" "}
        项，第 {page.page + 1} / {page.pages} 页。
      </p>
      {!rows.length ? (
        <p>这个筛选下没有条目；其他条目与人工选择仍然保留。</p>
      ) : null}
      <div className="nw-merge-units">
        {page.rows.map((row) => (
          <fieldset
            key={row.unit.id}
            tabIndex={-1}
            data-merge-unit={row.unit.id}
            ref={(element) => {
              if (element) fields.current.set(row.unit.id, element);
              else fields.current.delete(row.unit.id);
            }}
          >
            <legend>
              {writingMergeUnitLabel(row.unit)} ·{" "}
              {STATUS_LABELS[row.unit.status]}
            </legend>
            {row.unit.reason === "ambiguous-order" ? (
              <p role="note" className="nw-merge-warning">
                发现重复块或块顺序变化，无法安全确定对应关系。整个正文作为一个冲突处理；不会自行对齐或同时保留两份。
              </p>
            ) : null}
            <p>
              {row.manual
                ? `人工选择：${MERGE_ROLE_LABELS[row.choice!]}`
                : row.choice
                  ? `当前建议：${MERGE_ROLE_LABELS[row.choice]}，尚可人工改选`
                  : "尚未选择，结果下载被阻止"}
            </p>
            <div className="nw-merge-candidates">
              {MERGE_ROLES.map((role) => (
                <MergeCandidate
                  key={role}
                  unit={row.unit}
                  role={role}
                  choice={row.choice}
                  group={`${analysis.key}-${row.unit.id}`}
                  choose={(choice) =>
                    controller.choose(row.unit.id, choice, analysis)
                  }
                />
              ))}
            </div>
            <button
              className="nw-btn"
              type="button"
              disabled={!row.manual}
              onClick={() => controller.choose(row.unit.id, null, analysis)}
            >
              重置此项人工取舍 · {writingMergeUnitLabel(row.unit)}
            </button>
          </fieldset>
        ))}
      </div>
      <nav className="nw-authoring-actions" aria-label="合并审阅分页">
        <button
          className="nw-btn"
          type="button"
          disabled={page.page === 0}
          onClick={() => {
            setPageIndex(page.page - 1);
            setTarget(null);
          }}
        >
          上一页审阅
        </button>
        <button
          className="nw-btn"
          type="button"
          disabled={page.page + 1 >= page.pages}
          onClick={() => {
            setPageIndex(page.page + 1);
            setTarget(null);
          }}
        >
          下一页审阅
        </button>
      </nav>
    </section>
  );
}
