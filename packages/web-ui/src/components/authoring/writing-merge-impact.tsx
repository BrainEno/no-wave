import { useMemo, useState } from "react";
import {
  reviewWritingMergeImpact,
  writingMergeImpactRows,
  type WritingMergeImpactFilter,
} from "@/lib/writing-merge-impact.ts";
import { writingMergeReviewPage } from "@/lib/writing-merge-review.ts";
import {
  MERGE_ROLES,
  type PreparedWritingMerge,
  type WritingMergeAnalysis,
  type WritingMergeDecision,
  type WritingMergeRole,
  type WritingMergeUnit,
} from "@/lib/writing-merge.ts";
import {
  MERGE_ROLE_LABELS,
  MergeLiteral,
  writingMergeUnitLabel,
} from "./writing-merge-review.tsx";

type Props = {
  analysis: WritingMergeAnalysis;
  decisions: WritingMergeDecision[];
  prepared: PreparedWritingMerge;
};

function ImpactCandidate({
  unit,
  role,
  selected,
}: {
  unit: WritingMergeUnit;
  role: WritingMergeRole;
  selected: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        {MERGE_ROLE_LABELS[role]}
        {selected ? "已采用" : "未采用"}候选 · {writingMergeUnitLabel(unit)}
      </summary>
      {open ? (
        <>
          <p>
            以下是这个区间候选的精确
            JSON，仅文字，不加载链接或图片。未采用候选不同，不代表其中每个字都已从文稿删除；请核对完整结果。
          </p>
          <MergeLiteral text={JSON.stringify(unit.values[role], null, 2)} />
        </>
      ) : null}
    </details>
  );
}

function ImpactContent({ analysis, decisions, prepared }: Props) {
  const report = useMemo(
    () => reviewWritingMergeImpact(analysis, decisions, prepared),
    [analysis, decisions, prepared],
  );
  const [filter, setFilter] = useState<WritingMergeImpactFilter>("all");
  const [requested, setRequested] = useState(0);
  const visible = writingMergeImpactRows(report, filter);
  const page = writingMergeReviewPage(visible, requested);
  return (
    <section aria-label="取舍影响核对">
      <h3>未采用改动与来源完整对照</h3>
      <p>
        当前稿有 {report.unadopted.current} 项已改动候选未被采用，另一稿有{" "}
        {report.unadopted.incoming}{" "}
        项。按区间与元数据计数，同一项可能同时涉及两稿；不是丢失字数或作者意图判断。
      </p>
      <p>
        人工覆盖无冲突建议 {report.overrides} 项，冲突取共同基线{" "}
        {report.baseConflicts} 项，零块取舍 {report.emptySelections}{" "}
        项。重复或顺序歧义 {report.ambiguous}{" "}
        项仍按完整正文核对，不生成段落身份配对。
      </p>
      <dl className="nw-collection-statistics">
        {MERGE_ROLES.map((role) => {
          const source = report.sources[role];
          return (
            <div key={role}>
              <dt>{MERGE_ROLE_LABELS[role]}与结果对照</dt>
              <dd>
                <p>
                  来源 {source.blocks} 块；
                  {source.bodyEqual
                    ? "完整正文（含格式/顺序）完全一致"
                    : "完整正文（含格式/顺序）不同"}
                  。
                </p>
                <p>
                  根属性{source.rootEqual ? "完全一致" : "不同"}；
                  {source.fields.length
                    ? `不同元数据：${source.fields.map((field) => writingMergeUnitLabel(analysis.units.find((unit) => unit.kind === "field" && unit.field === field)!)).join("、")}`
                    : "四个元数据字段完全一致"}
                  。
                </p>
              </dd>
            </div>
          );
        })}
      </dl>
      <p>
        这是对本机已校验来源候选与实际下载内容的精确核对，不证明选对共同基线、没有文意遗漏或服务器已保存。下面筛选只改变清单，不改变任何取舍或下载内容。
      </p>
      <label>
        取舍影响筛选
        <select
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value as WritingMergeImpactFilter);
            setRequested(0);
          }}
        >
          <option value="all">全部需核对项</option>
          <option value="conflicts">原冲突项</option>
          <option value="overrides">覆盖无冲突建议</option>
          <option value="empty">零块取舍</option>
        </select>
      </label>
      <p role="status">
        当前清单 {visible.length} 项，第 {page.page + 1} / {page.pages}{" "}
        页；每页最多 12 项，隐藏条目仍包含在上述总数和来源对照中。
      </p>
      {!visible.length ? (
        <p>此筛选下没有需核对的候选；这不证明文意没有遗漏。</p>
      ) : (
        <ol aria-label="未采用候选核对清单">
          {page.rows.map((row) => {
            const item = report.byUnit.get(row.unit.id)!;
            return (
              <li key={item.unit.id}>
                <h4>{writingMergeUnitLabel(item.unit)}</h4>
                <p>
                  {item.manual ? "人工选择" : "无冲突建议"}：
                  {MERGE_ROLE_LABELS[item.choice]}。
                  {item.selectedBlocks === null
                    ? "此项不是正文区间。"
                    : `采用 ${item.selectedBlocks} 个正文块。`}
                </p>
                {item.override ? (
                  <p className="nw-merge-warning">
                    人工覆盖了无冲突建议，请核对被舍弃的分支改动。
                  </p>
                ) : null}
                {item.baseConflict ? (
                  <p className="nw-merge-warning">
                    冲突回到共同基线，未采用两稿在此区间的不同候选。
                  </p>
                ) : null}
                {item.empty ? (
                  <p className="nw-merge-warning">
                    零块表示删除此区间／不插入，不是空白占位段落。
                  </p>
                ) : null}
                {item.unit.reason === "ambiguous-order" ? (
                  <p>这里仍是完整正文候选，不按重复或移动段落猜对应。</p>
                ) : null}
                <ImpactCandidate unit={item.unit} role={item.choice} selected />
                {item.unadopted.map((role) => (
                  <ImpactCandidate
                    key={role}
                    unit={item.unit}
                    role={role}
                    selected={false}
                  />
                ))}
              </li>
            );
          })}
        </ol>
      )}
      <div className="nw-authoring-actions">
        <button
          className="nw-btn"
          type="button"
          disabled={page.page === 0}
          onClick={() => setRequested(page.page - 1)}
        >
          上一页取舍影响
        </button>
        <button
          className="nw-btn"
          type="button"
          disabled={page.page + 1 >= page.pages}
          onClick={() => setRequested(page.page + 1)}
        >
          下一页取舍影响
        </button>
      </div>
    </section>
  );
}

export function WritingMergeImpactPanel(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>核对未采用改动与来源完整对照</summary>
      {open ? <ImpactContent {...props} /> : null}
    </details>
  );
}
