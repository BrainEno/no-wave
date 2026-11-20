import { useEffect, useMemo, useRef, useState } from "react";
import type { WritingTermsWorkbench } from "@/lib/writing-terms-controller.ts";
import type { TermsAnalysis } from "@/lib/writing-terms-model.ts";
import {
  DEFAULT_TERMS_FILTER,
  summarizeTerms,
  termsRows,
  type TermsFilter,
  type TermsMark,
  type TermsRow,
} from "@/lib/writing-terms-review.ts";
import {
  termsHighlightPage,
  termsMatchContext,
} from "@/lib/writing-terms-context.ts";
import { OverlapLiteral } from "./writing-overlap-literal.tsx";
import { WritingTermsUsage } from "./writing-terms-usage.tsx";
import { WritingTermsDistribution } from "./writing-terms-distribution.tsx";

const status = (verdict: TermsMark["verdict"] | null) =>
  verdict === "intentional"
    ? "有意使用"
    : verdict === "follow-up"
      ? "后续检查"
      : "尚未核对";
function TermsLocation({
  controller,
  row,
  close,
}: {
  controller: WritingTermsWorkbench;
  row: TermsRow;
  close: () => void;
}) {
  const current = controller.row(row),
    context = termsMatchContext(current.witness, current.match.id),
    region = useRef<HTMLDivElement>(null);
  useEffect(() => {
    region.current?.focus();
  }, [row]);
  return (
    <div
      className="nw-overlap-detail"
      role="region"
      aria-label="术语原文定位详情"
      tabIndex={-1}
      ref={region}
    >
      <h3>原文定位 {row.match.id}</h3>
      <p>
        {row.unit.document} · {row.unit.kind} · 节点路径 [
        {row.unit.path.join(", ")}]；原始 UTF-16 [{row.match.start},{" "}
        {row.match.end}) / 代码点 [{row.match.pointStart}, {row.match.pointEnd}
        )，均从 0 起算，结束位置不含。代码点不等于组合字形。
      </p>
      <p>
        当前词条 {row.pattern.id}：<bdi>{row.pattern.text}</bdi>（
        {row.pattern.index ? "变体" : "偏好"}，不是修改建议）。原文窗口：
        <bdi>
          {context.before}
          <mark>{context.match}</mark>
          {context.after}
        </bdi>
      </p>
      <p>
        所属重叠团 {row.cluster.id} 有 {row.cluster.claims.length} 个主张、
        {row.cluster.patterns.length} 个词条，原文范围 [{row.cluster.start},{" "}
        {row.cluster.end})。包含的命中编号：{row.cluster.claims.join("、")}
        。下方着色表示至少一个主张覆盖；双下划线是当前所选命中，悬浮说明列出该片段并存主张计数。所有命中仍独立列在清单中。
      </p>
      <OverlapLiteral
        key={row.match.id}
        text={row.unit.text}
        initialOffset={row.match.start}
        label="术语原始单元"
        highlights={(start, end) =>
          termsHighlightPage(
            row.witness,
            row.unit.id,
            start,
            end,
            row.match.id,
          ).map((piece) => ({
            text: piece.text,
            hit: piece.claims > 0,
            selected: piece.selected,
            title: `${piece.claims} 个主张 / ${piece.rules} 组；偏好 ${piece.preferred}、变体 ${piece.alternatives}${piece.selected ? "；含当前命中" : ""}`,
          }))
        }
      />
      <button className="nw-btn" type="button" onClick={close}>
        关闭术语定位并返回触发按钮
      </button>
    </div>
  );
}

