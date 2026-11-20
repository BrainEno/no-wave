import { useMemo, useState } from "react";
import type {
  ParallelWorkbenchState,
  WritingParallelWorkbench,
} from "@/lib/writing-parallel-controller.ts";
import type {
  ParallelAnalysis,
  ParallelAlignmentType,
  ParallelFindingKind,
} from "@/lib/writing-parallel-model.ts";
import {
  parallelRows,
  type ParallelReviewMark,
  type ParallelReviewRow,
} from "@/lib/writing-parallel-review.ts";
import { WritingParallelExplanation } from "./writing-parallel-explanation.tsx";
import { PARALLEL_KIND_LABELS } from "./writing-parallel-profile.tsx";

export type ParallelMarkState = ParallelReviewMark | "unreviewed";

const MARK_LABELS: Record<ParallelMarkState, string> = {
  unreviewed: "尚未核对",
  intentional: "有意空缺/保留",
  "check-later": "需后续校对",
};

const TYPE_LABELS: Record<ParallelAlignmentType, string> = {
  "exact-match": "完全匹配",
  "strong-align": "强对齐",
  "partial-align": "部分对齐",
  "left-gap": "左侧单边空缺",
  "right-gap": "右侧单边空缺",
  mismatch: "不匹配",
};

export function WritingParallelReview({
  controller,
  analysis,
  marks,
  explanation,
  selectedPairId,
  onPairChange,
}: {
  controller: WritingParallelWorkbench;
  analysis: ParallelAnalysis;
  marks: Record<string, ParallelReviewMark>;
  explanation: ParallelWorkbenchState["explanation"];
  selectedPairId?: string;
  onPairChange?: (pairId: string) => void;
}) {
  const [filterType, setFilterType] = useState<ParallelAlignmentType | "all">("all");
  const [filterFinding, setFilterFinding] = useState<ParallelFindingKind | "all">("all");
  const [filterMark, setFilterMark] = useState<ParallelMarkState | "all">("all");
  const [activePairId, setActivePairId] = useState<string>(
    selectedPairId ?? analysis.pairs[0]?.id ?? "all",
  );
  const [requestedPage, setPage] = useState(0);
  const [selectedRow, setSelectedRow] = useState<ParallelReviewRow | null>(null);

  const filters = useMemo(
    () => ({
      pairId: activePairId === "all" ? undefined : activePairId,
      type: filterType,
      findingKind: filterFinding,
      markState: filterMark,
    }),
    [activePairId, filterType, filterFinding, filterMark],
  );

  const rows = useMemo(() => parallelRows(analysis, filters, marks), [analysis, filters, marks]);

  const pageSize = 20;
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(requestedPage, totalPages - 1);
  const visibleRows = rows.slice(currentPage * pageSize, (currentPage + 1) * pageSize);

  function handleSelectRow(row: ParallelReviewRow) {
    setSelectedRow(row);
  }

  function handleMark(state: ParallelReviewMark | null) {
    if (!selectedRow) return;
    controller.setMark(selectedRow.rowId, state);
  }

  function handleExplain(row: ParallelReviewRow) {
    controller.explain(row.pairId, row.rowId);
  }

  return (
    <section aria-label="双语平行对照审阅表格" className="nw-parallel-detail">
      <h3>平行对齐逐项审阅</h3>
      <p>
        按行对照左右两侧内容块。标记仅保存在当前浏览器内存，脱敏报告仅导出审阅状态汇总，不导出任何正文文字。
      </p>

      {/* Controls and filters */}
      <div className="nw-authoring-actions">
        {analysis.pairs.length > 1 ? (
          <label>
            文稿对切换
            <select
              aria-label="选择审阅文稿对"
              value={activePairId}
              onChange={(e) => {
                const next = e.target.value;
                setActivePairId(next);
                onPairChange?.(next);
                setPage(0);
                setSelectedRow(null);
              }}
            >
              <option value="all">全部对照文稿对</option>
              {analysis.pairs.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id} ({p.leftDocument} ↔ {p.rightDocument})
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <label>
          对齐类型
          <select
            aria-label="对齐类型过滤"
            value={filterType}
            onChange={(e) => {
              setFilterType(e.target.value as ParallelAlignmentType | "all");
              setPage(0);
            }}
          >
            <option value="all">全部对齐类型</option>
            <option value="strong-align">仅强对齐</option>
            <option value="partial-align">仅部分对齐</option>
            <option value="left-gap">仅左侧缺口</option>
            <option value="right-gap">仅右侧缺口</option>
          </select>
        </label>

        <label>
          不对称异常
          <select
            aria-label="不对称过滤"
            value={filterFinding}
            onChange={(e) => {
              setFilterFinding(e.target.value as ParallelFindingKind | "all");
              setPage(0);
            }}
          >
            <option value="all">全部异常状态</option>
            <option value="missing-block">仅段落缺失缺口</option>
            <option value="heading-level-drift">仅标题层级漂移</option>
            <option value="link-parity-mismatch">仅外链不对称</option>
            <option value="image-parity-mismatch">仅图片不对称</option>
            <option value="extreme-ratio">仅长短比例极端</option>
          </select>
        </label>

        <label>
          人工审阅状态
          <select
            aria-label="审阅标记过滤"
            value={filterMark}
            onChange={(e) => {
              setFilterMark(e.target.value as ParallelMarkState | "all");
              setPage(0);
            }}
          >
            <option value="all">全部标记状态</option>
            <option value="unreviewed">尚未核对</option>
            <option value="intentional">有意空缺/保留</option>
            <option value="check-later">需后续检查</option>
          </select>
        </label>
      </div>

      <p role="status">
        符合条件共 {rows.length} 行；当前第 {currentPage + 1} / {totalPages} 页。
      </p>

      {/* Main Review Table */}
      <div className="nw-parallel-scroll" role="group" tabIndex={0} aria-label="平行对照审阅行表格">
        <table>
          <caption>双语对齐逐行明细</caption>
          <thead>
            <tr>
              <th scope="col">行号 / 状态</th>
              <th scope="col">左侧内容片段（原稿）</th>
              <th scope="col">右侧内容片段（译稿/平行稿）</th>
              <th scope="col">异常观察</th>
              <th scope="col">人工审阅标记</th>
              <th scope="col">审阅操作</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => (
              <tr
                key={row.rowId}
                className={
                  row.type === "left-gap" || row.type === "right-gap"
                    ? "nw-parallel-row-gap"
                    : undefined
                }
              >
                <th scope="row">
                  <code>#{row.alignmentIndex}</code>
                  <br />
                  <span className="nw-parallel-badge">
                    {TYPE_LABELS[row.type as ParallelAlignmentType] ?? row.type}
                  </span>
                </th>
                <td>
                  <small>
                    [{row.leftUnit?.kind ?? "无"}
                    {row.leftUnit?.headingLevel ? ` H${row.leftUnit.headingLevel}` : ""}]
                  </small>
                  <p className="nw-parallel-snippet">
                    {row.leftUnit?.snippet || "（该侧内容缺失 / 空缺）"}
                  </p>
                </td>
                <td>
                  <small>
                    [{row.rightUnit?.kind ?? "无"}
                    {row.rightUnit?.headingLevel ? ` H${row.rightUnit.headingLevel}` : ""}]
                  </small>
                  <p className="nw-parallel-snippet">
                    {row.rightUnit?.snippet || "（该侧内容缺失 / 空缺）"}
                  </p>
                </td>
                <td>
                  {row.findings.length > 0 ? (
                    row.findings.map((f) => (
                      <span key={f.id} className="nw-parallel-badge">
                        {PARALLEL_KIND_LABELS[f.kind]}
                      </span>
                    ))
                  ) : (
                    <span>正常匹配</span>
                  )}
                </td>
                <td>
                  <span className="nw-parallel-badge">{MARK_LABELS[row.mark]}</span>
                </td>
                <td>
                  <button
                    className="nw-btn"
                    type="button"
                    onClick={() => handleSelectRow(row)}
                  >
                    核对与标记
                  </button>
                  <button
                    className="nw-btn"
                    type="button"
                    onClick={() => handleExplain(row)}
                  >
                    算法解释
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination Controls */}
      {totalPages > 1 ? (
        <div className="nw-authoring-actions" style={{ marginTop: 12 }}>
          <button
            className="nw-btn"
            type="button"
            disabled={currentPage <= 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            上一页
          </button>
          <span>
            第 {currentPage + 1} 页 / 共 {totalPages} 页
          </span>
          <button
            className="nw-btn"
            type="button"
            disabled={currentPage >= totalPages - 1}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
          >
            下一页
          </button>
        </div>
      ) : null}

      {/* Selected Row Detail & Marking Panel */}
      {selectedRow ? (
        <section aria-label="单行对照核验详情" className="nw-parallel-detail">
          <h4>核验当前行：{selectedRow.rowId}</h4>
          <p>
            对齐类型：<strong>{TYPE_LABELS[selectedRow.type as ParallelAlignmentType] ?? selectedRow.type}</strong> · 得分：{selectedRow.score}
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div>
              <h5>左侧原文 ({selectedRow.leftUnit?.kind ?? "空缺"})</h5>
              <div className="nw-parallel-snippet">
                {selectedRow.leftUnit?.snippet || "（此侧缺失对应块）"}
              </div>
              {selectedRow.leftUnit ? (
                <small>
                  字符数: {selectedRow.leftUnit.characterCount} · 外链:{" "}
                  {selectedRow.leftUnit.links.length} · 图片:{" "}
                  {selectedRow.leftUnit.imageCount}
                </small>
              ) : null}
            </div>
            <div>
              <h5>右侧原文 ({selectedRow.rightUnit?.kind ?? "空缺"})</h5>
              <div className="nw-parallel-snippet">
                {selectedRow.rightUnit?.snippet || "（此侧缺失对应块）"}
              </div>
              {selectedRow.rightUnit ? (
                <small>
                  字符数: {selectedRow.rightUnit.characterCount} · 外链:{" "}
                  {selectedRow.rightUnit.links.length} · 图片:{" "}
                  {selectedRow.rightUnit.imageCount}
                </small>
              ) : null}
            </div>
          </div>

          <div style={{ marginTop: 16 }}>
            <h5>人工审阅状态设定</h5>
            <div className="nw-authoring-actions">
              <button
                className="nw-btn"
                type="button"
                onClick={() => handleMark("intentional")}
              >
                设为有意空缺/保留
              </button>
              <button
                className="nw-btn"
                type="button"
                onClick={() => handleMark("check-later")}
              >
                设为需后续检查
              </button>
              <button
                className="nw-btn"
                type="button"
                onClick={() => handleMark(null)}
              >
                重置为未核对
              </button>
              <button
                className="nw-btn"
                type="button"
                onClick={() => setSelectedRow(null)}
              >
                关闭核验面板
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {/* Explanation drawer if active */}
      {explanation ? (
        <WritingParallelExplanation
          state={explanation}
          clear={() => controller.clearExplanation()}
        />
      ) : null}
    </section>
  );
}
