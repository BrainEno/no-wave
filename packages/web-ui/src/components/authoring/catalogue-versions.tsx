import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@/lib/framework/link.tsx";
import { catalogueCoverage, compareCatalogueVersions, type CatalogueInspection } from "@/lib/authoring-catalogue-versions.ts";
import { catalogueOpenHref } from "@/lib/authoring-catalogue.ts";

export const catalogueLocaleLabel = (locale: string): string => locale === "zh-CN" ? "简体中文" : locale === "zh-TW" ? "繁體中文" : "English";
export function catalogueDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value));
}

export function CatalogueVersions({ inspection, actor, close }: { inspection: CatalogueInspection; actor: string; close(): void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const [leftLocale, setLeftLocale] = useState(inspection.editions[0]?.locale ?? "");
  const [rightLocale, setRightLocale] = useState(inspection.editions[1]?.locale ?? "");
  const comparison = useMemo(() => {
    if (!leftLocale || !rightLocale || leftLocale === rightLocale) return null;
    try { return compareCatalogueVersions(inspection.editions, leftLocale, rightLocale); } catch { return null; }
  }, [inspection.editions, leftLocale, rightLocale]);
  return <section className="nw-catalogue-inspection" aria-label="语言版本预览">
    <div className="nw-authoring-actions"><h2 ref={heading} tabIndex={-1}>《{inspection.source.title}》的语言版本</h2><button className="nw-btn" type="button" onClick={close}>关闭版本预览</button></div>
    {inspection.status === "loading" ? <p role="status">正在单独核对本作品全部语言，不受目录筛选影响……</p> : null}
    {inspection.error ? <p role="alert">{inspection.error}</p> : null}
    {inspection.status === "ready" ? <>
      <p>以下是本次请求时已存在的完整版本清单。不同语言的文字不需要相同，更新时间先后不等于翻译质量或同步状态；发布状态和作品类型属于整部作品。</p>
      <ul className="nw-catalogue-coverage">{catalogueCoverage(inspection.editions).map(({ locale, entry }) => <li key={locale}>
        <h3>{catalogueLocaleLabel(locale)} · {entry ? "已有版本" : "尚无版本"}</h3>
        {entry ? <>
          <p>{entry.title}</p><p className="nw-m">{entry.summary || "（没有摘要）"}</p>
          <p className="nw-m">版本更新：{catalogueDate(entry.updatedAt)} UTC</p>
          {entry.deletedAt ? <p>在回收站中，需先还原整部作品。</p> : <Link className="nw-btn" href={catalogueOpenHref(entry, actor)}>打开{catalogueLocaleLabel(locale)}版本</Link>}
        </> : <p>本操作不会创建译本；如需添加，请在编辑器中明确选择新的作品语言并保存。</p>}
      </li>)}</ul>
      {inspection.editions.length > 1 ? <>
        <h3>标题与摘要对照</h3>
        <div className="nw-catalogue-filter-grid">
          <label>对照左侧语言<select value={leftLocale} onChange={event => setLeftLocale(event.target.value)}><option value="">选择版本</option>{inspection.editions.map(entry => <option key={entry.locale} value={entry.locale}>{catalogueLocaleLabel(entry.locale)}</option>)}</select></label>
          <label>对照右侧语言<select value={rightLocale} onChange={event => setRightLocale(event.target.value)}><option value="">选择版本</option>{inspection.editions.map(entry => <option key={entry.locale} value={entry.locale}>{catalogueLocaleLabel(entry.locale)}</option>)}</select></label>
        </div>
        {comparison ? <dl className="nw-catalogue-comparison">{comparison.fields.map(({ field, difference }) => <div key={field}>
          <dt>{field === "title" ? "标题" : "摘要"} · {difference.textEqual ? "相同" : "不同"}</dt>
          <dd><span>{difference.prefix}</span>{difference.removed ? <del aria-label={`${catalogueLocaleLabel(leftLocale)}内容`}>{difference.removed}</del> : null}{difference.inserted ? <ins aria-label={`${catalogueLocaleLabel(rightLocale)}内容`}>{difference.inserted}</ins> : null}<span>{difference.suffix}</span>
            {difference.truncated ? <small>片段超过 1200 字符，仅显示部分；完整文字见上方版本摘要。</small> : null}</dd>
        </div>)}</dl> : <p>请选择两个不同的已有语言。删除线为左侧文字，下划线为右侧文字，仅供核对，不会自动合并或保存。</p>}
        <p className="nw-m">删除线为左侧文字，下划线为右侧文字。此处只对照元数据，不下载或比较正文。</p>
      </> : null}
    </> : null}
  </section>;
}
