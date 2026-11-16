import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { catalogueEntryKey, type CatalogueEntry } from "@/lib/authoring-catalogue.ts";
import { CATALOGUE_REVIEW_WORK_LIMIT, CatalogueReviewController, catalogueSelectionFingerprint, reviewedCatalogueSelection, type CatalogueReviewDifference } from "@/lib/authoring-catalogue-review.ts";
import { getMessages } from "@/lib/content.ts";
import { catalogueDate, catalogueLocaleLabel } from "./catalogue-versions.tsx";

const FIELD_LABELS = { title: "标题", summary: "摘要", slug: "作品地址", status: "发布状态", workType: "作品类型", createdAt: "版本创建时间", updatedAt: "版本更新时间", deletedAt: "删除时间" };
const STATUS_LABELS = { waiting: "尚未核对", checking: "正在核对", ready: "已读取完整语言清单", unavailable: "本次范围内无法确认", failed: "读取失败" };
function reviewValue(field: keyof typeof FIELD_LABELS, entry: CatalogueEntry): string {
  const value = entry[field];
  if (value === null) return "未删除";
  if (field === "status") return value === "draft" ? "草稿" : "已发布";
  if (field === "workType") return getMessages("zh-CN").workTypeLabels[entry.workType];
  if (field.endsWith("At")) return catalogueDate(value) + " UTC";
  return value || "（空）";
}
function VersionDifference({ difference }: { difference: CatalogueReviewDifference }) {
  return <section className="nw-catalogue-review-version" aria-label={`${catalogueLocaleLabel(difference.before.locale)}核对结果`}>
    <h4>{catalogueLocaleLabel(difference.before.locale)} · {difference.kind === "changed" ? "存在元数据差异" : difference.kind === "unchanged" ? "与选择时相同" : "所选语言未能确认"}</h4>
    {difference.current ? difference.fields.length ? <dl>{difference.fields.map(field => <div key={field}>
      <dt>{FIELD_LABELS[field]}</dt><dd><p><strong>选择时：</strong>{reviewValue(field, difference.before)}</p><p><strong>本次核对：</strong>{reviewValue(field, difference.current!)}</p></dd>
    </div>)}</dl> : <p>本次响应的标题、摘要、地址、发布状态、类型及时间与所选快照一致。</p> : <p>完整语言清单中没有这个所选版本。它可能已移动或被更改；不会自动移除选择，也不据此断言永久删除。</p>}
  </section>;
}

type SelectionProps = {
  actor: string; scope: "active" | "trash"; selected: readonly CatalogueEntry[]; visible: readonly CatalogueEntry[]; disabled: boolean;
  onRemove(key: string): void;
  onApply(actor: string, fingerprint: string, entries: readonly CatalogueEntry[]): boolean;
  onAccountRefused(reason: "unauthenticated" | "account-changed"): void;
  onRateLimited(deadline: number): void;
};