export function WritingTermsReview({
  controller,
  analysis,
  marks,
}: {
  controller: WritingTermsWorkbench;
  analysis: TermsAnalysis;
  marks: TermsMark[];
}) {
  const [view, setView] = useState({
    witness: analysis,
    filter: { ...DEFAULT_TERMS_FILTER },
    page: 0,
  });
  const [active, setActive] = useState<TermsRow | null>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const current =
    view.witness === analysis
      ? view
      : { witness: analysis, filter: { ...DEFAULT_TERMS_FILTER }, page: 0 };
  const filter = current.filter,
    summary = useMemo(() => summarizeTerms(analysis, marks), [analysis, marks]);
  const rows = termsRows(analysis, marks, filter),
    pages = Math.max(1, Math.ceil(rows.length / 20)),
    page = Math.min(current.page, pages - 1),
    visible = rows.slice(page * 20, (page + 1) * 20);
  const selected = active?.witness === analysis ? active : null;
  function changeFilter(next: TermsFilter) {
    setView({ witness: analysis, filter: next, page: 0 });
    setActive(null);
  }
  function navigate(page: number) {
    setView({ witness: analysis, filter, page });
    setActive(null);
  }
  function markPage(verdict: TermsMark["verdict"] | null) {
    const ids = new Set(visible.map((row) => row.match.id)),
      snapshot = controller.getSnapshot();
    const next = snapshot.marks.filter((mark) => !ids.has(mark.match));
    if (verdict !== null)
      for (const id of ids) next.push({ match: id, verdict });
    controller.setMarks(analysis, next);
  }
  function close() {
    const id = selected?.match.id;
    setActive(null);
    if (id) triggers.current.get(id)?.focus();
  }
  return (
    <section className="nw-overlap-review" aria-label="本机术语命中审阅">
      <h2>分布、原文与临时人工标记</h2>
      <p role="status">
        全局 {summary.claims} 个命中主张，已标记 {marks.length} 个，尚未核对{" "}
        {summary.unreviewed} 个。标记仅在内存，不代表替换授权。
      </p>
      <WritingTermsDistribution
        key={`${analysis.sourceKey}/${analysis.recipeKey}/${analysis.policy.mode}/${analysis.policy.scope}`}
        analysis={analysis}
        summary={summary}
        filter={filter}
        choose={changeFilter}
      />
      <WritingTermsUsage
        analysis={analysis}
        filter={filter}
        choose={changeFilter}
      />
      <div className="nw-collection-filter-grid">
        <label>
          术语文稿筛选
          <select
            aria-label="术语文稿筛选"
            value={filter.document}
            onChange={(event) =>
              changeFilter({ ...filter, document: event.target.value })
            }
          >
            <option value="all">所有文稿</option>
            {analysis.documents.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <label>
          术语词组筛选
          <select
            aria-label="术语词组筛选"
            value={filter.rule}
            onChange={(event) =>
              changeFilter({
                ...filter,
                rule: event.target.value,
                variant: "all",
              })
            }
          >
            <option value="all">所有词组</option>
            {analysis.recipe.rules.map((rule, ordinal) => (
              <option key={ordinal} value={`t${ordinal + 1}`}>
                t{ordinal + 1} · {rule.preferred}
              </option>
            ))}
          </select>
        </label>
        <label>
          术语词条筛选
          <select
            aria-label="术语词条筛选"
            value={filter.variant}
            onChange={(event) =>
              changeFilter({ ...filter, variant: event.target.value })
            }
          >
            <option value="all">所有词条</option>
            {analysis.patterns
              .filter(
                (pattern) =>
                  filter.rule === "all" || pattern.rule === filter.rule,
              )
              .map((pattern) => (
                <option key={pattern.id} value={pattern.id}>
                  {pattern.id} · {pattern.text}
                </option>
              ))}
          </select>
        </label>
        <label>
          术语主张类别
          <select
            aria-label="术语主张类别"
            value={filter.kind}
            onChange={(event) =>
              changeFilter({
                ...filter,
                kind: event.target.value as TermsFilter["kind"],
              })
            }
          >
            <option value="all">偏好与变体</option>
            <option value="preferred">仅偏好词</option>
            <option value="alternative">仅变体</option>
          </select>
        </label>
        <label>
          术语审阅状态
          <select
            aria-label="术语审阅状态"
            value={filter.status}
            onChange={(event) =>
              changeFilter({
                ...filter,
                status: event.target.value as TermsFilter["status"],
              })
            }
          >
            <option value="all">所有状态</option>
            <option value="unreviewed">尚未核对</option>
            <option value="follow-up">需要后续检查</option>
            <option value="intentional">有意使用</option>
          </select>
        </label>
        <label>
          术语重叠筛选
          <select
            aria-label="术语重叠筛选"
            value={filter.overlap}
            onChange={(event) =>
              changeFilter({
                ...filter,
                overlap: event.target.value as TermsFilter["overlap"],
              })
            }
          >
            <option value="all">所有位置</option>
            <option value="overlapping">与其他主张重叠</option>
            <option value="isolated">独立位置</option>
          </select>
        </label>
        <label>
          术语列表排序
          <select
            aria-label="术语列表排序"
            value={filter.order}
            onChange={(event) =>
              changeFilter({
                ...filter,
                order: event.target.value as TermsFilter["order"],
              })
            }
          >
            <option value="source">原始扫描顺序</option>
            <option value="rule">词组、文稿、原文位置</option>
            <option value="document">文稿、原文位置</option>
          </select>
        </label>
      </div>
      <p>
        筛选只改变列表，不改变全局报告、覆盖范围或隐藏主张的标记。筛选后{" "}
        {rows.length} 个，显示 {visible.length} 个；第 {page + 1} / {pages} 页。
      </p>
      <div className="nw-authoring-actions" aria-label="术语本页显式标记">
        <button
          className="nw-btn"
          type="button"
          disabled={!visible.length}
          onClick={() => markPage("follow-up")}
        >
          将本页术语标记为后续检查
        </button>
        <button
          className="nw-btn"
          type="button"
          disabled={!visible.length}
          onClick={() => markPage("intentional")}
        >
          将本页术语标记为有意使用
        </button>
        <button
          className="nw-btn"
          type="button"
          disabled={!visible.length}
          onClick={() => markPage(null)}
        >
          清除本页术语标记
        </button>
      </div>
      <ol className="nw-collection-rows" aria-label="术语命中清单">
        {visible.map((row) => (
          <li key={row.match.id}>
            <h3>
              {row.match.id} · {row.pattern.id} · <bdi>{row.pattern.text}</bdi>
            </h3>
            <p>
              {row.pattern.index ? "变体主张" : "偏好词主张"} ·{" "}
              {row.unit.document} · 路径 [{row.unit.path.join(", ")}] · 原始
              UTF-16 [{row.match.start}, {row.match.end}) / 代码点 [
              {row.match.pointStart}, {row.match.pointEnd}) ·{" "}
              {status(row.verdict)}
              {row.cluster.claims.length > 1
                ? `；与其他主张重叠，团内共 ${row.cluster.claims.length} 个`
                : "；独立位置"}
            </p>
            <div className="nw-authoring-actions">
              <button
                className="nw-btn"
                type="button"
                ref={(node) => {
                  if (node) triggers.current.set(row.match.id, node);
                  else triggers.current.delete(row.match.id);
                }}
                onClick={() => setActive(controller.row(row))}
              >
                定位术语 {row.match.id}
              </button>
              <label>
                标记术语 {row.match.id}
                <select
                  aria-label={`标记术语 ${row.match.id}`}
                  value={row.verdict ?? "unreviewed"}
                  onChange={(event) =>
                    controller.mark(
                      analysis,
                      row.match.id,
                      event.target.value === "unreviewed"
                        ? null
                        : (event.target.value as TermsMark["verdict"]),
                    )
                  }
                >
                  <option value="unreviewed">尚未核对</option>
                  <option value="intentional">有意使用</option>
                  <option value="follow-up">后续检查</option>
                </select>
              </label>
            </div>
          </li>
        ))}
      </ol>
      {!rows.length ? (
        <p role="status">
          当前视图没有已覆盖命中；不代表全文没有该术语，请检查范围、边界和未扫描前沿。
        </p>
      ) : null}
      <div className="nw-authoring-actions">
        <button
          className="nw-btn"
          type="button"
          disabled={page === 0}
          onClick={() => navigate(page - 1)}
        >
          上一页术语
        </button>
        <button
          className="nw-btn"
          type="button"
          disabled={page + 1 >= pages}
          onClick={() => navigate(page + 1)}
        >
          下一页术语
        </button>
        <button
          className="nw-btn"
          type="button"
          onClick={() => changeFilter({ ...DEFAULT_TERMS_FILTER })}
        >
          重置术语视图筛选
        </button>
      </div>
      {selected ? (
        <TermsLocation
          key={selected.match.id}
          controller={controller}
          row={selected}
          close={close}
        />
      ) : null}
    </section>
  );
}
