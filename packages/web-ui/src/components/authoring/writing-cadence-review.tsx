import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CadenceWorkbenchState,
  WritingCadenceWorkbench,
} from "@/lib/writing-cadence-controller.ts";
import { cadenceEnclosures } from "@/lib/writing-cadence-enclosures.ts";
import { cadencePairRhythm } from "@/lib/writing-cadence-crossings.ts";
import { WritingCadenceExplanation } from "./writing-cadence-explanation.tsx";
import type { CadenceAnalysis } from "@/lib/writing-cadence-model.ts";
import {
  cadenceContext,
  cadenceRows,
  DEFAULT_CADENCE_FILTERS,
  resolveCadenceRow,
  type CadenceFilters,
  type CadenceMark,
} from "@/lib/writing-cadence-review.ts";
import {
  CADENCE_KIND_NAMES,
  WritingCadenceProfile,
} from "./writing-cadence-profile.tsx";

const markNames = {
  unreviewed: "尚未核对",
  intentional: "有意使用",
  "follow-up": "后续检查",
};

export function WritingCadenceReview({
  controller,
  analysis,
  marks,
  explanation,
}: {
  controller: WritingCadenceWorkbench;
  analysis: CadenceAnalysis;
  marks: readonly CadenceMark[];
  explanation: CadenceWorkbenchState["explanation"];
}) {
  const [filters, setFilters] = useState({ ...DEFAULT_CADENCE_FILTERS });
  const [requestedPage, setPage] = useState(0);
  const [selected, setSelected] = useState<{
    id: string;
    history: (number | undefined)[];
  } | null>(null);
  const [jump, setJump] = useState(""),
    [error, setError] = useState("");
  const trigger = useRef<HTMLButtonElement | null>(null),
    detailRef = useRef<HTMLElement>(null),
    headingRef = useRef<HTMLHeadingElement>(null);
  const rows = useMemo(
    () => cadenceRows(analysis, filters, marks),
    [analysis, filters, marks],
  );
  const pages = Math.max(1, Math.ceil(rows.length / 25)),
    page = Math.min(requestedPage, pages - 1),
    visible = rows.slice(page * 25, (page + 1) * 25);
  const row = selected ? resolveCadenceRow(analysis, selected.id) : null;
  const enclosure = useMemo(
    () =>
      selected
        ? cadenceEnclosures(analysis).entries.find(
            (entry) => entry.fragment === selected.id,
          )
        : undefined,
    [analysis, selected],
  );
  const pairSpan = useMemo(
    () =>
      selected
        ? cadencePairRhythm(analysis).pairs.find(
            (span) => span.pair === selected.id,
          )
        : undefined,
    [analysis, selected],
  );
  const context = selected
    ? cadenceContext(analysis, selected.id, selected.history.at(-1))
    : null;
  useEffect(() => {
    if (selected) detailRef.current?.focus();
  }, [selected]);
  function locate(id: string, button: HTMLButtonElement) {
    controller.clearExplanation();
    trigger.current = button;
    setSelected({ id, history: [undefined] });
    setJump("");
    setError("");
  }
  function close(returnFocus: boolean) {
    controller.clearExplanation();
    setSelected(null);
    setJump("");
    setError("");
    if (returnFocus) {
      if (trigger.current?.isConnected) trigger.current.focus();
      else headingRef.current?.focus();
    }
    trigger.current = null;
  }
  function change(next: CadenceFilters) {
    setFilters(next);
    setPage(0);
    close(false);
  }
  function navigate(offset: number) {
    if (selected) {
      setSelected({ ...selected, history: [...selected.history, offset] });
      setJump("");
      setError("");
    }
  }
  function jumpTo() {
    if (
      !context ||
      !/^\d+$/u.test(jump) ||
      !Number.isSafeInteger(Number(jump)) ||
      Number(jump) < 0 ||
      Number(jump) >= context.total
    ) {
      setError(
        "请输入当前单元范围内的原始UTF-16整数偏移；不使用投影后的字符位置。",
      );
      return;
    }
    navigate(Number(jump));
  }
  const total =
    analysis.findings.length +
    analysis.pairs.length +
    analysis.fragments.length;
  return (
    <section className="nw-overlap-review" aria-label="本机标点只读审阅">
      <h2 ref={headingRef} tabIndex={-1}>
        标点与片段只读核对
      </h2>
      <p role="status">
        全局 {analysis.findings.length} 项观察 / {analysis.pairs.length} 个配对
        / {analysis.fragments.length} 个片段；已标记 {marks.length} 项，尚未核对{" "}
        {total - marks.length} 项。
        {analysis.frontier
          ? "存在未扫描正文，当前计数只是下界。"
          : "完整仅指声明的字面游程。"}
      </p>
      <WritingCadenceProfile analysis={analysis} locate={locate} />
      <h3>有界清单与临时标记</h3>
      <div className="nw-authoring-actions">
        <label>
          标点列表文稿
          <select
            aria-label="标点列表文稿"
            value={filters.document}
            onChange={(event) =>
              change({ ...filters, document: event.target.value })
            }
          >
            <option value="all">全部文稿</option>
            {analysis.documents.map((document) => (
              <option key={document}>{document}</option>
            ))}
          </select>
        </label>
        <label>
          标点列表类型
          <select
            aria-label="标点列表类型"
            value={filters.type}
            onChange={(event) =>
              change({
                ...filters,
                type: event.target.value as CadenceFilters["type"],
                kind: "all",
              })
            }
          >
            <option value="findings">字面观察</option>
            <option value="pairs">成功配对</option>
            <option value="fragments">停顿片段</option>
            <option value="all">全部三类</option>
          </select>
        </label>
        <label>
          标点观察类别
          <select
            aria-label="标点观察类别"
            value={filters.kind}
            onChange={(event) =>
              change({
                ...filters,
                type: "findings",
                kind: event.target.value as CadenceFilters["kind"],
              })
            }
          >
            <option value="all">全部观察类别</option>
            {Object.entries(CADENCE_KIND_NAMES).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          标点人工状态
          <select
            aria-label="标点人工状态"
            value={filters.state}
            onChange={(event) =>
              change({
                ...filters,
                state: event.target.value as CadenceFilters["state"],
              })
            }
          >
            <option value="all">所有状态</option>
            {Object.entries(markNames).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          标点列表排序
          <select
            aria-label="标点列表排序"
            value={filters.sort}
            onChange={(event) =>
              change({
                ...filters,
                sort: event.target.value as CadenceFilters["sort"],
              })
            }
          >
            <option value="source">原文位置</option>
            <option value="length">长度从大到小</option>
            <option value="depth">配对深度从大到小</option>
          </select>
        </label>
      </div>
      <p>
        筛选后{rows.length}项，本页{visible.length}项；第{page + 1}/{pages}
        页。筛选、分页和排序不会丢掉隐藏标记，也不会缩小全局报告。
      </p>
      <div className="nw-authoring-actions">
        {(["intentional", "follow-up", "unreviewed"] as const).map((state) => (
          <button
            className="nw-btn"
            type="button"
            key={state}
            disabled={!visible.length}
            onClick={() =>
              controller.mark(
                visible.map((item) => item.id),
                state,
                analysis,
              )
            }
          >
            将本页标点项目标记为{markNames[state]}
          </button>
        ))}
      </div>
      <ol className="nw-collection-rows" aria-label="标点与片段清单">
        {visible.map((item) => (
          <li key={item.id}>
            <h4>
              {item.id} ·{" "}
              {item.type === "findings"
                ? CADENCE_KIND_NAMES[
                    item.kind as keyof typeof CADENCE_KIND_NAMES
                  ]
                : item.type === "pairs"
                  ? `字面配对 ${item.kind}`
                  : item.kind === "terminal"
                    ? "标点停顿片段"
                    : "游程末片段"}
            </h4>
            <p>
              {item.document} · {item.unit} · 原始 UTF-16 [{item.start},{" "}
              {item.end}) / 代码点 [{item.pointStart}, {item.pointEnd}) ·{" "}
              {item.type === "fragments" ? "非空白长度" : "跨度代码点"}
              {item.length}
              {item.type === "pairs" ? ` · 嵌套${item.depth}层` : ""} ·{" "}
              {markNames[item.state]}
            </p>
            <div className="nw-authoring-actions">
              <button
                className="nw-btn"
                type="button"
                onClick={(event) => locate(item.id, event.currentTarget)}
              >
                定位标点项目 {item.id}
              </button>
              <label>
                标记项目 {item.id}
                <select
                  aria-label={`标记项目 ${item.id}`}
                  value={item.state}
                  onChange={(event) =>
                    controller.mark(
                      [item.id],
                      event.target.value as CadenceMark["state"] | "unreviewed",
                      analysis,
                    )
                  }
                >
                  {Object.entries(markNames).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </li>
        ))}
      </ol>
      {!rows.length ? (
        <p>当前视图为空；不会把未扫描范围说成没有观察项。</p>
      ) : null}
      <div className="nw-authoring-actions">
        <button
          className="nw-btn"
          type="button"
          disabled={!page}
          onClick={() => {
            setPage(page - 1);
            close(false);
          }}
        >
          上一页标点清单
        </button>
        <button
          className="nw-btn"
          type="button"
          disabled={page + 1 >= pages}
          onClick={() => {
            setPage(page + 1);
            close(false);
          }}
        >
          下一页标点清单
        </button>
      </div>
      {selected && row && context ? (
        <section
          className="nw-overlap-detail"
          ref={detailRef}
          tabIndex={-1}
          aria-label="标点原文安全定位"
        >
          <h3>仅此处的原文安全投影：{row.id}</h3>
          <p>
            {row.unit} · 路径[{context.path.join(", ")}] · 原始 UTF-16 [
            {row.start}, {row.end}) / 代码点 [{row.pointStart}, {row.pointEnd}
            )。展开后的⟦U+…⟧是安全显示记号，不属于原文，也不改变原始坐标；方向控制不会按其原始字符渲染。
          </p>
          <p>
            当前页原始UTF-16 {context.start}–{context.end} / {context.total}
            ，每页最多2048个原始代码单元，不拆代理对，可能切开组合字形。选中位置用标记显示；关联开符另加下划线。
          </p>
          <div className="nw-overlap-literal">
            <pre aria-label="标点安全文字投影">
              {context.pieces.map((piece, index) =>
                piece.selected || piece.related ? (
                  <mark
                    key={index}
                    data-selected={piece.selected || undefined}
                    data-related={piece.related || undefined}
                  >
                    {piece.text}
                  </mark>
                ) : (
                  <span key={index}>{piece.text}</span>
                ),
              )}
            </pre>
          </div>
          <div className="nw-authoring-actions">
            {context.targets.map((target, index) => (
              <button
                className="nw-btn"
                type="button"
                key={index}
                onClick={() => navigate(Math.max(0, target.start - 80))}
              >
                定位
                {target.role === "close"
                  ? "闭符"
                  : target.role === "open"
                    ? "开符"
                    : target.role === "related"
                      ? "关联开符"
                      : "选中跨度"}{" "}
                {index + 1}
              </button>
            ))}
            <button
              className="nw-btn"
              type="button"
              disabled={selected.history.length < 2}
              onClick={() =>
                setSelected({
                  ...selected,
                  history: selected.history.slice(0, -1),
                })
              }
            >
              上一页标点原文
            </button>
            <button
              className="nw-btn"
              type="button"
              disabled={!context.more}
              onClick={() => navigate(context.end)}
            >
              下一页标点原文
            </button>
          </div>
          {context.more ? (
            <p>仍有后续原文未显示，不是完整原文已展示。</p>
          ) : null}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              jumpTo();
            }}
          >
            <label>
              定位原始UTF-16偏移
              <input
                inputMode="numeric"
                value={jump}
                onChange={(event) => {
                  setJump(event.target.value);
                  setError("");
                }}
              />
            </label>
            <button className="nw-btn" type="submit">
              跳转标点原文偏移
            </button>
          </form>
          {enclosure ? (
            <section aria-label="当前片段配对交叉明细">
              <h4>当前片段与配对的交叉</h4>
              <p>
                相交 {enclosure.touchedPairs} 个配对；完整包围本片段{" "}
                {enclosure.fullyContained} 个；起点／终点内深度{" "}
                {enclosure.depthAtStart}/{enclosure.depthAtEnd}
                ；原始代码点配对并集 {enclosure.pairedPoints}/{enclosure.points}
                （嵌套不重计）。片段与配对均为半开原始区间，端点处深度取片段内部一侧，不代表角色或语义。
              </p>
              <p>
                相交观察：
                {Object.entries(enclosure.findings)
                  .map(
                    ([kind, count]) =>
                      `${CADENCE_KIND_NAMES[kind as keyof typeof CADENCE_KIND_NAMES]} ${count}`,
                  )
                  .join("；")}
                。
              </p>
            </section>
          ) : null}
          {pairSpan ? (
            <section aria-label="当前配对停顿边界明细">
              <h4>当前配对跨越的停顿边界</h4>
              <p>
                从片段 {pairSpan.first} 到 {pairSpan.last}：相交{" "}
                {pairSpan.fragments} 个片段，其中完整包围{" "}
                {pairSpan.containedFragments} 个，跨过 {pairSpan.boundaries}{" "}
                个停顿边界。只按半开原始区间计数，不代表语义嵌套意图。
              </p>
              <div className="nw-authoring-actions">
                <button
                  className="nw-btn"
                  type="button"
                  onClick={(event) =>
                    locate(pairSpan.first, event.currentTarget)
                  }
                >
                  定位配对起点片段 {pairSpan.first}
                </button>
                <button
                  className="nw-btn"
                  type="button"
                  onClick={(event) =>
                    locate(pairSpan.last, event.currentTarget)
                  }
                >
                  定位配对终点片段 {pairSpan.last}
                </button>
              </div>
            </section>
          ) : null}
          <div className="nw-authoring-actions">
            <button
              className="nw-btn"
              type="button"
              onClick={() => {
                void controller.explain(row.id, "start");
              }}
            >
              解释起点配对栈
            </button>
            <button
              className="nw-btn"
              type="button"
              onClick={() => {
                void controller.explain(row.id, "end");
              }}
            >
              解释终点配对栈
            </button>
          </div>
          {explanation?.id === row.id ? (
            <WritingCadenceExplanation
              state={explanation}
              navigate={navigate}
              clear={() => controller.clearExplanation()}
            />
          ) : null}
          {error ? <p role="alert">{error}</p> : null}
          <button className="nw-btn" type="button" onClick={() => close(true)}>
            关闭标点定位并返回触发按钮
          </button>
        </section>
      ) : null}
    </section>
  );
}
