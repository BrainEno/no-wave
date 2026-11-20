import { useState } from "react";
import type { TermsAnalysis } from "@/lib/writing-terms-model.ts";
import type { TermsFilter, TermsSummary } from "@/lib/writing-terms-review.ts";
const states = {
  unseen: "未出现（或未覆盖）",
  preferred: "仅偏好词",
  alternatives: "仅变体",
  mixed: "偏好词与变体并存",
};
export function WritingTermsDistribution({
  analysis,
  summary,
  filter,
  choose,
}: {
  analysis: TermsAnalysis;
  summary: TermsSummary;
  filter: TermsFilter;
  choose: (filter: TermsFilter) => void;
}) {
  const [requested, setRequested] = useState(0);
  const catalog = analysis.catalog,
    pages = Math.max(1, Math.ceil(catalog.relations.length / 20)),
    page = Math.min(requested, pages - 1);
  return (
    <section aria-label="术语与文稿分布">
      <h3>词组 / 文稿分布</h3>
      <p>
        全局 {summary.claims} 个命中主张 / {summary.locations} 个不同精确位置，
        {summary.overlappingClaims}{" "}
        个主张与其他命中重叠。同形词条可能共用位置，重叠团的传递连接不表示每一对都直接相交。
        {!summary.complete
          ? "计数仅为已覆盖前缀的下界；零不是全文未出现。"
          : "仅覆盖当前字面规则与正文范围。"}
      </p>
      <div
        className="nw-terms-table"
        tabIndex={0}
        role="group"
        aria-label="可横向滚动的术语表格"
      >
        <table>
          <caption>各篇全局分布（不受列表筛选影响）</caption>
          <thead>
            <tr>
              <th scope="col">文稿</th>
              <th scope="col">主张 / 位置</th>
              <th scope="col">术语组 / 合格单元</th>
              <th scope="col">尚未核对</th>
              <th scope="col">查看</th>
            </tr>
          </thead>
          <tbody>
            {summary.documents.map((document) => (
              <tr key={document.id}>
                <th scope="row">{document.id}</th>
                <td>
                  {document.claims} / {document.locations}
                </td>
                <td>
                  {document.ruleCount} / {document.units}
                </td>
                <td>{document.unreviewed}</td>
                <td>
                  <button
                    className="nw-btn"
                    type="button"
                    onClick={() => choose({ ...filter, document: document.id })}
                  >
                    筛选文稿 {document.id}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div
        className="nw-terms-table"
        tabIndex={0}
        role="group"
        aria-label="可横向滚动的术语表格"
      >
        <table>
          <caption>各术语组全局分布（偏好不等于正确）</caption>
          <thead>
            <tr>
              <th scope="col">词组与状态</th>
              <th scope="col">偏好 / 变体主张</th>
              <th scope="col">位置 / 文稿数</th>
              <th scope="col">未核对</th>
              <th scope="col">查看</th>
            </tr>
          </thead>
          <tbody>
            {summary.groups.map((group, ordinal) => (
              <tr key={group.rule}>
                <th scope="row">
                  {group.rule} ·{" "}
                  <bdi>{analysis.recipe.rules[ordinal]!.preferred}</bdi>
                  <br />
                  {states[group.state]}
                </th>
                <td>
                  {group.preferred} / {group.alternatives}
                </td>
                <td>
                  {group.locations} / {group.documents.length}
                </td>
                <td>{group.unreviewed}</td>
                <td>
                  <button
                    className="nw-btn"
                    type="button"
                    onClick={() =>
                      choose({ ...filter, rule: group.rule, variant: "all" })
                    }
                  >
                    筛选词组 {group.rule}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {filter.rule !== "all" ? (
        <div
          className="nw-terms-table"
          tabIndex={0}
          role="group"
          aria-label="可横向滚动的术语表格"
        >
          <table>
            <caption>所选词组 {filter.rule} 在全部文稿中的格子（含零）</caption>
            <thead>
              <tr>
                <th scope="col">文稿</th>
                <th scope="col">偏好 / 变体</th>
                <th scope="col">位置</th>
                <th scope="col">实际出现的词条编号</th>
              </tr>
            </thead>
            <tbody>
              {summary.cells
                .filter((cell) => cell.rule === filter.rule)
                .map((cell) => (
                  <tr key={cell.document}>
                    <th scope="row">{cell.document}</th>
                    <td>
                      {cell.preferred} / {cell.alternatives}
                    </td>
                    <td>{cell.locations}</td>
                    <td>{cell.variants.join("、") || "无已覆盖命中"}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p>选择一个词组后可查看它与全部文稿（包括零命中）的分布格子。</p>
      )}
      <h3>词表自查：同形与包含</h3>
      <p>
        共列出 {catalog.relations.length} 个有向关系、
        {catalog.components.length}{" "}
        个有关系的连通分量，不是语义冲突判决。相等只列一对；包含列出全部内部代码点起点。词界条件可能让某些包含关系无法同时命中。
      </p>
      {!catalog.complete ? (
        <p role="status">
          词表关系目录达到独立预算而不完整，未列出的关系仍可能存在。正文扫描仍使用完整已接纳词表，不按此目录删除词条。
        </p>
      ) : null}
      <ul aria-label="词表同形包含关系">
        {catalog.relations.slice(page * 20, (page + 1) * 20).map((pair) => (
          <li key={`${pair.left}/${pair.right}`}>
            {pair.left} {pair.kind === "equal" ? "同形于" : "包含"} {pair.right}
            ；内部代码点起点 {pair.offsets.join("、")}
          </li>
        ))}
      </ul>
      {!catalog.relations.length ? (
        <p>当前目录未列出字面同形或包含；不代表语义无歧义。</p>
      ) : null}
      {pages > 1 ? (
        <div className="nw-authoring-actions">
          <button
            className="nw-btn"
            type="button"
            disabled={page === 0}
            onClick={() => setRequested(page - 1)}
          >
            上一页词表关系
          </button>
          <span>
            词表关系第 {page + 1} / {pages} 页
          </span>
          <button
            className="nw-btn"
            type="button"
            disabled={page + 1 >= pages}
            onClick={() => setRequested(page + 1)}
          >
            下一页词表关系
          </button>
        </div>
      ) : null}
      <details>
        <summary>字面歧义连通分量编号</summary>
        <ul>
          {catalog.components.map((component, ordinal) => (
            <li key={ordinal}>
              分量 {ordinal + 1}：{component.join("、")}
            </li>
          ))}
        </ul>
        <p>同一连通分量不意味着任意两词同形或互相包含；请回到具体关系核对。</p>
      </details>
    </section>
  );
}
