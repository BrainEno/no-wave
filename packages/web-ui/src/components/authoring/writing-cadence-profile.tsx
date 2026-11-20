import { useMemo, useState } from "react";
import type {
  CadenceAnalysis,
  CadenceFindingKind,
} from "@/lib/writing-cadence-model.ts";
import {
  cadenceProfile,
  compareCadenceDocuments,
} from "@/lib/writing-cadence-profile.ts";
import { cadenceCodepoints } from "@/lib/writing-cadence-review.ts";
import { cadenceEnclosures } from "@/lib/writing-cadence-enclosures.ts";
import { cadencePairRhythm } from "@/lib/writing-cadence-crossings.ts";

export const CADENCE_KIND_NAMES: Record<CadenceFindingKind, string> = {
  "unclosed-open": "游程末仍开放",
  "unexpected-close": "未找到可配对开符",
  "blocked-close": "闭符被内层阻挡",
  invisible: "隐形或特殊字符",
  "whitespace-run": "空白游程",
  "punctuation-run": "相邻标点",
};
const coverageNames = {
  complete: "声明范围已完整扫描",
  partial: "部分扫描",
  unscanned: "未扫描",
  "outside-scope": "无范围内单元",
};
const bandNames = { short: "短", middle: "中", long: "长" };
function fraction(
  value: { numerator: number; denominator: number } | null,
  percent = false,
) {
  if (!value) return "无样本／未定义";
  return `${value.numerator}/${value.denominator}（约${((value.numerator / value.denominator) * (percent ? 100 : 1)).toFixed(3)}${percent ? "%" : ""}）`;
}
type Locate = (id: string, trigger: HTMLButtonElement) => void;

