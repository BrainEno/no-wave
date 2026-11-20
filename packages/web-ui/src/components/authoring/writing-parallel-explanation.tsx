import type { ParallelWorkbenchState } from "@/lib/writing-parallel-controller.ts";

/**
 * Bounded explanation of alignment score calculation.
 * Explains why two blocks were paired or separated by the dynamic programming solver.
 */
export function WritingParallelExplanation({
  state,
  clear,
}: {
  state: NonNullable<ParallelWorkbenchState["explanation"]>;
  clear: () => void;
}) {
  const value = state.value;
  return (
    <section aria-label="对齐与不对称得分解释" className="nw-parallel-detail">
      <h4>
        对齐条目 {state.id} · 得分拆解解释
      </h4>
      <p>
        展示动态规划（DP）双语对齐引擎在判定当前行时的权重明细。所有计算均为确定性得分，不调用远程 AI，不修改任何原文。
      </p>
      {state.status === "running" ? (
        <p role="status">按有界预算计算解释中……</p>
      ) : null}
      {state.status === "failed" ? <p role="alert">{state.error}</p> : null}
      {value ? (
        <div>
          <p>
            <strong>对齐状态：</strong>
            <span className="nw-parallel-badge">{value.alignmentType}</span>
            <strong>总得分：</strong>{value.totalScore}
          </p>
          <div className="nw-parallel-scroll" role="group" tabIndex={0} aria-label="对齐分值拆解表">
            <table>
              <caption>得分权重拆解项目</caption>
              <thead>
                <tr>
                  <th scope="col">检查维度</th>
                  <th scope="col">左侧单元</th>
                  <th scope="col">右侧单元</th>
                  <th scope="col">匹配特征</th>
                  <th scope="col">分值变动</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">块类型契合</th>
                  <td>{value.leftKind ?? "（无/缺口）"}</td>
                  <td>{value.rightKind ?? "（无/缺口）"}</td>
                  <td>{value.sameKind ? "完全一致" : "异构或空缺"}</td>
                  <td>{value.breakdown.kindScore > 0 ? `+${value.breakdown.kindScore}` : value.breakdown.kindScore}</td>
                </tr>
                {value.leftKind === "heading" && value.rightKind === "heading" ? (
                  <tr>
                    <th scope="row">标题层级</th>
                    <td>H{value.leftHeadingLevel ?? "?"}</td>
                    <td>H{value.rightHeadingLevel ?? "?"}</td>
                    <td>{value.breakdown.headingDrift ? "层级漂移" : "层级一致"}</td>
                    <td>{value.breakdown.headingScore > 0 ? `+${value.breakdown.headingScore}` : value.breakdown.headingScore}</td>
                  </tr>
                ) : null}
                <tr>
                  <th scope="row">长度比例</th>
                  <td>{value.leftCharCount} 字符</td>
                  <td>{value.rightCharCount} 字符</td>
                  <td>比例: {value.lengthRatio.toFixed(2)}:1</td>
                  <td>{value.breakdown.ratioScore > 0 ? `+${value.breakdown.ratioScore}` : value.breakdown.ratioScore}</td>
                </tr>
                <tr>
                  <th scope="row">共享数字/外链锚点</th>
                  <td>-</td>
                  <td>-</td>
                  <td>
                    数字加分: +{value.breakdown.numberScore}，外链加分: +{value.breakdown.anchorScore}
                  </td>
                  <td>+{value.breakdown.numberScore + value.breakdown.anchorScore}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <button className="nw-btn" type="button" onClick={clear}>
            关闭解释
          </button>
        </div>
      ) : null}
    </section>
  );
}
