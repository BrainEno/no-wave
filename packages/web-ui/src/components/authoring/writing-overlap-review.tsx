import { useEffect, useMemo, useRef, useState } from "react";
import type { WritingOverlapWorkbench } from "@/lib/writing-overlap-controller.ts";
import type { OverlapAnalysis } from "@/lib/writing-overlap-model.ts";
import {
  DEFAULT_OVERLAP_FILTER,
  overlapReviewPage,
  overlapReviewRows,
  type OverlapFilter,
  type OverlapMark,
} from "@/lib/writing-overlap-review.ts";
import { WritingOverlapPair } from "./writing-overlap-pair.tsx";
import {
  mapWritingOverlap,
  overlapMapRows,
} from "@/lib/writing-overlap-map.ts";
import { WritingOverlapMap } from "./writing-overlap-map.tsx";

export function WritingOverlapReview({
  controller,
  analysis,
  marks,
}: {
  controller: WritingOverlapWorkbench;
  analysis: OverlapAnalysis;
  marks: OverlapMark[];
}) {
  const [filter, setFilter] = useState<OverlapFilter>({
    ...DEFAULT_OVERLAP_FILTER,
  });
  const [requested, setRequested] = useState(0);
  const [active, setActive] = useState<{
    witness: OverlapAnalysis;
    id: string;
  } | null>(null);
  const detail = useRef<HTMLDivElement>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const documentMap = useMemo(
    () =>
      mapWritingOverlap(
        analysis,
        marks,
        controller
          .getSnapshot()
          .input.documents.map((document) => document.key),
      ),
    [analysis, marks, controller],
  );
  const [pair, setPair] = useState<{
    witness: OverlapAnalysis;
    id: string;
  } | null>(null);
  const pairId = pair?.witness === analysis ? pair.id : null;
  const sourceRows = overlapReviewRows(analysis, marks, filter);
  const rows = pairId
      ? overlapMapRows(analysis, documentMap, pairId, sourceRows)
      : sourceRows,
    page = overlapReviewPage(rows, requested);
  const documents = [...new Set(analysis.units.map((unit) => unit.document))];
  const selected = active?.witness === analysis ? active.id : null;
  useEffect(() => {
    if (selected) detail.current?.focus();
  }, [selected]);
  function changeFilter(next: OverlapFilter) {
    setFilter(next);
    setRequested(0);
    setActive(null);
    setPair(null);
  }
  function choosePair(id: string | null) {
    if (id) overlapMapRows(analysis, documentMap, id, sourceRows);
    setPair(id ? { witness: analysis, id } : null);
    setFilter({ ...DEFAULT_OVERLAP_FILTER });
    setRequested(0);
    setActive(null);
  }
  function changePage(value: number) {
    setRequested(value);
    setActive(null);
  }
  function markPage(verdict: OverlapMark["verdict"] | null) {
    const ids = new Set(page.rows.map((row) => row.finding.id));
    const current = controller.getSnapshot();
    const next = current.marks.filter((mark) => !ids.has(mark.finding));
    if (verdict !== null)
      for (const id of ids) next.push({ finding: id, verdict });
    controller.setMarks(analysis, next);
  }
  function close() {
    setActive(null);
    if (selected) triggers.current.get(selected)?.focus();
  }
  return (
    <section className="nw-overlap-review" aria-label="本机重复候选审阅">
      <h2>人工核对与临时标记</h2>
      <p role="status">
        全局列出 {analysis.exact.length + analysis.near.length} 项；已标记{" "}
        {marks.length} 项，尚未核对{" "}
        {analysis.exact.length + analysis.near.length - marks.length}{" "}
        项。标记不修改任何文稿，不代表去重建议。
      </p>
      <WritingOverlapMap
        map={documentMap}
        selected={pairId}
        choose={choosePair}
      />
      <div className="nw-collection-filter-grid">
        <label>
          重复候选类型
          <select
            aria-label="重复候选类型"
            value={filter.kind}
            onChange={(event) =>
              changeFilter({
                ...filter,
                kind: event.target.value as OverlapFilter["kind"],
              })
            }
          >
            <option value="all">所有类型</option>
            <option value="exact">同文字组</option>
            <option value="near">近似候选</option>
          </select>
        </label>
        <label>
          重复审阅状态
          <select
            aria-label="重复审阅状态"
            value={filter.status}
            onChange={(event) =>
              changeFilter({
                ...filter,
                status: event.target.value as OverlapFilter["status"],
              })
            }
          >
            <option value="all">所有状态</option>
            <option value="unreviewed">尚未核对</option>
            <option value="follow-up">需要后续检查</option>
            <option value="intentional">有意重复</option>
          </select>
        </label>
        <label>
          涉及本机文稿
          <select
            aria-label="涉及本机文稿"
            value={filter.document}
            onChange={(event) =>
              changeFilter({ ...filter, document: event.target.value })
            }
          >
            <option value="all">所有文稿</option>
            {documents.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p>
        筛选只改变列表，不会改变隐藏项目的标记、计算覆盖或报告内容。本页显示{" "}
        {page.rows.length} / 筛选后 {rows.length} 项，第 {page.page + 1} /{" "}
        {page.pages} 页。
      </p>
      <div className="nw-authoring-actions" aria-label="本页显式批量审阅">
        <button
          className="nw-btn"
          type="button"
          disabled={!page.rows.length}
          onClick={() => markPage("follow-up")}
        >
          将本页标记为需要后续检查
        </button>
        <button
          className="nw-btn"
          type="button"
          disabled={!page.rows.length}
          onClick={() => markPage("intentional")}
        >
          将本页标记为有意重复
        </button>
        <button
          className="nw-btn"
          type="button"
          disabled={!page.rows.length}
          onClick={() => markPage(null)}
        >
          清除本页标记
        </button>
      </div>
      <ol className="nw-collection-rows" aria-label="重复段落候选清单">
        {page.rows.map((row) => (
          <li key={row.finding.id}>
            <h3>
              {row.finding.kind === "exact" ? "同文字组" : "近似候选"}{" "}
              {row.finding.id}
            </h3>
            <p>
              涉及 {row.occurrences} 处 / {row.documents} 篇；当前范围内{" "}
              {row.finding.pairs} 个位置配对。每处位置仍独立保留。
            </p>
            {row.finding.kind === "exact" ? (
              <p>
                {row.finding.rawVariants} 种原始文字 /{" "}
                {row.finding.structuralVariants}{" "}
                种富文本节点；“同文字”仅按当前文字模式比较，不是节点或语义等价。
              </p>
            ) : (
              <p>
                五字符片段集合 Jaccard{" "}
                {(row.finding.basisPoints / 100).toFixed(2)}%（交集{" "}
                {row.finding.intersection} / 并集 {row.finding.union}）。即使
                100% 也不等于原始文字相同。
              </p>
            )}
            <div className="nw-authoring-actions">
              <button
                className="nw-btn"
                type="button"
                ref={(node) => {
                  if (node) triggers.current.set(row.finding.id, node);
                  else triggers.current.delete(row.finding.id);
                }}
                onClick={() =>
                  setActive({ witness: analysis, id: row.finding.id })
                }
              >
                只读核对 {row.finding.id}
              </button>
              <label>
                标记 {row.finding.id}
                <select
                  aria-label={`标记 ${row.finding.id}`}
                  value={row.verdict ?? ""}
                  onChange={(event) =>
                    controller.mark(
                      analysis,
                      row.finding.id,
                      event.target.value
                        ? (event.target.value as OverlapMark["verdict"])
                        : null,
                    )
                  }
                >
                  <option value="">尚未核对</option>
                  <option value="follow-up">需要后续检查</option>
                  <option value="intentional">有意重复</option>
                </select>
              </label>
            </div>
          </li>
        ))}
      </ol>
      {!rows.length ? (
        <p>
          当前筛选下没有已列出的候选；其他标记仍然保留，这不证明全文没有重复。
        </p>
      ) : null}
      <div className="nw-authoring-actions">
        <button
          className="nw-btn"
          type="button"
          disabled={!page.page}
          onClick={() => changePage(page.page - 1)}
        >
          上一页重复候选
        </button>
        <button
          className="nw-btn"
          type="button"
          disabled={page.page + 1 === page.pages}
          onClick={() => changePage(page.page + 1)}
        >
          下一页重复候选
        </button>
      </div>
      {selected ? (
        <div className="nw-overlap-detail" ref={detail} tabIndex={-1}>
          <button className="nw-btn" type="button" onClick={close}>
            关闭原文核对并返回条目
          </button>
          <WritingOverlapPair
            key={`${selected}:${pairId ?? "all"}`}
            controller={controller}
            analysis={analysis}
            finding={selected}
            documentPair={pairId ? { map: documentMap, id: pairId } : null}
          />
        </div>
      ) : null}
    </section>
  );
}
