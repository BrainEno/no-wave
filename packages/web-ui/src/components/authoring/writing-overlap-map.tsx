import { useState } from "react";
import {
  overlapMapCells,
  type OverlapDocumentMap,
} from "@/lib/writing-overlap-map.ts";
import { overlapReviewPage } from "@/lib/writing-overlap-review.ts";

export function WritingOverlapMap({
  map,
  selected,
  choose,
}: {
  map: OverlapDocumentMap;
  selected: string | null;
  choose: (pair: string | null) => void;
}) {
  const [document, setDocument] = useState("all"),
    [order, setOrder] = useState<"source" | "pairs" | "unreviewed">("source"),
    [requested, setRequested] = useState(0);
  const cells = overlapMapCells(map, { document, order }),
    page = overlapReviewPage(cells, requested),
    active = map.cells.find((cell) => cell.id === selected);
  return (
    <section aria-label="已列候选的文稿对概览">
      <h3>已列候选的文稿对概览</h3>
      <p>
        按文件内编号汇总，不比较标题、作者或来源权属。全局已列候选涉及{" "}
        {map.pairs}{" "}
        个位置配对；使用计数组合，不展开所有位置对。只概括有限的已列候选，不代表未列单元没有重复。
      </p>
      <details>
        <summary>按文稿对查看已列候选</summary>
        <ul aria-label="各篇已列候选涉及范围">
          {map.documents.map((item) => (
            <li key={item.id}>
              {item.id}：合格 {item.eligible} 个单元，其中 {item.listed}{" "}
              个出现在已列候选的有效位置配对里；涉及 {item.findings}{" "}
              项，尚未核对 {item.unreviewed} 项；其他文稿伙伴{" "}
              {item.peers.join("、") || "（无已列伙伴）"}。
            </li>
          ))}
        </ul>
        <div className="nw-collection-filter-grid">
          <label>
            概览涉及文稿
            <select
              aria-label="概览涉及文稿"
              value={document}
              onChange={(event) => {
                setDocument(event.target.value);
                setRequested(0);
              }}
            >
              <option value="all">所有文稿</option>
              {map.documents.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.id}
                </option>
              ))}
            </select>
          </label>
          <label>
            文稿对排序
            <select
              aria-label="文稿对排序"
              value={order}
              onChange={(event) => {
                setOrder(event.target.value as typeof order);
                setRequested(0);
              }}
            >
              <option value="source">按文件内编号顺序</option>
              <option value="pairs">按已列位置配对数量</option>
              <option value="unreviewed">按尚未核对候选数量</option>
            </select>
          </label>
        </div>
        <p>
          概览筛选后 {cells.length} 对，第 {page.page + 1} / {page.pages}{" "}
          页。一个候选可以涉及多个文稿对，各对的候选数量不能直接相加为全局项数。
        </p>
        <ul className="nw-collection-rows" aria-label="文稿对候选概览">
          {page.rows.map((cell) => (
            <li key={cell.id}>
              <p>
                {cell.left} / {cell.right}
                {cell.left === cell.right
                  ? "（同篇内部）"
                  : ""}：同文字位置配对 {cell.exactPairs} / 近似位置配对{" "}
                {cell.nearPairs}；候选 {cell.findings.length} 项，尚未核对{" "}
                {cell.unreviewed} 项，有意重复 {cell.intentional}{" "}
                项，需要后续检查 {cell.followUp} 项。
              </p>
              <button
                className="nw-btn"
                type="button"
                onClick={() => choose(cell.id)}
              >
                只显示文稿对 {cell.left} / {cell.right}
              </button>
            </li>
          ))}
        </ul>
        {!cells.length ? (
          <p>当前概览没有已列候选的文稿对；请仍核对分析覆盖与缺口。</p>
        ) : null}
        <div className="nw-authoring-actions">
          <button
            className="nw-btn"
            type="button"
            disabled={!page.page}
            onClick={() => setRequested(page.page - 1)}
          >
            上一页文稿对
          </button>
          <button
            className="nw-btn"
            type="button"
            disabled={page.page + 1 === page.pages}
            onClick={() => setRequested(page.page + 1)}
          >
            下一页文稿对
          </button>
        </div>
      </details>
      {active ? (
        <div>
          <p role="status">
            候选列表及左右原文位置仅限 {active.left} / {active.right}
            ；筛选不改变其他文稿的标记或全局无正文报告。
          </p>
          <button className="nw-btn" type="button" onClick={() => choose(null)}>
            取消文稿对限定
          </button>
        </div>
      ) : null}
    </section>
  );
}
