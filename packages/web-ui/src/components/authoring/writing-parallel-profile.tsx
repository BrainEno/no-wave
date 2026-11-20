import { useMemo } from "react";
import type { ParallelAnalysis, ParallelFindingKind } from "@/lib/writing-parallel-model.ts";
import { parallelProfile } from "@/lib/writing-parallel-profile.ts";

export const PARALLEL_KIND_LABELS: Record<ParallelFindingKind, string> = {
  "missing-block": "单边段落缺失（缺口）",
  "heading-level-drift": "章节标题层级漂移",
  "link-mismatch": "引用外链不对称",
  "link-parity-mismatch": "引用外链不对称",
  "image-mismatch": "插图配置不对称",
  "image-parity-mismatch": "插图配置不对称",
  "extreme-ratio": "字数长度比例极端偏离",
};

export function WritingParallelProfile({
  analysis,
  onSelectPair,
}: {
  analysis: ParallelAnalysis;
  onSelectPair?: (pairId: string) => void;
}) {
  const profile = useMemo(() => parallelProfile(analysis), [analysis]);

  return (
    <section aria-label="双语对照结构与对齐画像" className="nw-parallel-detail">
      <h3>对照结构与不对称画像</h3>
      <p>
        全局已分析 {analysis.pairs.length} 组文稿对，共检出 {analysis.findings.length} 处结构不对称观察项。
        所有指标均由结构骨架与哈希计算，严格不导出正文原文。
      </p>

      <div className="nw-parallel-scroll" role="group" tabIndex={0} aria-label="文稿对照汇总表">
        <table>
          <caption>文稿对齐汇总矩阵</caption>
          <thead>
            <tr>
              <th scope="col">文稿对 (左 ↔ 右)</th>
              <th scope="col">结构相似度</th>
              <th scope="col">对齐块数</th>
              <th scope="col">左侧缺口</th>
              <th scope="col">右侧缺口</th>
              <th scope="col">长度比中位数</th>
              <th scope="col">不对称项</th>
              {onSelectPair ? <th scope="col">定位操作</th> : null}
            </tr>
          </thead>
          <tbody>
            {profile.pairs.map((p) => (
              <tr key={p.pairId}>
                <th scope="row">
                  <code>{p.pairId}</code>
                  <br />
                  <small>
                    {p.leftLocale} ↔ {p.rightLocale}
                  </small>
                </th>
                <td>
                  <strong>{(p.similarityIndex * 100).toFixed(1)}%</strong>
                </td>
                <td>{p.alignedBlocks}</td>
                <td>{p.leftGaps}</td>
                <td>{p.rightGaps}</td>
                <td>{p.medianRatio ? `${p.medianRatio.toFixed(2)}:1` : "无数据"}</td>
                <td>
                  <span className="nw-parallel-badge">
                    {p.asymmetryCounts["missing-block"] +
                      p.asymmetryCounts["heading-level-drift"] +
                      p.asymmetryCounts["link-parity-mismatch"] +
                      p.asymmetryCounts["image-parity-mismatch"] +
                      p.asymmetryCounts["extreme-ratio"]} 项
                  </span>
                </td>
                {onSelectPair ? (
                  <td>
                    <button
                      className="nw-btn"
                      type="button"
                      onClick={() => onSelectPair(p.pairId)}
                    >
                      聚焦此对照对
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h4>不对称类型全局分布</h4>
      <ul>
        {(Object.keys(PARALLEL_KIND_LABELS) as ParallelFindingKind[]).map((kind) => {
          const count = profile.globalAsymmetryCounts[kind];
          return (
            <li key={kind}>
              <strong>{PARALLEL_KIND_LABELS[kind]}：</strong>
              <span>{count} 处</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
