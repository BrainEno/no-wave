import { useMemo, useState } from "react";
import { CATALOGUE_CSV_COLUMNS, CATALOGUE_CSV_LABELS, type CatalogueCsvColumn, type CatalogueEntry } from "@/lib/authoring-catalogue.ts";
import { DEFAULT_CATALOGUE_EXPORT, buildCatalogueExport, type CatalogueExport, type CatalogueExportOptions } from "@/lib/authoring-catalogue-export.ts";
import { catalogueLocaleLabel } from "./catalogue-versions.tsx";

function previewText(value: string): string {
  const points = Array.from(value);
  return points.length > 160 ? points.slice(0, 160).join("") + "……（预览截断，文件保留完整元数据）" : value || "（空）";
}

export function CatalogueExportPanel({ selected, disabled, onDownload }: { selected: readonly CatalogueEntry[]; disabled: boolean; onDownload(report: CatalogueExport): void }) {
  const [options, setOptions] = useState<CatalogueExportOptions>(DEFAULT_CATALOGUE_EXPORT);
  const prepared = useMemo(() => {
    if (!selected.length) return { report: null, error: "" };
    try { return { report: buildCatalogueExport(selected, options), error: "" }; }
    catch (error) { return { report: null, error: error instanceof Error ? error.message : "无法准备索引，请重新选择。" }; }
  }, [selected, options]);
  function toggleColumn(column: CatalogueCsvColumn, checked: boolean) {
    if (column === "title" || column === "locale") return;
    const chosen = new Set(options.columns);
    if (checked) chosen.add(column);
    else chosen.delete(column);
    setOptions(current => ({ ...current, columns: CATALOGUE_CSV_COLUMNS.filter(key => chosen.has(key)) }));
  }
  return <section className="nw-catalogue-export" aria-label="CSV 导出预检">
    <p>仅导出明确选择的元数据，不是完整备份；不含正文、图片、账户、作品 ID 或修订凭据。文件中的地址为作品 slug，并非正文附件。</p>
    <details>
      <summary>CSV 导出设置与安全预览</summary>
      <fieldset disabled={disabled}>
        <legend>本次 CSV 元数据列</legend>
        <div className="nw-catalogue-export-columns">{CATALOGUE_CSV_COLUMNS.map(column => <label className="nw-writing-check" key={column}>
          <input type="checkbox" checked={options.columns.includes(column)} disabled={column === "title" || column === "locale"} onChange={event => toggleColumn(column, event.target.checked)} />{CATALOGUE_CSV_LABELS[column]}{column === "title" || column === "locale" ? "（必选）" : ""}
        </label>)}</div>
        <div className="nw-authoring-actions"><button className="nw-btn" type="button" onClick={() => setOptions(current => ({ ...current, columns: CATALOGUE_CSV_COLUMNS }))}>完整元数据列</button><button className="nw-btn" type="button" onClick={() => setOptions(current => ({ ...current, columns: ["title", "locale", "status", "workType", "updatedAt"] }))}>不含摘要简表</button></div>
        <label className="nw-catalogue-export-order">CSV 内部排序<select value={options.order} onChange={event => setOptions(current => ({ ...current, order: event.target.value as CatalogueExportOptions["order"] }))}><option value="selection">按明确选择的顺序</option><option value="title">按标题自然排序</option><option value="updated">按版本最近更新</option></select></label>
      </fieldset>
      <p className="nw-m">这些设置只影响下载文件，不更改目录筛选、分页或服务器作品。标题与语言固定保留；公式前缀保护和控制字符清理不可关闭。</p>
      {prepared.report ? <>
        <p>将导出 {prepared.report.editions} 个语言版本 / {prepared.report.works} 部作品，{prepared.report.columns.length} 列，UTF-8 含 BOM 共 {new Intl.NumberFormat("zh-CN").format(prepared.report.bytes)} 字节。</p>
        <h3>导出预览（前 {prepared.report.preview.length} 个所选版本）</h3>
        <p>下方显示安全处理后的单元格，长字段仅截断预览。CSV 将包含全部 {prepared.report.editions} 个所选版本，完整字段不因预览截断。</p>
        <ol className="nw-catalogue-export-preview">{prepared.report.preview.map(row => <li key={row.entryKey}><dl>{row.cells.map(cell => <div key={cell.column}><dt>{CATALOGUE_CSV_LABELS[cell.column]}</dt><dd>{previewText(cell.value)}</dd></div>)}</dl></li>)}</ol>
        <h3>安全处理说明</h3>
        {prepared.report.protectedCells.length ? <>
          <p>有 {prepared.report.protectedCells.length} 个单元格需要安全处理。为防电子表格执行公式，可能增加开头的单引号或移除不可见控制字符；不会修改服务器原始元数据。</p>
          <ul className="nw-catalogue-export-protection">{prepared.report.protectedCells.map(cell => <li key={`${cell.entryKey}:${cell.column}`}>《{cell.title}》 · {catalogueLocaleLabel(cell.locale)} · {CATALOGUE_CSV_LABELS[cell.column]}：{cell.formulaEscaped ? "已增加公式保护前缀" : "无需公式前缀"}{cell.removedControls ? `，移除 ${cell.removedControls} 个控制字符` : ""}。</li>)}</ul>
        </> : <p>本次所选列无需增加公式前缀或移除控制字符；仍统一引用并转义逗号、双引号及换行。</p>}
      </> : <p>请选择语言版本后查看将要下载的实际元数据预览。</p>}
    </details>
    {prepared.error ? <p role="alert">{prepared.error}</p> : null}
    <button className="nw-btn" type="button" disabled={disabled || !prepared.report} onClick={() => { if (prepared.report) onDownload(prepared.report); }}>导出所选 CSV 元数据</button>
  </section>;
}
