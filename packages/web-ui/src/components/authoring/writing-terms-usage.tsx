import { useMemo, useState } from "react";
import type { TermsAnalysis } from "@/lib/writing-terms-model.ts";
import {
  profileTermsUsage,
  compareTermsUsage,
  type TermsDocumentCoverage,
} from "@/lib/writing-terms-usage.ts";
import type { TermsFilter } from "@/lib/writing-terms-review.ts";
const coverage: Record<TermsDocumentCoverage["state"], string> = {
  complete: "声明范围完整扫描",
  partial: "仅覆盖前缀",
  unscanned: "尚未覆盖",
  "outside-scope": "没有合格单元",
};
export function WritingTermsUsage({
  analysis,
  filter,
  choose,
}: {
  analysis: TermsAnalysis;
  filter: TermsFilter;
  choose: (filter: TermsFilter) => void;
}) {
  const usage = useMemo(() => profileTermsUsage(analysis), [analysis]);
  const [selection, setSelection] = useState({
    witness: analysis,
    rule: "t1",
    left: analysis.documents[0]!,
    right: analysis.documents[1] ?? "",
    differencesOnly: false,
  });
  const current =
    selection.witness === analysis
      ? selection
      : {
          witness: analysis,
          rule: "t1",
          left: analysis.documents[0]!,
          right: analysis.documents[1] ?? "",
          differencesOnly: false,
        };
  const group = usage.groups.find((group) => group.rule === current.rule)!;
  const comparison =
    current.right && current.left !== current.right
      ? compareTermsUsage(analysis, usage, current.left, current.right)
      : null;
  function patch(value: Partial<typeof current>) {
    setSelection({ ...current, ...value, witness: analysis });
  }
  return (
    <section aria-label="术语拼写组合画像">
      <h3>拼写组合画像与文稿对照</h3>
      <p>
        比较模式下完全同形的词条只属于同一个“拼写类”，但所有命中主张与人工标记仍保留。画像按精确原文跨度去重计位置，不将同形的多个主张误报为多种拼写；不作正确性或作者风格判断。
      </p>
      <label>
        拼写画像词组
        <select
          aria-label="拼写画像词组"
          value={current.rule}
          onChange={(event) => patch({ rule: event.target.value })}
        >
          {analysis.recipe.rules.map((rule, ordinal) => (
            <option key={ordinal} value={`t${ordinal + 1}`}>
              t{ordinal + 1} · {rule.preferred}
            </option>
          ))}
        </select>
      </label>
      <p>
        {group.rule} 全局观察到 {group.observed.length}{" "}
        个拼写类；同篇出现多个类的文稿：
        {group.mixedDocuments.join("、") || "当前未观察到"}
        。空计数和“仅观察到”不代表未覆盖原文没有其他拼写。
      </p>
      <ul aria-label="术语拼写类定义">
        {group.classes.map((spelling) => (
          <li key={spelling.id}>
            {spelling.id}：
            {spelling.patterns.map((id) => {
              const pattern = analysis.patterns.find(
                (pattern) => pattern.id === id,
              )!;
              return (
                <span key={id}>
                  {id} · <bdi>{pattern.text}</bdi>；
                </span>
              );
            })}
          </li>
        ))}
      </ul>
      <div
        className="nw-terms-table"
        tabIndex={0}
        role="group"
        aria-label="可横向滚动的术语表格"
      >
        <table>
          <caption>观察到相同拼写组合且覆盖状态相同的文稿</caption>
          <thead>
            <tr>
              <th scope="col">组合编号</th>
              <th scope="col">已观察拼写类</th>
              <th scope="col">覆盖</th>
              <th scope="col">文稿</th>
            </tr>
          </thead>
          <tbody>
            {group.signatures.map((signature) => (
              <tr key={signature.id}>
                <th scope="row">{signature.id}</th>
                <td>{signature.classes.join("、") || "无已覆盖命中"}</td>
                <td>{coverage[signature.coverage]}</td>
                <td>{signature.documents.join("、")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details>
        <summary>拼写类两两共现分区（仅观察事实）</summary>
        <ul>
          {group.coUses.map((pair) => (
            <li key={`${pair.left}/${pair.right}`}>
              {pair.left} / {pair.right}：两者均观察到 [{pair.both.join("、")}{" "}
              ]；仅观察到前者 [{pair.leftObservedOnly.join("、")}{" "}
              ]；仅观察到后者 [{pair.rightObservedOnly.join("、")}{" "}
              ]；两者均未观察到 [{pair.neitherObserved.join("、")}{" "}
              ]。请同时核对各篇覆盖。
            </li>
          ))}
        </ul>
      </details>
      {analysis.documents.length > 1 ? (
        <>
          <div className="nw-collection-filter-grid">
            <label>
              拼写对照左文稿
              <select
                aria-label="拼写对照左文稿"
                value={current.left}
                onChange={(event) => patch({ left: event.target.value })}
              >
                {analysis.documents.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
            <label>
              拼写对照右文稿
              <select
                aria-label="拼写对照右文稿"
                value={current.right}
                onChange={(event) => patch({ right: event.target.value })}
              >
                {analysis.documents.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {!comparison ? (
            <p>请选择两篇不同的文稿，未自动跳到其他文稿。</p>
          ) : (
            <>
              {!comparison.comparable ? (
                <p role="status">
                  至少一篇没有合格单元或未完整覆盖，以下仅比较已观察集合，不能推断缺席或全文差异。
                </p>
              ) : (
                <p>
                  两侧声明范围均已扫描。“相同组合”不代表出现次数、原文、节点或语义相同。
                </p>
              )}
              <label className="nw-writing-check">
                <input
                  type="checkbox"
                  checked={current.differencesOnly}
                  onChange={(event) =>
                    patch({ differencesOnly: event.target.checked })
                  }
                />
                拼写对照只看已观察组合不同的词组
              </label>
              <div
                className="nw-terms-table"
                tabIndex={0}
                role="group"
                aria-label="可横向滚动的术语表格"
              >
                <table>
                  <caption>
                    文稿 {comparison.left} / {comparison.right}{" "}
                    的已观察拼写集合对照
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">词组</th>
                      <th scope="col">集合关系</th>
                      <th scope="col">共有</th>
                      <th scope="col">仅左 / 仅右观察到</th>
                      <th scope="col">左 / 右位置数</th>
                      <th scope="col">定位</th>
                    </tr>
                  </thead>
                  <tbody>
                    {comparison.groups
                      .filter(
                        (row) => !current.differencesOnly || row.difference > 0,
                      )
                      .map((row) => (
                        <tr key={row.rule}>
                          <th scope="row">{row.rule}</th>
                          <td>
                            {row.state === "both-unseen"
                              ? "均无已观察命中"
                              : row.state === "same-observed-set"
                                ? "已观察组合相同"
                                : "已观察组合不同"}
                          </td>
                          <td>{row.shared.join("、") || "无"}</td>
                          <td>
                            {row.leftOnly.join("、") || "无"} /{" "}
                            {row.rightOnly.join("、") || "无"}
                          </td>
                          <td>
                            {row.leftLocations} / {row.rightLocations}
                          </td>
                          <td>
                            <button
                              className="nw-btn"
                              type="button"
                              onClick={() =>
                                choose({
                                  ...filter,
                                  rule: row.rule,
                                  document: current.left,
                                  variant: "all",
                                })
                              }
                            >
                              查看 {row.rule} 左侧位置
                            </button>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      ) : (
        <p>只有一篇文稿；可以核对同篇拼写组合，不提供虚构的跨篇对照。</p>
      )}
    </section>
  );
}