export function CatalogueSelection({ actor, scope, selected, visible, disabled, onRemove, onApply, onAccountRefused, onRateLimited }: SelectionProps) {
  const [controller] = useState(() => new CatalogueReviewController(undefined, Date.now, onAccountRefused, onRateLimited));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [onlyChanges, setOnlyChanges] = useState(false);
  const [applyError, setApplyError] = useState("");
  const [clock, setClock] = useState(0);
  const fingerprint = catalogueSelectionFingerprint(selected);
  const serializedSelection = JSON.stringify(selected);
  const chosen = useMemo(() => JSON.parse(serializedSelection) as CatalogueEntry[], [serializedSelection]);
  const visibleKeys = new Set(visible.map(catalogueEntryKey));
  const chosenWorks = new Set(selected.map(entry => entry.id)).size;
  const remaining = Math.max(0, Math.ceil((state.retryAt - clock) / 1000));
  const differences = state.works.flatMap(work => work.differences);
  const changed = differences.filter(difference => difference.kind === "changed").length;
  const unchanged = differences.filter(difference => difference.kind === "unchanged").length;
  const completedWorks = state.works.filter(work => work.status === "ready").length;
  const shown = onlyChanges ? state.works.filter(work => work.status !== "ready" || work.differences.some(difference => difference.kind !== "unchanged")) : state.works;

  useEffect(() => {
    controller.configure({ actor, scope, selected: chosen });
    if (disabled) controller.cancel();
    setApplyError("");
    return () => controller.cancel();
  }, [controller, actor, scope, chosen, disabled]);
  useEffect(() => {
    if (!state.retryAt) return;
    const tick = () => setClock(Date.now());
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [state.retryAt]);

  function acceptReview() {
    try {
      if (!state.plan || disabled || state.plan.fingerprint !== fingerprint) throw new Error("当前选择、账户或筛选已经变化，请重新核对后再应用。");
      const entries = reviewedCatalogueSelection(state);
      if (!onApply(actor, fingerprint, entries)) throw new Error("选择或账户已变化，旧核对结果没有覆盖当前索引。");
      setApplyError("");
    } catch (error) { setApplyError(error instanceof Error ? error.message : "核对结果未应用。"); }
  }

  if (!selected.length) return null;
  return <section className="nw-catalogue-selection" aria-label="所选版本核对">
    <details>
      <summary>核对所选清单：{selected.length} 个版本 / {chosenWorks} 部作品</summary>
      <p>这里包含此前分页中选择的条目。移除只改变本次索引选择，不删除服务器作品；改变选择会取消正在进行的核对。</p>
      <ol className="nw-catalogue-chosen">{selected.map(entry => <li key={catalogueEntryKey(entry)}>
        <span>《{entry.title}》 · {catalogueLocaleLabel(entry.locale)} · {visibleKeys.has(catalogueEntryKey(entry)) ? "当前页可见" : "在其他已浏览页面"}</span>
        <button className="nw-btn" type="button" disabled={disabled} aria-label={`移除所选《${entry.title}》${catalogueLocaleLabel(entry.locale)}`} onClick={() => onRemove(catalogueEntryKey(entry))}>从索引移除</button>
      </li>)}</ol>
    </details>
    <details className="nw-catalogue-review">
      <summary>下载前只读核对与差异审核</summary>
      <p>可选步骤：再次读取所选作品的轻量语言清单，比较选择时的快照。每次最多 {CATALOGUE_REVIEW_WORK_LIMIT} 部独立作品，逐部读取，不取正文、不写作品、不自动重试。</p>
      <p className="nw-m">不是跨作品或跨请求快照；核对后仍可能发生并发编辑。发现其他语言不会自动加入选择；只有全部成功并由您明确应用，才更新本次 CSV 的所选快照。</p>
      <div className="nw-authoring-actions"><button className="nw-btn" type="button" disabled={disabled || state.status === "running" || chosenWorks > CATALOGUE_REVIEW_WORK_LIMIT || remaining > 0} onClick={() => { void controller.start(); }}>只读核对所选版本</button>
        {state.status === "running" ? <button className="nw-btn" type="button" onClick={() => controller.cancel()}>停止只读核对</button> : null}
        <button className="nw-btn" type="button" disabled={disabled || state.status !== "complete" || !changed} onClick={acceptReview}>用完整核对结果更新所选索引</button>
      </div>
      {remaining ? <p role="status">核对请求受限，至少等待 {remaining} 秒后手动继续；其余作品没有继续请求。</p> : null}
      {state.error ? <p role={state.status === "invalid" ? "status" : "alert"}>{state.error}</p> : null}
      {applyError ? <p role="alert">{applyError}</p> : null}
      {state.status !== "idle" && state.status !== "invalid" ? <p role="status">已读取 {completedWorks} / {state.works.length} 部作品；{changed} 个所选版本有差异，{unchanged} 个相同，{Math.max(0, selected.length - changed - unchanged)} 个尚未确认。选择尚未被自动更改。</p> : null}
      {state.works.some(work => work.status !== "waiting") ? <>
        <label className="nw-writing-check"><input type="checkbox" checked={onlyChanges} onChange={event => setOnlyChanges(event.target.checked)} />只显示有差异或未确认的作品</label>
        <ol className="nw-catalogue-review-results">{shown.map(work => <li key={work.id}>
          <details><summary>《{work.title}》 · {STATUS_LABELS[work.status]}</summary>
            {work.checkedAt ? <p className="nw-m">本次读取：{catalogueDate(work.checkedAt)} UTC。只代表该请求时的元数据。</p> : null}
            {work.error ? <p>{work.error}</p> : null}
            {work.differences.map(difference => <VersionDifference key={catalogueEntryKey(difference.before)} difference={difference} />)}
            {work.editions.length > work.differences.length ? <p>此作品另有 {work.editions.length - work.differences.length} 个已有语言未被选择，没有自动加入导出。</p> : null}
          </details>
        </li>)}</ol>
        {!shown.length ? <p>没有符合“差异或未确认”的作品。</p> : null}
      </> : null}
    </details>
  </section>;
}
