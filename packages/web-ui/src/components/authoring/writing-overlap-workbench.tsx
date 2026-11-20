import { useEffect, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { Link } from "@/lib/framework/link.tsx";
import {
  bindCollectionPrivacy,
  CollectionDownloadLease,
} from "@/lib/writing-collection-browser.ts";
import {
  WritingOverlapWorkbench,
  type OverlapWorkbenchState,
} from "@/lib/writing-overlap-controller.ts";
import {
  OVERLAP_LIMITS,
  type OverlapLimit,
} from "@/lib/writing-overlap-model.ts";
import { WritingOverlapConditions } from "./writing-overlap-conditions.tsx";
import { OverlapLiteral } from "./writing-overlap-literal.tsx";
import { WritingOverlapReview } from "./writing-overlap-review.tsx";

const STAGES = {
  source: "重新校验来源并提取文字",
  index: "建立有界片段索引",
  candidates: "发现有界候选",
  compare: "核对完整片段集合",
};
const LIMITS: Record<OverlapLimit, string> = {
  "long-unit": "超长文字组仅参加同文字分组，未参加近似筛查。",
  "index-budget": "部分文字组未进入近似索引，片段成员总数达到预算。",
  "common-grams":
    "常见片段的整份索引项被移除；仅靠这些片段相交的候选可能漏掉。",
  "candidate-budget": "候选组对达到预算，未继续发现后续候选。",
  "posting-budget": "索引配对访问达到预算，部分索引未遍历完成。",
  "comparison-budget": "完整集合比较达到预算，部分已发现候选未评分。",
  "result-budget":
    "列表达到上限，同文字组优先；近似仅保留已完整评分候选中分数最高的部分。",
};

export function LocalWritingOverlap() {
  const [controller] = useState(() => new WritingOverlapWorkbench());
  const [download] = useState(() => new CollectionDownloadLease());
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const [notice, setNotice] = useState<{
    witness: OverlapWorkbenchState;
    text: string;
    error: boolean;
  } | null>(null);
  const analysis = state.analysis,
    report = state.report;
  useEffect(() => {
    const clear = () => {
      controller.clear();
      download.release();
      setNotice(null);
    };
    const release = bindCollectionPrivacy(window, clear, flushSync);
    return () => {
      release();
      controller.clear();
      download.release();
    };
  }, [controller, download]);
  useEffect(() => {
    download.release();
  }, [download, report, state.reportConfirmed]);
  function changed() {
    download.release();
    setNotice(null);
  }
  function feedback(text: string, error = false) {
    setNotice({ witness: controller.getSnapshot(), text, error });
  }
  function choose(files: FileList | null) {
    changed();
    if (!files?.length) return;
    if (files.length !== 1) {
      controller.clear();
      feedback("一次只明确读取一份备份或集合，不会自动取第一份。", true);
      return;
    }
    void controller.load(files[0]!);
  }
  function clear() {
    changed();
    controller.clear();
  }
  function save() {
    const expected = controller.getSnapshot().report;
    try {
      download.download(controller.reportDownload(expected), () =>
        controller.permitsReport(expected),
      );
      feedback(
        "无正文报告已交给浏览器下载；这不是已落盘回执。报告含本机坐标、摘要和计数，请仍按私密文件保管。",
      );
    } catch {
      feedback(
        "报告、人工标记或确认已变化，或浏览器下载失败；没有确认旧输出，请核对当前报告后重试。",
        true,
      );
    }
  }
  return (
    <section
      className="nw-authoring nw-collections nw-overlap"
      aria-label="本机文稿重复段落工作台"
    >
      <header className="nw-authoring-header">
        <p className="nw-kicker">LOCAL / 段落审阅</p>
        <h1>本机文稿重复段落审阅</h1>
        <p>
          从您明确选择的备份中找出同文字组与近似候选，逐处只读核对，临时标记后手动导出无正文报告。不自动删除、去重、合并或修改文稿。
        </p>
        <div className="nw-authoring-actions">
          <Link className="nw-btn" href="/write/collections">
            本机集合工具
          </Link>
          <Link className="nw-btn" href="/write">
            返回写作台
          </Link>
          <button className="nw-btn" type="button" onClick={clear}>
            清除全部段落审阅内容
          </button>
        </div>
      </header>
      <p>
        支持现有单篇备份 JSON（最多 2 MiB）或一份集合 JSON（最多 20 篇 / 16
        MiB）。需核对多篇时，请先在本机集合工具准备集合；不自动读取目录、账户、云端或查询参数里的地址。
      </p>
      <p className="nw-merge-warning">
        仅在可信设备使用。正文、索引和临时标记留在使用中的内存；本工具不上传、不自动写入浏览器存储，也不请求文稿中的链接或图片。离页、清除或进入历史缓存会清空本页，返回不自动重读。内存释放不等于物理安全擦除，也不能防御同源恶意脚本或扩展。
      </p>
      <p>
        近似算法是五个连续 Unicode 代码点的片段集合
        Jaccard，不是语义理解、抄袭判定或编辑指令；不跨段拼接，不比较标题字段、摘要、图片说明和代码。文件摘要只校验本机快照，不证明作者、归属、媒体访问或服务器写权限。三方合并仍保持原有保守规则。
      </p>
      <section className="nw-collection-slot" aria-label="段落审阅来源">
        <h2>明确选择本机来源</h2>
        <label className="nw-writing-file">
          段落审阅备份或集合文件
          <input
            type="file"
            accept=".json,application/json"
            onChange={(event) => {
              choose(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
          />
        </label>
        {state.input.name ? (
          <p className="nw-collection-filename">
            当前本机文件：<bdi>{state.input.name}</bdi>
          </p>
        ) : null}
        {state.input.status === "reading" ||
        state.input.status === "checking" ? (
          <>
            <p role="status">
              {state.input.status === "reading"
                ? `正在读取本机文件 ${state.input.percent}%`
                : "正在严格校验完整来源，尚未接纳部分文稿……"}
            </p>
            <button
              className="nw-btn"
              type="button"
              onClick={() => {
                changed();
                controller.cancel();
              }}
            >
              停止读取来源
            </button>
          </>
        ) : null}
        {state.input.status === "ready" ? (
          <>
            <p role="status">
              来源结构校验通过，共 {state.input.documents.length} 篇。
              {state.input.source === "single"
                ? "原单篇文件没有集合摘要；只校验格式并为当前内存快照计算摘要。"
                : "集合摘要已核对，但不是作者签名。"}
            </p>
            <ul aria-label="段落审阅文稿编号">
              {state.input.documents.map((document) => (
                <li key={document.key}>
                  {document.key} · {document.title || "（无标题）"} ·{" "}
                  {document.locale}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>
      {state.input.status === "ready" ? (
        <WritingOverlapConditions
          controller={controller}
          state={state}
          changed={changed}
        />
      ) : null}
      {state.status === "running" ? (
        <p role="status">
          {state.progress
            ? `${STAGES[state.progress.stage]}：${state.progress.done} / ${state.progress.total}`
            : "准备本机分析……"}
          ；尚无可审阅或下载的部分结果。
        </p>
      ) : null}
      {state.status === "cancelled" ? (
        <p role="status">
          本轮分析已取消，旧候选、标记与报告均已失效；已校验的来源若仍在内存，可重新手动分析。
        </p>
      ) : null}
      {state.error ? <p role="alert">{state.error}</p> : null}
      {notice?.witness === state ? (
        <p role={notice.error ? "alert" : "status"}>{notice.text}</p>
      ) : null}
      {analysis ? (
        <>
          <section
            className="nw-overlap-coverage"
            aria-label="段落分析覆盖与限制"
          >
            <h2>本轮覆盖与限制</h2>
            <p>
              检查 {analysis.coverage.documents} 篇 / {analysis.coverage.units}{" "}
              个文字单元，合格 {analysis.coverage.eligible}{" "}
              个，按类型、空白或长度排除 {analysis.coverage.excluded}{" "}
              个。合格文字分成 {analysis.coverage.families}{" "}
              组，全部保留原始位置；同文字分组不使用近似分数。
            </p>
            <p>
              近似索引接纳 {analysis.coverage.indexed} 个文字组；
              {analysis.coverage.long} 个超长组只做同文字分组；索引片段成员{" "}
              {analysis.coverage.grams}，移除常见片段 {analysis.coverage.common}
              。发现候选组对 {analysis.coverage.candidates}，完整评分{" "}
              {analysis.coverage.compared}；共有 {analysis.coverage.qualified}{" "}
              项已知符合条件，列表显示{" "}
              {analysis.exact.length + analysis.near.length} 项。
            </p>
            <p>
              计算预算：最多 {OVERLAP_LIMITS.units}{" "}
              个文字单元，原始及规范化文字各 {OVERLAP_LIMITS.characters} 个
              UTF-16 代码单元；超限整轮拒绝。近似每组最多{" "}
              {OVERLAP_LIMITS.nearCharacters} 个代码点，
              {OVERLAP_LIMITS.indexGrams} 个索引片段成员，单片段最多{" "}
              {OVERLAP_LIMITS.posting} 组，{OVERLAP_LIMITS.postingSteps}{" "}
              次索引配对访问、{OVERLAP_LIMITS.candidates} 对候选、
              {OVERLAP_LIMITS.comparisonSteps} 次片段成员比较，最多列出{" "}
              {OVERLAP_LIMITS.results} 项。
            </p>
            {analysis.limits.length ? (
              <>
                <p role="status">
                  本轮存在未覆盖范围，不能把空列表或已列结果视为完整无重复证明。
                </p>
                <ul>
                  {analysis.limits.map((limit) => (
                    <li key={limit}>{LIMITS[limit]}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p>
                本轮未触发计算上限；仅覆盖声明的合格单元和字面/片段集合条件，仍可能有语义、翻译或跨段重复未被识别。
              </p>
            )}
          </section>
          <WritingOverlapReview
            controller={controller}
            analysis={analysis}
            marks={state.marks}
          />
          <section
            className="nw-overlap-report"
            aria-label="手动无正文审阅报告"
          >
            <h2>准备无正文报告</h2>
            <p>
              报告包含全局已列候选、尚未核对数量、条件、覆盖限制、文件本机编号/路径和集合摘要；不包含正文、标题、摘要、原文件名、链接或节点
              JSON。不受列表筛选影响，不能导入为去重、合并或写稿指令。
            </p>
            <button
              className="nw-btn"
              type="button"
              onClick={() => {
                changed();
                controller.prepareReport(analysis);
              }}
            >
              准备当前无正文报告
            </button>
            {report ? (
              <div className="nw-collection-plan-preview">
                <p role="status">
                  报告已准备：{report.findings} 项，尚未核对 {report.unreviewed}{" "}
                  项；标记完成不代表算法覆盖完整。
                </p>
                <OverlapLiteral
                  key={`${report.sourceKey}:${report.marksKey}`}
                  label="无正文报告 JSON"
                  text={report.artifact.text}
                />
                <label className="nw-writing-check">
                  <input
                    type="checkbox"
                    checked={state.reportConfirmed}
                    onChange={(event) => {
                      changed();
                      controller.confirmReport(report, event.target.checked);
                    }}
                  />
                  我已核对报告范围，理解无正文报告仍含私密元数据
                </label>
                <button
                  className="nw-btn"
                  type="button"
                  disabled={!controller.permitsReport(report)}
                  onClick={save}
                >
                  下载无正文段落报告
                </button>
              </div>
            ) : null}
          </section>
        </>
      ) : null}
    </section>
  );
}
