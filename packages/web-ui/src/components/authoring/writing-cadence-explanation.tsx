import type { CadenceWorkbenchState } from "@/lib/writing-cadence-controller.ts";

const actionNames = {
  push: "压栈",
  pair: "正常出栈",
  blocked: "越栈阻挡（不弹栈）",
  unexpected: "意外闭符（不弹栈）",
};

/** A bounded explanation of already committed outcomes, never a repair preview. */
export function WritingCadenceExplanation({
  state,
  navigate,
  clear,
}: {
  state: NonNullable<CadenceWorkbenchState["explanation"]>;
  navigate: (offset: number) => void;
  clear: () => void;
}) {
  const value = state.value;
  return (
    <section aria-label="逐标点配对栈解释">
      <h4>
        {state.id} · {state.focus === "start" ? "起点之前" : "终点之前"}的配对栈
      </h4>
      <p>
        只重放当前游程已提交的配对与开闭符观察，不重新猜测正文，不提出删除、补符或替换。栈表示该偏移之前的状态；并非所选字符已经处理后的状态。相同坐标的投影不会改写原文。
      </p>
      {state.status === "running" ? (
        <p role="status">按有界预算重放中；尚无栈结论……</p>
      ) : null}
      {state.status === "failed" ? <p role="alert">{state.error}</p> : null}
      {value ? (
        <>
          <p>
            单元 {value.unit} · 原始 UTF-16 偏移 {value.at}；
            {value.run
              ? `连续游程 UTF-16 [${value.run.start}, ${value.run.end}) / 代码点 [${value.run.pointStart}, ${value.run.pointEnd})`
              : "选中观察跨越结构断点，不属于一个配对游程"}
            。
          </p>
          {value.status === "structural-boundary" ? (
            <p role="status">
              没有单个游程可重放；这不是空栈或配对正常的证明。
            </p>
          ) : (
            <>
              <p role="status">
                已重放 {value.coverage.replayedTokens}/
                {value.coverage.totalTokens ?? "清单未完成"} 个端点，检查{" "}
                {value.coverage.examinedReferences} 个全局引用，使用{" "}
                {value.coverage.steps} 步。
                {value.coverage.complete
                  ? "当前游程重放完整。"
                  : "重放不完整，不作尾栈判断。"}
                {value.coverage.selectedReached
                  ? "已到达所选边界。"
                  : "未到达所选边界，不显示猜测栈。"}
              </p>
              {value.frontier ? (
                <p>
                  解释前沿：
                  {value.frontier.stage === "inventory"
                    ? "清单或排序预算停止，尚未开始重放"
                    : `第${value.frontier.token}个端点（从0起），UTF-16 ${value.frontier.start}`}
                  。解释预算独立于全局扫描覆盖。
                </p>
              ) : null}
              <p>
                所选边界前栈：
                {value.stackAtFocus === null
                  ? "未知"
                  : value.stackAtFocus.length
                    ? value.stackAtFocus
                        .map(
                          (frame) =>
                            `${frame.item} ${frame.family}@${frame.start}`,
                        )
                        .join(" → ")
                    : "空栈（该边界已到达）"}
              </p>
              <p>
                游程末未闭开符：
                {value.endingOpens === null
                  ? "未知，未完成重放"
                  : value.endingOpens.length
                    ? value.endingOpens
                        .map((frame) => `${frame.item}@${frame.start}`)
                        .join("、")
                    : "无（只指本游程的已提交端点）"}
              </p>
              <p>
                以下至多显示所选边界前后各20个端点。窗口前省略{" "}
                {value.coverage.omittedBefore} 个，窗口后或尚未重放{" "}
                {value.coverage.omittedAfter} 个；省略不等于没出现。
              </p>
              <div
                className="nw-cadence-scroll"
                role="group"
                tabIndex={0}
                aria-label="可横向滚动的配对栈轨迹表"
              >
                <table>
                  <caption>当前游程的逐标点轨迹窗口</caption>
                  <thead>
                    <tr>
                      <th scope="col">端点／项目</th>
                      <th scope="col">动作／字符族</th>
                      <th scope="col">原始坐标</th>
                      <th scope="col">前后深度</th>
                      <th scope="col">关联／阻挡</th>
                      <th scope="col">安全定位</th>
                    </tr>
                  </thead>
                  <tbody>
                    {value.events.map((event) => (
                      <tr key={event.token}>
                        <th scope="row">
                          {event.token}／{event.item}
                        </th>
                        <td>
                          {actionNames[event.action]}／{event.family}
                        </td>
                        <td>
                          UTF-16 [{event.start},{event.end}) / 代码点 [
                          {event.pointStart},{event.pointEnd})
                        </td>
                        <td>
                          {event.depthBefore} → {event.depthAfter}
                        </td>
                        <td>
                          {event.reference ?? "无"}／{event.obstruction ?? "无"}
                        </td>
                        <td>
                          <button
                            className="nw-btn"
                            type="button"
                            onClick={() =>
                              navigate(Math.max(0, event.start - 80))
                            }
                          >
                            定位轨迹端点 {event.token}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!value.events.length ? (
                <p>
                  当前窗口没有可显示的已重放端点；请结合前沿与完整状态，不推断全文缺席。
                </p>
              ) : null}
            </>
          )}
        </>
      ) : null}
      <button className="nw-btn" type="button" onClick={clear}>
        {state.status === "running" ? "取消当前栈解释" : "收起当前栈解释"}
      </button>
    </section>
  );
}
