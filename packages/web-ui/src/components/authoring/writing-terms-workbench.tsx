import { useEffect, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { Link } from "@/lib/framework/link.tsx";
import {
  bindCollectionPrivacy,
  CollectionDownloadLease,
} from "@/lib/writing-collection-browser.ts";
import {
  WritingTermsWorkbench,
  type TermsWorkbenchState,
} from "@/lib/writing-terms-controller.ts";
import { TERMS_LIMITS, type TermsPolicy } from "@/lib/writing-terms-model.ts";
import { OverlapLiteral } from "./writing-overlap-literal.tsx";
import { WritingTermsReview } from "./writing-terms-review.tsx";

const example = JSON.stringify(
  {
    format: "no-wave-writing-terms",
    version: 1,
    rules: [
      { preferred: "无浪潮", alternatives: ["無浪潮"], boundary: "substring" },
      { preferred: "No Wave", alternatives: ["NoWave"], boundary: "word" },
    ],
  },
  null,
  2,
);
const stages = {
  source: "严格复核完整来源",
  catalog: "核对词表同形与包含",
  scan: "扫描完整原文单元",
};

export function LocalWritingTerms() {
  const [controller] = useState(() => new WritingTermsWorkbench());
  const [download] = useState(() => new CollectionDownloadLease());
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const [notice, setNotice] = useState<{
    witness: TermsWorkbenchState;
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
    const unbind = bindCollectionPrivacy(window, clear, flushSync);
    return () => {
      unbind();
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
  function choose(files: FileList | null, recipe = false) {
    changed();
    if (!files?.length) return;
    if (files.length !== 1) {
      controller.clear();
      feedback("每个入口一次只选择一份文件，没有自动取第一份。", true);
      return;
    }
    if (recipe) void controller.loadRecipe(files[0]!);
    else void controller.load(files[0]!);
  }
  function save() {
    const expected = controller.getSnapshot().report;
    try {
      download.download(controller.reportDownload(expected), () =>
        controller.permitsReport(expected),
      );
      feedback(
        "报告已交给浏览器下载，这不是已落盘回执。摘要、坐标、词条长度与分布仍属敏感信息，请私密保管。",
      );
    } catch {
      feedback(
        "报告或确认已变化，或浏览器下载失败。未确认旧输出，请重新核对后重试。",
        true,
      );
    }
  }
  function policy(patch: Partial<TermsPolicy>) {
    changed();
    controller.setPolicy({ ...state.policy, ...patch });
  }
  return (
    <section
      className="nw-authoring nw-collections nw-terms"
      aria-label="本机术语一致性工作台"
    >
      <header className="nw-authoring-header">
        <p className="nw-kicker">LOCAL / 术语审阅</p>
        <h1>本机术语一致性审阅</h1>
        <p>
          明确提供本机文稿和词表，一次核对多个偏好词与变体在各篇的分布、重叠和原始位置。偏好不是“正确答案”，不自动替换、保存或修改文稿。
        </p>
        <div className="nw-authoring-actions">
          <Link className="nw-btn" href="/write/collections">
            本机集合工具
          </Link>
          <Link className="nw-btn" href="/write/overlap">
            段落重复审阅
          </Link>
          <Link className="nw-btn" href="/write">
            返回写作台
          </Link>
          <button
            className="nw-btn"
            type="button"
            onClick={() => {
              changed();
              controller.clear();
            }}
          >
            清除全部术语审阅内容
          </button>
        </div>
      </header>
      <p className="nw-merge-warning">
        只在可信设备使用。正文、词表、索引和临时标记仅留在使用中的内存；不上传、不自动写入浏览器存储、不请求文稿链接或媒体。离页、清除或进入历史缓存时清空，返回不自动重读。内存释放不是物理安全擦除，不能防御同源恶意脚本或扩展。
      </p>
      <section className="nw-collection-slot" aria-label="术语审阅来源">
        <h2>1. 明确选择本机来源</h2>
        <p>
          一份单篇备份 JSON（最多 2 MiB）或集合 JSON（最多 20 篇 / 16
          MiB）；多篇请先用集合工具准备。文件摘要只校验快照，不授予作者身份、媒体或服务器写权限。
        </p>
        <label className="nw-writing-file">
          术语审阅备份或集合文件
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
            来源文件：<bdi>{state.input.name}</bdi>
          </p>
        ) : null}
        {["reading", "checking"].includes(state.input.status) ? (
          <p role="status">
            {state.input.status === "reading"
              ? `读取来源 ${state.input.percent}%`
              : "严格校验完整来源……"}
          </p>
        ) : null}
        {state.input.status === "ready" ? (
          <>
            <p role="status">
              来源校验通过，共 {state.input.documents.length} 篇。
              {state.input.source === "single"
                ? "单篇原文件无集合摘要，仅校验结构并计算内存快照摘要。"
                : "集合摘要已核对，不是作者签名。"}
            </p>
            <ul aria-label="术语来源文稿编号">
              {state.input.documents.map((document) => (
                <li key={document.key}>
                  {document.key} · <bdi>{document.title || "（无标题）"}</bdi> ·{" "}
                  {document.locale}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>
      <section className="nw-collection-slot" aria-label="手动术语词表">
        <h2>2. 输入或导入词表</h2>
        <p>
          严格 v1 JSON，最多 128 KiB / 128 组 / 512 个词条 / 16384
          个代码点。每组一个 preferred 偏好词、至多 7 个 alternatives
          变体、boundary 为 substring（任意位置）或 word（原文相邻字符不得为
          Unicode 字母、数字、组合标记或下划线）。每个词条 1–80
          个代码点，不含首尾空白或控制符。
        </p>
        <label className="nw-writing-file">
          术语词表 JSON 文件
          <input
            type="file"
            accept=".json,application/json"
            onChange={(event) => {
              choose(event.currentTarget.files, true);
              event.currentTarget.value = "";
            }}
          />
        </label>
        {state.recipe.name ? (
          <p>
            词表文件：<bdi>{state.recipe.name}</bdi>
          </p>
        ) : null}
        {state.recipe.status === "reading" ? (
          <p role="status">
            读取词表 {state.recipe.percent}%；尚未使用部分规则。
          </p>
        ) : null}
        <label>
          术语词表 JSON 草稿
          <textarea
            aria-label="术语词表 JSON 草稿"
            rows={12}
            spellCheck={false}
            autoComplete="off"
            value={state.recipe.text}
            onChange={(event) => {
              changed();
              controller.setRecipeText(event.target.value);
            }}
          />
        </label>
        <button
          className="nw-btn"
          type="button"
          onClick={() => {
            changed();
            controller.setRecipeText(example);
          }}
        >
          填入演示词表（覆盖当前草稿）
        </button>
        <p role="status">
          {state.recipe.status === "ready"
            ? "词表结构校验通过；同形和包含风险仍需核对。"
            : "只有有效完整词表才能开始分析；编辑即让旧结果与报告失效。"}
        </p>
        <p>
          同组完全相同的重复词条会拒绝；跨组同形、ASCII
          折叠后同形和互相包含均保留全部命中，不用最长词覆盖短词，也不把变体自动判为错误。word
          是字符边界，不是中文分词或语言学词界。
        </p>
      </section>
      <form
        aria-label="术语分析条件"
        onSubmit={(event) => {
          event.preventDefault();
          changed();
          void controller.analyze();
        }}
      >
        <h2>3. 明确条件后手动分析</h2>
        <div className="nw-collection-filter-grid">
          <label>
            术语文字模式
            <select
              aria-label="术语文字模式"
              value={state.policy.mode}
              onChange={(event) =>
                policy({ mode: event.target.value as TermsPolicy["mode"] })
              }
            >
              <option value="literal">原始字面、区分大小写（默认）</option>
              <option value="ascii-fold">仅 ASCII A–Z 大小写折叠</option>
            </select>
          </label>
          <label>
            术语正文范围
            <select
              aria-label="术语正文范围"
              value={state.policy.scope}
              onChange={(event) =>
                policy({ scope: event.target.value as TermsPolicy["scope"] })
              }
            >
              <option value="all">段落、标题、引用与列表项</option>
              <option value="paragraphs">仅段落</option>
              <option value="headings">仅标题单元</option>
              <option value="quotes">仅引用</option>
              <option value="lists">仅列表项</option>
            </select>
          </label>
        </div>
        <p>
          不做繁简转换、全半角或 NFKC
          规范化，不去标点、不翻译或猜同义词。不跨单元或换行等结构边界，跳过代码块、标题字段、摘要、图片说明；原始
          UTF-16 / 代码点位置不变。
        </p>
        <div className="nw-authoring-actions">
          <button
            className="nw-btn"
            type="submit"
            disabled={
              state.input.status !== "ready" ||
              state.recipe.status !== "ready" ||
              state.status === "running"
            }
          >
            分析本机术语分布
          </button>
          {state.status === "running" ||
          state.input.status === "reading" ||
          state.input.status === "checking" ||
          state.recipe.status === "reading" ? (
            <button
              className="nw-btn"
              type="button"
              onClick={() => {
                changed();
                controller.cancel();
              }}
            >
              停止术语读取或分析
            </button>
          ) : null}
        </div>
      </form>
      {state.status === "running" ? (
        <p role="status">
          {state.progress
            ? `${stages[state.progress.stage]} ${state.progress.done} / ${state.progress.total}`
            : "准备本机分析……"}
          ；尚未发布部分审阅结果。
        </p>
      ) : null}
      {state.status === "cancelled" ? (
        <p role="status">
          已取消，旧结果、标记与报告已失效；仍有效的内存输入可再次手动分析。
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
            aria-label="术语覆盖与未扫描范围"
          >
            <h2>本轮覆盖与限制</h2>
            <p>
              来源 {analysis.coverage.documents} 篇 / {analysis.coverage.units}{" "}
              单元，合格 {analysis.coverage.eligibleUnits} 个，按类型排除{" "}
              {analysis.coverage.excludedUnits} 个。合格原文{" "}
              {analysis.coverage.characters} 个 UTF-16 代码单元 /{" "}
              {analysis.coverage.points} 个代码点；完整扫描{" "}
              {analysis.coverage.scannedUnits} 个单元，已覆盖{" "}
              {analysis.coverage.scannedPoints} 个代码点。
            </p>
            <p>
              扫描转移 {analysis.coverage.steps} / {TERMS_LIMITS.steps}
              ，输出核对 {analysis.coverage.outputs} / {TERMS_LIMITS.outputs}
              ；原文词界排除 {
                analysis.coverage.wordRejected
              } 条，结构边界排除 {analysis.coverage.boundaryRejected}{" "}
              条。最多保留 {TERMS_LIMITS.matches}{" "}
              个命中主张，同一结束位置全部接纳或全部不接纳。
            </p>
            <p>
              来源超过 {TERMS_LIMITS.units} 个单元或 {TERMS_LIMITS.characters}{" "}
              个 UTF-16
              代码单元整轮拒绝，词表超限也不取部分。词表同形/包含目录独立限{" "}
              {TERMS_LIMITS.relations} 条，目录不完整不影响正文扫描规则。
            </p>
            {analysis.frontier ? (
              <p role="status">
                本轮不完整，达到 {analysis.limit} 预算。未扫描前沿：
                {analysis.frontier.unit}，原文 UTF-16 {analysis.frontier.utf16}{" "}
                / 代码点 {analysis.frontier.point}
                ；该位置之后的所有原文均未覆盖，不可把空计数视为没有该术语。
              </p>
            ) : (
              <p>
                本轮声明的合格原文前缀已全部扫描；“未出现”仅按当前字面、范围与边界规则，不代表语义一致性证明。
              </p>
            )}
          </section>
          <WritingTermsReview
            controller={controller}
            analysis={analysis}
            marks={state.marks}
          />
          <section className="nw-overlap-report" aria-label="术语无明文报告">
            <h2>4. 手动准备并核对报告</h2>
            <p>
              报告包含全局命中、计数、尚未核对数、条件、覆盖/前沿、词表关系以及本机文稿编号、节点路径和原文偏移。不包含文稿正文、标题、摘要、原文件名、词条明文、链接或节点
              JSON，不受筛选影响，也不能导入为替换指令。摘要可能被猜测，坐标可推测词条长度，仍需私密保管。
            </p>
            <button
              className="nw-btn"
              type="button"
              onClick={() => {
                changed();
                controller.prepareReport(analysis);
              }}
            >
              准备术语无明文报告
            </button>
            {report ? (
              <>
                <p>
                  全局 {report.claims} 个主张，尚未核对 {report.unreviewed}{" "}
                  个。任何输入、条件或实际标记变化都会撤销此报告与确认。
                </p>
                <OverlapLiteral
                  text={report.artifact.text}
                  label="术语报告预览"
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
                  我已核对术语报告的全局范围、未覆盖前沿与隐私限制
                </label>
                <button
                  className="nw-btn"
                  type="button"
                  disabled={!state.reportConfirmed}
                  onClick={save}
                >
                  下载术语无明文报告
                </button>
              </>
            ) : null}
          </section>
        </>
      ) : null}
    </section>
  );
}