export function WritingCadenceProfile({
  analysis,
  locate,
}: {
  analysis: CadenceAnalysis;
  locate: Locate;
}) {
  const profile = useMemo(() => cadenceProfile(analysis), [analysis]);
  const enclosures = useMemo(() => cadenceEnclosures(analysis), [analysis]);
  const pairRhythm = useMemo(() => cadencePairRhythm(analysis), [analysis]);
  const [symbolDocument, setSymbolDocument] = useState("all"),
    [symbolPage, setSymbolPage] = useState(0);
  const symbols = useMemo(
    () => cadenceCodepoints(analysis, symbolDocument),
    [analysis, symbolDocument],
  );
  const [left, setLeft] = useState(""),
    [right, setRight] = useState("");
  const comparison = useMemo(
    () =>
      left && right && left !== right
        ? compareCadenceDocuments(analysis, left, right)
        : null,
    [analysis, left, right],
  );
  const [unitDocument, setUnitDocument] = useState("all"),
    [unitPage, setUnitPage] = useState(0),
    [showUnits, setShowUnits] = useState(false);
  const units = profile.units.filter(
    (unit) => unitDocument === "all" || unit.document === unitDocument,
  );
  const unitPages = Math.max(1, Math.ceil(units.length / 20)),
    currentUnitPage = Math.min(unitPage, unitPages - 1);
  const symbolPages = Math.max(1, Math.ceil(symbols.length / 20)),
    currentSymbolPage = Math.min(symbolPage, symbolPages - 1);
  return (
    <section aria-label="标点与停顿画像">
      <h3>分布、嵌套与顺序画像</h3>
      <p>
        全局{analysis.findings.length}项观察、{analysis.pairs.length}
        个字面配对、{analysis.fragments.length}个停顿片段。非空样本
        {profile.lengths.samples}个，纯空白{profile.lengths.empty}
        个；非空长度中位数{profile.lengths.median ?? "未定义"}，最近秩P90为
        {profile.lengths.p90 ?? "未定义"}。阈值不是质量评分。
      </p>
      <p>
        配对森林{profile.pairs.roots}棵，最大嵌套{profile.pairs.maximumDepth}
        层；跨度之和{profile.pairs.spanPoints}代码点，按单元并集覆盖
        {profile.pairs.coveredPoints}代码点，嵌套不重复计入并集。相邻片段转移
        {profile.transitions.total}次，其中长短类别改变
        {profile.transitions.changes}次；从不跨文稿、内容块或结构断点连接。
      </p>
      <div
        className="nw-cadence-scroll"
        role="group"
        tabIndex={0}
        aria-label="可横向滚动的文稿节奏表"
      >
        <table>
          <caption>各篇全局画像（不受列表筛选影响）</caption>
          <thead>
            <tr>
              <th scope="col">文稿／覆盖</th>
              <th scope="col">单元／观察</th>
              <th scope="col">配对／深度</th>
              <th scope="col">非空／纯空白样本</th>
              <th scope="col">Q1／中位／Q3／P90</th>
              <th scope="col">短／长／顺序变化</th>
            </tr>
          </thead>
          <tbody>
            {profile.documents.map((document) => (
              <tr key={document.document}>
                <th scope="row">
                  {document.document}
                  <br />
                  {coverageNames[document.coverage]}
                </th>
                <td>
                  {document.scannedUnits}/{document.units}
                  <br />
                  {Object.values(document.findings).reduce((a, b) => a + b, 0)}
                </td>
                <td>
                  {document.pairs.count}/{document.pairs.maximumDepth}
                </td>
                <td>
                  {document.lengths.samples}/{document.lengths.empty}
                </td>
                <td>
                  {[
                    document.lengths.q1,
                    document.lengths.median,
                    document.lengths.q3,
                    document.lengths.p90,
                  ]
                    .map((value) => value ?? "无")
                    .join(" / ")}
                </td>
                <td>
                  {document.lengths.short}/{document.lengths.long}/
                  {document.transitions.changes}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        零只表示已观察前缀的零计数。完整状态仅针对声明的可扫描游程，不含受保护内容；无样本不计算均值、分位或距离。长度可能把多句缩写切开，也可能把多句正文保留在同片段。
      </p>
      <section aria-label="停顿片段与配对交叉画像">
        <h4>片段与字面配对跨度</h4>
        <p>
          同一长度片段可能完整处于配对内、与配对跨度相交却未被单个配对完整包围，或没有相交。这里只描述区间，不推断对话、引文或正文语义。配对并集按原始代码点计，嵌套不重计；相交观察次数可因同一空白观察跨片段而重复，不等于全局观察条数。
        </p>
        <div
          className="nw-cadence-scroll"
          role="group"
          tabIndex={0}
          aria-label="可横向滚动的片段配对交叉表"
        >
          <table>
            <caption>片段与字面配对的交叉分组</caption>
            <thead>
              <tr>
                <th scope="col">文稿／关系</th>
                <th scope="col">片段／非空样本</th>
                <th scope="col">中位／P90</th>
                <th scope="col">配对并集／总代码点</th>
                <th scope="col">相交观察次数</th>
                <th scope="col">前3个位置</th>
              </tr>
            </thead>
            <tbody>
              {enclosures.groups.map((group) => (
                <tr key={`${group.document}/${group.relation}`}>
                  <th scope="row">
                    {group.document}／
                    {group.relation === "contained"
                      ? "完整被包围"
                      : group.relation === "intersecting"
                        ? "相交未完整包围"
                        : "未相交"}
                  </th>
                  <td>
                    {group.fragments}/{group.lengths.samples}
                  </td>
                  <td>
                    {group.lengths.median ?? "无"}/{group.lengths.p90 ?? "无"}
                  </td>
                  <td>
                    {group.pairedPoints}/{group.points}
                  </td>
                  <td>{group.observations}</td>
                  <td>
                    {group.examples.map((id) => (
                      <button
                        className="nw-btn"
                        type="button"
                        key={id}
                        onClick={(event) => locate(id, event.currentTarget)}
                      >
                        定位交叉片段 {id}
                      </button>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          每篇三种关系都保留零值，覆盖状态沿用上方各篇声明；未扫描单元没有参与分组，零不表示正文没有该关系。
        </p>
      </section>
      <section aria-label="配对与停顿边界交叉画像">
        <h4>字面配对跨越的停顿边界</h4>
        <p>
          每个配对记录起点片段、终点片段和跨过的停顿边界数；每个同游程连续停顿边界记录它被多少个配对包住（边界深度）。两个方向独立计算后核对总和相等，不推断嵌套是否有意、不评价句子结构。
        </p>
        <div
          className="nw-cadence-scroll"
          role="group"
          tabIndex={0}
          aria-label="可横向滚动的配对停顿边界表"
        >
          <table>
            <caption>各篇配对与停顿边界交叉（不受列表筛选影响）</caption>
            <thead>
              <tr>
                <th scope="col">文稿／覆盖</th>
                <th scope="col">配对（单片段／跨片段）</th>
                <th scope="col">停顿边界（被包住）</th>
                <th scope="col">最大边界深度</th>
                <th scope="col">配对×边界关联</th>
                <th scope="col">跨片段示例</th>
              </tr>
            </thead>
            <tbody>
              {pairRhythm.documents.map((document) => (
                <tr key={document.document}>
                  <th scope="row">
                    {document.document}
                    <br />
                    {coverageNames[document.coverage]}
                  </th>
                  <td>
                    {document.pairs}（{document.withinOne}/{document.spanning}）
                  </td>
                  <td>
                    {document.seams}（{document.insideSeams}）
                  </td>
                  <td>{document.maximumDepth ?? "无"}</td>
                  <td>{document.pairBoundaryIncidences}</td>
                  <td>
                    {document.examples.length
                      ? document.examples.map((id) => (
                          <button
                            className="nw-btn"
                            type="button"
                            key={id}
                            onClick={(event) => locate(id, event.currentTarget)}
                          >
                            定位跨边界配对 {id}
                          </button>
                        ))
                      : "无跨片段配对"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          边界深度是该停顿边界处于多少个配对的起止之间；为零不等于配对缺失。截断或跳过的单元不产生边界，未扫描文稿保持覆盖状态而不是零配对的证明。
        </p>
      </section>
      <h4>隐形字符精确清单</h4>
      <label>
        隐形字符文稿
        <select
          aria-label="隐形字符文稿"
          value={symbolDocument}
          onChange={(event) => {
            setSymbolDocument(event.target.value);
            setSymbolPage(0);
          }}
        >
          <option value="all">所有文稿</option>
          {analysis.documents.map((document) => (
            <option key={document}>{document}</option>
          ))}
        </select>
      </label>
      <p>
        仅列已标记的隐形／特殊字符，不是全文字符频率。连接符、选择符和不换行空格可能完全有意，方向控制的观察也不是Unicode双向排版正确性验证。
      </p>
      <ul className="nw-collection-rows" aria-label="隐形代码点清单">
        {symbols
          .slice(currentSymbolPage * 20, (currentSymbolPage + 1) * 20)
          .map((symbol) => (
            <li key={symbol.codepoint}>
              <strong>{symbol.codepoint}</strong> · {symbol.category} ·{" "}
              {symbol.count}处 ·{" "}
              {symbol.documents
                .map((document) => `${document.document}:${document.count}`)
                .join(" / ")}
              <div className="nw-authoring-actions">
                {symbol.examples.map((id) => (
                  <button
                    className="nw-btn"
                    type="button"
                    key={id}
                    onClick={(event) => locate(id, event.currentTarget)}
                  >
                    定位隐形字符 {id}
                  </button>
                ))}
              </div>
              <p>最多提供前8个定位入口；全部位置仍在观察列表中。</p>
            </li>
          ))}
      </ul>
      {!symbols.length ? (
        <p>当前已扫描前缀没有此类观察；不是未扫描正文的缺席证明。</p>
      ) : null}
      <div className="nw-authoring-actions">
        <button
          className="nw-btn"
          type="button"
          disabled={currentSymbolPage === 0}
          onClick={() => setSymbolPage(currentSymbolPage - 1)}
        >
          上一页隐形代码点
        </button>
        <span>
          {currentSymbolPage + 1}/{symbolPages}
        </span>
        <button
          className="nw-btn"
          type="button"
          disabled={currentSymbolPage + 1 >= symbolPages}
          onClick={() => setSymbolPage(currentSymbolPage + 1)}
        >
          下一页隐形代码点
        </button>
      </div>
      <h4>明确两篇文稿的观察分布对照</h4>
      <div className="nw-authoring-actions">
        {(
          [
            ["左", left, setLeft],
            ["右", right, setRight],
          ] as const
        ).map(([label, value, update]) => (
          <label key={label}>
            {label}侧节奏文稿
            <select
              aria-label={`${label}侧节奏文稿`}
              value={value}
              onChange={(event) => update(event.target.value)}
            >
              <option value="">请明确选择</option>
              {analysis.documents.map((document) => (
                <option key={document}>{document}</option>
              ))}
            </select>
          </label>
        ))}
      </div>
      {left && left === right ? (
        <p role="alert">请选择两篇不同文稿，不会自动改选。</p>
      ) : null}
      {comparison ? (
        <section aria-label="两稿节奏观察对照">
          <p>
            {comparison.left}：{coverageNames[comparison.coverage.left]}；
            {comparison.right}：{coverageNames[comparison.coverage.right]}。
            {comparison.complete
              ? "两侧声明范围完整。"
              : "至少一侧不完整或无范围内单元；只比较当前观察，不把未覆盖当缺席。"}
          </p>
          <p>
            左减右：中位数差
            {comparison.distribution.medianDifference ?? "未定义"}；均值差
            {fraction(comparison.distribution.meanDifference)}；最大经验CDF差
            {fraction(comparison.distribution.cdfGap, true)}；长度运输距离
            {fraction(comparison.distribution.transport)}
            。这里只比较非空片段的长度分布，不是文本相似度、语义、作者或优劣判断；相同直方图仍可能顺序不同。
          </p>
          <div
            className="nw-cadence-scroll"
            role="group"
            tabIndex={0}
            aria-label="可横向滚动的两稿长度表"
          >
            <table>
              <caption>固定长度区间；差值为非空样本占比左减右</caption>
              <thead>
                <tr>
                  <th scope="col">非空白代码点</th>
                  <th scope="col">左侧数</th>
                  <th scope="col">右侧数</th>
                  <th scope="col">占比差</th>
                </tr>
              </thead>
              <tbody>
                {comparison.distribution.buckets.map((bucket) => (
                  <tr key={bucket.from}>
                    <th scope="row">
                      {bucket.from}–{bucket.to ?? "以上"}
                    </th>
                    <td>{bucket.left}</td>
                    <td>{bucket.right}</td>
                    <td>{fraction(bucket.difference, true)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div
            className="nw-cadence-scroll"
            role="group"
            tabIndex={0}
            aria-label="可横向滚动的两稿顺序表"
          >
            <table>
              <caption>相邻片段类别转移；未连接的样本不补边</caption>
              <thead>
                <tr>
                  <th scope="col">从／到</th>
                  <th scope="col">左</th>
                  <th scope="col">右</th>
                  <th scope="col">全体转移占比差</th>
                </tr>
              </thead>
              <tbody>
                {comparison.transitions.map((cell) => (
                  <tr key={`${cell.from}/${cell.to}`}>
                    <th scope="row">
                      {bandNames[cell.from]}→{bandNames[cell.to]}
                    </th>
                    <td>{cell.left}</td>
                    <td>{cell.right}</td>
                    <td>{fraction(cell.difference, true)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      <button
        className="nw-btn"
        type="button"
        aria-expanded={showUnits}
        onClick={() => setShowUnits(!showUnits)}
      >
        {showUnits ? "收起" : "展开"}单元节奏轮廓
      </button>
      {showUnits ? (
        <section aria-label="单元节奏轮廓">
          <label>
            轮廓文稿
            <select
              aria-label="轮廓文稿"
              value={unitDocument}
              onChange={(event) => {
                setUnitDocument(event.target.value);
                setUnitPage(0);
              }}
            >
              <option value="all">全部</option>
              {analysis.documents.map((document) => (
                <option key={document}>{document}</option>
              ))}
            </select>
          </label>
          <ol className="nw-collection-rows">
            {units
              .slice(currentUnitPage * 20, (currentUnitPage + 1) * 20)
              .map((unit) => (
                <li key={unit.unit}>
                  <strong>{unit.unit}</strong> ·{" "}
                  {unit.scanned ? "已扫描" : "未扫描"} · {unit.points}代码点 /
                  受保护{unit.protectedCharacters} UTF-16代码单元 ·{" "}
                  {unit.findings}观察 / {unit.pairs}配对 / {unit.fragments}片段
                  {unit.longest ? (
                    <button
                      className="nw-btn"
                      type="button"
                      onClick={(event) =>
                        locate(unit.longest!.id, event.currentTarget)
                      }
                    >
                      定位最长片段 {unit.longest.id}（{unit.longest.length}）
                    </button>
                  ) : null}
                </li>
              ))}
          </ol>
          <div className="nw-authoring-actions">
            <button
              className="nw-btn"
              type="button"
              disabled={!currentUnitPage}
              onClick={() => setUnitPage(currentUnitPage - 1)}
            >
              上一页单元轮廓
            </button>
            <span>
              {currentUnitPage + 1}/{unitPages}
            </span>
            <button
              className="nw-btn"
              type="button"
              disabled={currentUnitPage + 1 >= unitPages}
              onClick={() => setUnitPage(currentUnitPage + 1)}
            >
              下一页单元轮廓
            </button>
          </div>
        </section>
      ) : null}
      {profile.documents.some((document) => document.rhythm.length) ? (
        <section aria-label="连续同类片段">
          <h4>至少连续三个短／长片段（每篇最多先列10组）</h4>
          {profile.documents.map((document) => (
            <ul key={document.document}>
              {document.rhythm.slice(0, 10).map((run, index) => (
                <li key={index}>
                  {document.document} · {run.unit} · 连续{run.fragments.length}
                  个{bandNames[run.kind]}片段 · 非空白{run.nonspace}代码点
                  <button
                    className="nw-btn"
                    type="button"
                    onClick={(event) =>
                      locate(run.fragments[0]!, event.currentTarget)
                    }
                  >
                    定位连续片段 {run.fragments[0]}
                  </button>
                </li>
              ))}
            </ul>
          ))}
        </section>
      ) : null}
    </section>
  );
}
