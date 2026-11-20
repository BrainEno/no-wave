import { useState } from "react";
import type { WritingOverlapWorkbench } from "@/lib/writing-overlap-controller.ts";
import type {
  OverlapAnalysis,
  OverlapUnit,
} from "@/lib/writing-overlap-model.ts";
import {
  overlapOccurrences,
  overlapReviewPage,
  resolveOverlapPair,
} from "@/lib/writing-overlap-review.ts";
import { OverlapLiteral } from "./writing-overlap-literal.tsx";
import { WritingOverlapEvidence } from "./writing-overlap-evidence.tsx";
import {
  overlapMapOccurrences,
  type OverlapDocumentMap,
} from "@/lib/writing-overlap-map.ts";

function location(unit: OverlapUnit): string {
  return `${unit.document} · ${unit.path.map((part) => part + 1).join(" / ")} · ${unit.kind}`;
}
function OccurrencePicker({
  units,
  value,
  side,
  choose,
}: {
  units: OverlapUnit[];
  value: string;
  side: "左" | "右";
  choose: (id: string) => void;
}) {
  const [requested, setRequested] = useState(0);
  const page = overlapReviewPage(units, requested);
  const selected = units.find((unit) => unit.id === value);
  const inPage = page.rows.some((unit) => unit.id === value);
  return (
    <div className="nw-overlap-picker">
      <label>
        {side}侧原始段落位置
        <select
          aria-label={`${side}侧原始段落位置`}
          value={inPage ? value : ""}
          onChange={(event) => {
            if (event.target.value) choose(event.target.value);
          }}
        >
          {!inPage ? (
            <option value="">
              当前已选 {selected ? location(selected) : "（无）"}
              ；请选择本页位置
            </option>
          ) : null}
          {page.rows.map((unit) => (
            <option key={unit.id} value={unit.id}>
              {location(unit)}
            </option>
          ))}
        </select>
      </label>
      <p>
        {side}侧可选 {units.length} 处，第 {page.page + 1} / {page.pages}{" "}
        页；仅显示符合当前文稿范围的配对位置。
      </p>
      <div className="nw-authoring-actions">
        <button
          className="nw-btn"
          type="button"
          disabled={!page.page}
          onClick={() => setRequested(page.page - 1)}
        >
          上一页{side}侧位置
        </button>
        <button
          className="nw-btn"
          type="button"
          disabled={page.page + 1 === page.pages}
          onClick={() => setRequested(page.page + 1)}
        >
          下一页{side}侧位置
        </button>
        {!inPage && selected ? (
          <button
            className="nw-btn"
            type="button"
            onClick={() =>
              setRequested(
                Math.floor(units.findIndex((unit) => unit.id === value) / 12),
              )
            }
          >
            显示已选{side}侧位置
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function WritingOverlapPair({
  controller,
  analysis,
  finding,
  documentPair,
}: {
  controller: WritingOverlapWorkbench;
  analysis: OverlapAnalysis;
  finding: string;
  documentPair: { map: OverlapDocumentMap; id: string } | null;
}) {
  function occurrences(side: "left" | "right", left: string | null = null) {
    return documentPair
      ? overlapMapOccurrences(
          analysis,
          documentPair.map,
          documentPair.id,
          finding,
          side,
          left,
        )
      : overlapOccurrences(analysis, finding, side, left);
  }
  const leftUnits = occurrences("left");
  const [selection, setSelection] = useState(() => {
    const left = leftUnits[0]?.id ?? "";
    return {
      witness: analysis,
      left,
      right: left ? (occurrences("right", left)[0]?.id ?? "") : "",
    };
  });
  const [error, setError] = useState("");
  if (selection.witness !== analysis) return null;
  const rightUnits = occurrences("right", selection.left);
  function choose(side: "left" | "right", id: string) {
    try {
      const left = side === "left" ? id : selection.left;
      const allowed = occurrences("right", left);
      const right =
        side === "right"
          ? id
          : allowed.some((unit) => unit.id === selection.right)
            ? selection.right
            : (allowed[0]?.id ?? "");
      if (!allowed.some((unit) => unit.id === right))
        throw new Error("所选右侧位置不属于当前限定。");
      controller.pair(analysis, finding, left, right);
      setSelection({ witness: analysis, left, right });
      setError("");
    } catch {
      setError(
        "来源、文字组或位置已变化；没有猜测或打开其他段落，请重新分析。",
      );
    }
  }
  // A source/condition change unmounts this panel; an old event still needs the controller witness.
  const pair = resolveOverlapPair(
    analysis,
    finding,
    selection.left,
    selection.right,
  );
  const difference = pair.difference;
  return (
    <section className="nw-overlap-pair" aria-label="重复候选原文核对">
      <h3>核对原始段落，不执行替换</h3>
      <div className="nw-overlap-columns">
        <OccurrencePicker
          units={leftUnits}
          value={selection.left}
          side="左"
          choose={(id) => choose("left", id)}
        />
        <OccurrencePicker
          key={selection.left}
          units={rightUnits}
          value={selection.right}
          side="右"
          choose={(id) => choose("right", id)}
        />
      </div>
      <p>
        原始文字{pair.rawEqual ? "完全相同" : "不同"}；富文本节点序列化
        {pair.structuralEqual
          ? "完全相同（仅忽略对象键顺序）"
          : "不同，可能涉及格式、链接或节点类型"}
        。这不是语义、作者或权限判断。
      </p>
      <div className="nw-overlap-columns">
        <OverlapLiteral
          key={`${selection.left}:text`}
          label="左侧原始文字"
          text={pair.left.text}
        />
        <OverlapLiteral
          key={`${selection.right}:text`}
          label="右侧原始文字"
          text={pair.right.text}
        />
      </div>
      {!difference.textEqual ? (
        <section
          aria-label="原文最小变更区间"
          className="nw-writing-difference"
        >
          <h4>有界文字差异预览</h4>
          <p>
            左侧：{difference.prefix}
            <del>{difference.removed}</del>
            {difference.suffix}
          </p>
          <p>
            右侧：{difference.prefix}
            <ins>{difference.inserted}</ins>
            {difference.suffix}
          </p>
          {difference.truncated ? (
            <p>
              每侧仅预览前 1200 个 UTF-16
              代码单元以内的完整字形，不把截断点当作真实结尾；请用上方分页核对后文。
            </p>
          ) : null}
        </section>
      ) : null}
      <details key={`${selection.left}:${selection.right}`}>
        <summary>只读查看这两处的富文本节点 JSON</summary>
        <p>
          仅字面展示，不执行
          HTML，也不请求其中的链接和图片。节点数据留在本页内存，不进入报告。
        </p>
        <div className="nw-overlap-columns">
          <OverlapLiteral label="左侧节点 JSON" text={pair.left.structure} />
          <OverlapLiteral label="右侧节点 JSON" text={pair.right.structure} />
        </div>
      </details>
      <WritingOverlapEvidence
        key={`evidence:${selection.left}:${selection.right}`}
        controller={controller}
        analysis={analysis}
        finding={finding}
        left={selection.left}
        right={selection.right}
      />
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
