import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { WritingOverlapWorkbench } from "@/lib/writing-overlap-controller.ts";
import type { OverlapAnalysis } from "@/lib/writing-overlap-model.ts";
import type {
  OverlapEvidence,
  OverlapEvidenceTerm,
} from "@/lib/writing-overlap-evidence.ts";
import {
  DEFAULT_OVERLAP_EVIDENCE_FILTER,
  overlapEvidenceAnchors,
  overlapEvidenceContext,
  overlapEvidenceSegments,
  overlapEvidenceTerms,
  type OverlapEvidenceFilter,
} from "@/lib/writing-overlap-evidence-view.ts";
import { overlapReviewPage } from "@/lib/writing-overlap-review.ts";
import { OverlapLiteral } from "./writing-overlap-literal.tsx";

function EvidenceOccurrence({
  evidence,
  term,
  side,
}: {
  evidence: OverlapEvidence;
  term: OverlapEvidenceTerm;
  side: "left" | "right";
}) {
  const [index, setIndex] = useState(0),
    [jump, setJump] = useState(""),
    [error, setError] = useState("");
  const count = term[side].length,
    label = side === "left" ? "左" : "右";
  if (!count) return <p>{label}侧没有这个片段，不定位邻近文字。</p>;
  const context = overlapEvidenceContext(evidence, side, term.id, index);
  function move(next: number) {
    setIndex(next);
    setJump("");
    setError("");
  }
  function locate() {
    const next = Number(jump);
    if (
      !/^\d+$/u.test(jump) ||
      !Number.isSafeInteger(next) ||
      next < 1 ||
      next > count
    ) {
      setError(`请输入 1–${count} 的出现序号；未跳到其他片段。`);
      return;
    }
    move(next - 1);
  }
  return (
    <section className="nw-overlap-literal" aria-label={`${label}侧片段上下文`}>
      <h5>
        {label}侧第 {index + 1} / {count} 处
      </h5>
      <p>
        分析文字代码点 [{context.pointStart}, {context.pointEnd})；UTF-16 [
        {context.utf16Start}, {context.utf16End})。仅展示前后各最多 40
        个代码点。
      </p>
      <pre>
        {context.before}
        <mark>{context.match}</mark>
        {context.after}
      </pre>
      <div className="nw-authoring-actions">
        <button
          className="nw-btn"
          type="button"
          disabled={!index}
          onClick={() => move(index - 1)}
        >
          上一处{label}侧片段
        </button>
        <button
          className="nw-btn"
          type="button"
          disabled={index + 1 === count}
          onClick={() => move(index + 1)}
        >
          下一处{label}侧片段
        </button>
        <button
          className="nw-btn"
          type="button"
          disabled={!index}
          onClick={() => move(0)}
        >
          第一处{label}侧片段
        </button>
        <button
          className="nw-btn"
          type="button"
          disabled={index + 1 === count}
          onClick={() => move(count - 1)}
        >
          最后一处{label}侧片段
        </button>
      </div>
      {count > 1 ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            locate();
          }}
        >
          <label>
            定位{label}侧片段出现序号
            <input
              aria-label={`定位${label}侧片段出现序号`}
              inputMode="numeric"
              maxLength={4}
              value={jump}
              onChange={(event) => {
                setJump(event.target.value);
                setError("");
              }}
            />
          </label>
          <button className="nw-btn" type="submit">
            定位{label}侧片段出现位置
          </button>
        </form>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

function EvidenceDetails({ evidence }: { evidence: OverlapEvidence }) {
  const [filter, setFilter] = useState<OverlapEvidenceFilter>({
    ...DEFAULT_OVERLAP_EVIDENCE_FILTER,
  });
  const [requested, setRequested] = useState(0),
    [termId, setTermId] = useState<string | null>(null);
  const [anchorFilter, setAnchorFilter] = useState<"all" | "chain" | "outside">(
      "all",
    ),
    [anchorPage, setAnchorPage] = useState(0);
  const contextRegion = useRef<HTMLElement>(null),
    trigger = useRef<HTMLButtonElement | null>(null);
  const term = evidence.terms.find((item) => item.id === termId);
  useEffect(() => {
    if (termId) contextRegion.current?.focus();
  }, [termId]);
  let rows: OverlapEvidenceTerm[] = [],
    error = "";
  try {
    rows = overlapEvidenceTerms(evidence, filter);
  } catch {
    error =
      "片段筛选无效；请输入最多 120 个代码点的完整字面文字，不执行正则表达式。";
  }
  const page = overlapReviewPage(rows, requested),
    anchors = overlapEvidenceAnchors(evidence, anchorFilter),
    chainPage = overlapReviewPage(anchors, anchorPage);
  function change(next: OverlapEvidenceFilter) {
    setFilter(next);
    setRequested(0);
    setTermId(null);
  }
  function open(id: string, button: HTMLButtonElement) {
    trigger.current = button;
    setTermId(id);
    if (termId === id) contextRegion.current?.focus();
  }
  function close() {
    setTermId(null);
    if (trigger.current?.isConnected) trigger.current.focus();
  }
  return (
    <div>
      <p>
        完整片段集合：交集 {evidence.intersection} / 并集 {evidence.union}
        ，Jaccard {(evidence.basisPoints / 100).toFixed(2)}
        %。片段出现次数多重集：最小次数合计 {evidence.countIntersection} /
        最大次数合计 {evidence.countUnion}，诊断比例{" "}
        {(evidence.countBasisPoints / 100).toFixed(2)}
        %。后者仅解释重复次数差异，不改变候选分数、人工标记或报告。
      </p>
      <p>
        共享片段覆盖左侧 {evidence.left.covered} / {evidence.left.points}{" "}
        个代码点，右侧 {evidence.right.covered} / {evidence.right.points}{" "}
        个代码点。覆盖不代表语义相同，位置不是原编辑器坐标。
      </p>
      <div className="nw-collection-filter-grid">
        <label>
          解释片段类型
          <select
            aria-label="解释片段类型"
            value={filter.kind}
            onChange={(event) =>
              change({
                ...filter,
                kind: event.target.value as OverlapEvidenceFilter["kind"],
              })
            }
          >
            <option value="all">全部片段</option>
            <option value="shared">共享片段</option>
            <option value="left-only">仅左侧</option>
            <option value="right-only">仅右侧</option>
          </select>
        </label>
        <label>
          解释片段字面筛选
          <input
            aria-label="解释片段字面筛选"
            type="search"
            maxLength={240}
            value={filter.query}
            onChange={(event) =>
              change({ ...filter, query: event.target.value })
            }
          />
        </label>
        <label>
          解释片段排序
          <select
            aria-label="解释片段排序"
            value={filter.order}
            onChange={(event) =>
              change({
                ...filter,
                order: event.target.value as OverlapEvidenceFilter["order"],
              })
            }
          >
            <option value="source">按首次遇见顺序</option>
            <option value="imbalance">按出现次数差异</option>
          </select>
        </label>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <p role="status">
        筛选后 {rows.length} 个片段；第 {page.page + 1} / {page.pages}{" "}
        页。每页最多 12 项，未改变完整解释和全局候选。
      </p>
      <ul className="nw-collection-rows" aria-label="解释片段清单">
        {page.rows.map((item) => (
          <li key={item.id}>
            <p>
              {item.id} ·{" "}
              <code>
                <bdi>{item.text}</bdi>
              </code>{" "}
              ·{" "}
              {item.kind === "shared"
                ? "共享"
                : item.kind === "left-only"
                  ? "仅左侧"
                  : "仅右侧"}{" "}
              · 左侧 {item.left.length} 次 / 右侧 {item.right.length} 次
            </p>
            <button
              className="nw-btn"
              type="button"
              onClick={(event) => open(item.id, event.currentTarget)}
            >
              查看片段 {item.id} 的每处位置
            </button>
          </li>
        ))}
      </ul>
      {!rows.length && !error ? (
        <p>当前字面筛选没有片段，不表示没有候选。</p>
      ) : null}
      <div className="nw-authoring-actions">
        <button
          className="nw-btn"
          type="button"
          disabled={!page.page}
          onClick={() => {
            setRequested(page.page - 1);
            setTermId(null);
          }}
        >
          上一页解释片段
        </button>
        <button
          className="nw-btn"
          type="button"
          disabled={page.page + 1 === page.pages}
          onClick={() => {
            setRequested(page.page + 1);
            setTermId(null);
          }}
        >
          下一页解释片段
        </button>
      </div>
      <details>
        <summary>查看唯一位置片段的顺序诊断</summary>
        <p>
          两侧都只出现一次的片段共 {evidence.anchors.length}{" "}
          个；其中一条确定的严格递增位置链有 {evidence.chainLength}{" "}
          个。重复片段不作锚点；片段可互相重叠，链外不证明移动、抄袭或应删除，链也不是富文本对齐或修改计划。
        </p>
        <label>
          唯一片段链筛选
          <select
            aria-label="唯一片段链筛选"
            value={anchorFilter}
            onChange={(event) => {
              setAnchorFilter(event.target.value as typeof anchorFilter);
              setAnchorPage(0);
            }}
          >
            <option value="all">所有唯一位置片段</option>
            <option value="chain">在所示链内</option>
            <option value="outside">不在所示链内</option>
          </select>
        </label>
        <ul aria-label="唯一片段顺序清单">
          {chainPage.rows.map((anchor) => (
            <li key={anchor.term}>
              {anchor.term} · 代码点 {anchor.left} → {anchor.right} ·{" "}
              {anchor.inChain ? "链内" : "链外"}{" "}
              <button
                className="nw-btn"
                type="button"
                onClick={(event) => open(anchor.term, event.currentTarget)}
              >
                查看锚点 {anchor.term} 的文字位置
              </button>
            </li>
          ))}
        </ul>
        <p>
          第 {chainPage.page + 1} / {chainPage.pages} 页，共 {anchors.length}{" "}
          个；这里只是诊断筛选。
        </p>
        <div className="nw-authoring-actions">
          <button
            className="nw-btn"
            type="button"
            disabled={!chainPage.page}
            onClick={() => setAnchorPage(chainPage.page - 1)}
          >
            上一页唯一片段
          </button>
          <button
            className="nw-btn"
            type="button"
            disabled={chainPage.page + 1 === chainPage.pages}
            onClick={() => setAnchorPage(chainPage.page + 1)}
          >
            下一页唯一片段
          </button>
        </div>
      </details>
      {term ? (
        <section
          className="nw-overlap-detail"
          ref={contextRegion}
          tabIndex={-1}
          aria-label="所选解释片段位置"
        >
          <h4>{term.id} 的只读出现位置</h4>
          <button className="nw-btn" type="button" onClick={close}>
            关闭片段位置并返回触发处
          </button>
          <div className="nw-overlap-columns">
            <EvidenceOccurrence
              key={`${term.id}:left`}
              evidence={evidence}
              term={term}
              side="left"
            />
            <EvidenceOccurrence
              key={`${term.id}:right`}
              evidence={evidence}
              term={term}
              side="right"
            />
          </div>
        </section>
      ) : null}
      <details>
        <summary>按共享片段覆盖查看分析文字</summary>
        <p>
          高亮只表示至少属于一个共享片段，未覆盖文字仍完整显示。文字模式为
          {evidence.mode === "folded"
            ? "已明确选择的 NFKC / 小写 / 空白折叠"
            : "原始字面"}
          ；请回到上方原始文字/节点核对，不能把这里的偏移当作编辑位置。
        </p>
        <div className="nw-overlap-columns">
          <OverlapLiteral
            label="左侧分析文字覆盖"
            text={evidence.left.text}
            highlights={(start, end) =>
              overlapEvidenceSegments(evidence, "left", start, end)
            }
          />
          <OverlapLiteral
            label="右侧分析文字覆盖"
            text={evidence.right.text}
            highlights={(start, end) =>
              overlapEvidenceSegments(evidence, "right", start, end)
            }
          />
        </div>
      </details>
    </div>
  );
}

/** Explicit computation only; the controller owns the abort/witness fence, including unmount privacy cleanup. */
export function WritingOverlapEvidence({
  controller,
  analysis,
  finding,
  left,
  right,
}: {
  controller: WritingOverlapWorkbench;
  analysis: OverlapAnalysis;
  finding: string;
  left: string;
  right: string;
}) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(
    () => () => controller.cancelEvidence(analysis, finding, left, right),
    [controller, analysis, finding, left, right],
  );
  const pending = state.evidence;
  const current =
    state.analysis === analysis &&
    pending?.finding === finding &&
    pending.left === left &&
    pending.right === right
      ? pending
      : null;
  return (
    <section className="nw-overlap-evidence" aria-label="所选候选的片段解释">
      <h4>为什么出现这个候选？</h4>
      <p>
        仅按需解释当前两处文字，每侧最多 4096
        代码点，超长不截断生成诊断。所有片段、输入的筛选文字和位置只在本轮内存，不加入无正文报告。切换位置、关闭核对、改来源或条件会清除解释。
      </p>
      <div className="nw-authoring-actions">
        <button
          className="nw-btn"
          type="button"
          disabled={current?.status === "running"}
          onClick={() => {
            void controller.explainPair(analysis, finding, left, right);
          }}
        >
          按需解释这对候选
        </button>
        {current ? (
          <button
            className="nw-btn"
            type="button"
            onClick={() =>
              controller.cancelEvidence(analysis, finding, left, right)
            }
          >
            停止并清除片段解释
          </button>
        ) : null}
      </div>
      {current?.status === "running" ? (
        <p role="status">正在解释这对片段；尚未展示部分结果。</p>
      ) : null}
      {current?.status === "failed" ? (
        <p role="alert">{current.error}</p>
      ) : null}
      {current?.value ? <EvidenceDetails evidence={current.value} /> : null}
    </section>
  );
}
