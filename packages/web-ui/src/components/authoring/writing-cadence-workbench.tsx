import { useEffect, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { Link } from "@/lib/framework/link.tsx";
import {
  bindCollectionPrivacy,
  CollectionDownloadLease,
} from "@/lib/writing-collection-browser.ts";
import {
  WritingCadenceWorkbench,
  type CadenceWorkbenchState,
} from "@/lib/writing-cadence-controller.ts";
import {
  CADENCE_LIMITS,
  DEFAULT_CADENCE_POLICY,
  type CadencePolicy,
} from "@/lib/writing-cadence-model.ts";
import { WritingCadenceReview } from "./writing-cadence-review.tsx";

const defaultDraft = () => ({
  ...DEFAULT_CADENCE_POLICY,
  short: String(DEFAULT_CADENCE_POLICY.short),
  long: String(DEFAULT_CADENCE_POLICY.long),
});

export function LocalWritingCadence() {
  const [controller] = useState(() => new WritingCadenceWorkbench());
  const [download] = useState(() => new CollectionDownloadLease());
  const [ready, setReady] = useState(false);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const [draft, setDraft] = useState(defaultDraft);
  const [notice, setNotice] = useState<{
    witness: CadenceWorkbenchState;
    message: string;
  } | null>(null);
  const analysis = state.analysis;
  useEffect(() => {
    const clear = () => {
      controller.clear();
      download.release();
      setDraft(defaultDraft());
      setNotice(null);
    };
    const release = bindCollectionPrivacy(window, clear, flushSync);
    // SSR markup must not accept a native selection before its handler and privacy boundary exist.
    setReady(true);
    return () => {
      release();
      controller.clear();
      download.release();
    };
  }, [controller, download]);
  useEffect(() => {
    download.release();
  }, [download, state.report, state.confirmed]);
  function changed() {
    download.release();
    setNotice(null);
  }
  function clear() {
    changed();
    controller.clear();
    setDraft(defaultDraft());
  }
  function conditions(next: typeof draft) {
    changed();
    setDraft(next);
    controller.setPolicy({
      ...next,
      short: /^\d+$/u.test(next.short) ? Number(next.short) : NaN,
      long: /^\d+$/u.test(next.long) ? Number(next.long) : NaN,
    });
  }
  function save() {
    const expected = controller.getSnapshot().report;
    try {
      download.download(controller.reportDownload(expected), () =>
        controller.permitsReport(expected),
      );
      setNotice({
        witness: controller.getSnapshot(),
        message:
          "无正文报告已交给浏览器下载，不是已落盘回执。摘要、分布、路径和偏移仍是敏感元数据，请私密保管。",
      });
    } catch {
      setNotice({
        witness: controller.getSnapshot(),
        message:
          "来源、标记或下载确认已变化，或浏览器交付失败；没有继续交付旧报告，请重新核对。",
      });
    }
  }
  return (
    <section
      className="nw-authoring nw-collections nw-overlap nw-cadence"
      aria-label="本机标点与节奏工作台"
    >
      <header className="nw-authoring-header">
        <p className="nw-kicker">LOCAL / 字面校对</p>
        <h1>本机标点与停顿节奏审阅</h1>
        <p>
          检查括号与引号的字面配对、隐形字符、空白和相邻标点，观察停顿片段的长度与顺序。所有结果仅供人工核对，不判语法对错，不自动替换或删除。
        </p>
        <div className="nw-authoring-actions">
          <Link className="nw-btn" href="/write/collections">
            本机集合工具
          </Link>
          <Link className="nw-btn" href="/write/terms">
            本机术语审阅
          </Link>
          <Link className="nw-btn" href="/write">
            返回写作台
          </Link>
          <button className="nw-btn" type="button" onClick={clear}>
            清除全部标点审阅内容
          </button>
        </div>
      </header>
      <p className="nw-merge-warning">
        正文只在使用中的内存处理；不上传、不持久化、不请求来源中的链接或图片，不改原文件、编辑区、恢复缓存或服务器。离页和历史缓存过渡会清空本页，返回不自动重读。清引用不保证安全擦除，也不能防御同源恶意脚本、扩展或系统。
      </p>
      <p>
        配对只在同一个正文连续游程内进行，不跨内容块、内联代码、换行或制表节点。中文弯引号及括号按固定字符配对；ASCII
        引号需显式启用，词内撇号和奇数反斜线转义只按明示规则排除。文学用法、跨段引语、缩写、英尺记号等可能产生有意的观察项。
      </p>
      <section className="nw-collection-slot" aria-label="标点审阅来源">
        <h2>明确选择本机来源</h2>
        <p>
          现有单篇备份 JSON 最多2 MiB，或一份集合最多20篇 / 16
          MiB。不自动读取账户、目录、云端或URL。标题字段、摘要、URL属性、图片说明和代码块不参与分析。
        </p>
        <label className="nw-writing-file">
          标点审阅备份或集合文件
          <input
            type="file"
            disabled={!ready}
            accept=".json,application/json"
            onChange={(event) => {
              if (!ready) return;
              changed();
              // Capture Files before resetting the native control: its FileList is live.
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              if (!files.length) return;
              if (files.length !== 1) {
                controller.clear();
                setNotice({
                  witness: controller.getSnapshot(),
                  message: "一次只明确选择一份文件，不会自动取第一份。",
                });
                return;
              }
              void controller.load(files[0]!);
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
          <p role="status">
            {state.input.status === "reading"
              ? `读取中 ${state.input.percent}%`
              : "严格核对完整来源中，不接纳部分文稿……"}
          </p>
        ) : null}
        {state.input.status === "ready" ? (
          <>
            <p role="status">
              来源校验通过，共{state.input.documents.length}篇。
              {state.input.source === "single"
                ? "原单篇没有集合摘要，当前摘要只属于新建内存快照。"
                : "已核对集合摘要；摘要不是作者签名。"}
            </p>
            <ul aria-label="标点审阅文稿编号">
              {state.input.documents.map((document) => (
                <li key={document.id}>
                  {document.id} · <bdi>{document.title || "（无标题）"}</bdi> ·{" "}
                  {document.locale}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>
      <section aria-label="标点与片段分析条件">
        <h2>明确分析条件</h2>
        <div className="nw-authoring-actions">
          <label>
            标点正文范围
            <select
              aria-label="标点正文范围"
              value={draft.scope}
              onChange={(event) =>
                conditions({
                  ...draft,
                  scope: event.target.value as CadencePolicy["scope"],
                })
              }
            >
              <option value="all">段落、标题、引用、列表项</option>
              <option value="paragraphs">仅段落</option>
              <option value="headings">仅标题单元</option>
              <option value="quotes">仅引用块</option>
              <option value="lists">仅列表项</option>
            </select>
          </label>
          <label>
            ASCII 引号规则
            <select
              aria-label="ASCII 引号规则"
              value={draft.quotes}
              onChange={(event) =>
                conditions({
                  ...draft,
                  quotes: event.target.value as CadencePolicy["quotes"],
                })
              }
            >
              <option value="off">不分析 ASCII 引号</option>
              <option value="double">只分析双引号</option>
              <option value="all">分析单双引号</option>
            </select>
          </label>
          <label>
            短片段阈值（含）
            <input
              inputMode="numeric"
              value={draft.short}
              onChange={(event) =>
                conditions({ ...draft, short: event.target.value })
              }
            />
          </label>
          <label>
            长片段阈值（含）
            <input
              inputMode="numeric"
              value={draft.long}
              onChange={(event) =>
                conditions({ ...draft, long: event.target.value })
              }
            />
          </label>
          <label className="nw-writing-check">
            <input
              type="checkbox"
              checked={draft.dot}
              onChange={(event) =>
                conditions({ ...draft, dot: event.target.checked })
              }
            />
            将 ASCII 句点也作为停顿（仅保护两侧数字的小数点）
          </label>
        </div>
        <p>
          停顿符为 。！？!? 和连续至少两个 …；可另选 ASCII
          句点。连续停顿符及紧随闭符附在同片段，空白不丢弃。不是分句器，不猜缩写、语义或朗读速度。长度是包含标点、引号和格式字符的非空白
          Unicode 代码点数，不是字形数；分位数只用非空片段，纯空白另列。
        </p>
        <div className="nw-authoring-actions">
          <button
            className="nw-btn"
            type="button"
            disabled={
              state.input.status !== "ready" ||
              !state.policy ||
              state.status === "running"
            }
            onClick={() => {
              changed();
              void controller.analyze();
            }}
          >
            分析本机标点与节奏
          </button>
          <button
            className="nw-btn"
            type="button"
            disabled={
              state.input.status === "idle" && state.status !== "running"
            }
            onClick={() => {
              changed();
              controller.cancel();
            }}
          >
            取消本轮标点分析
          </button>
        </div>
      </section>
      {state.status === "running" ? (
        <p role="status">
          {state.progress?.stage === "source" ? "核对来源" : "扫描字面游程"}{" "}
          {state.progress?.done ?? 0} / {state.progress?.total ?? 0}
          ；未发布部分结果。
        </p>
      ) : null}
      {state.status === "cancelled" ? (
        <p role="status">
          已取消，旧发现、定位、标记和报告已撤销；若来源仍在内存，须重新手动分析。
        </p>
      ) : null}
      {state.error ? <p role="alert">{state.error}</p> : null}
      {notice?.witness === state ? <p role="status">{notice.message}</p> : null}
      {analysis ? (
        <>
          <section className="nw-overlap-coverage" aria-label="标点扫描覆盖">
            <h2>本轮覆盖与前沿</h2>
            <p>
              已提交 {analysis.coverage.scannedUnits} /{" "}
              {analysis.coverage.eligibleUnits} 个合格单元，共
              {analysis.coverage.units}个检查单元，按范围或类型排除
              {analysis.coverage.excludedUnits}个。合格正文
              {analysis.coverage.characters}个UTF-16代码单元 /{" "}
              {analysis.coverage.points}个代码点，其中受保护结构
              {analysis.coverage.protectedCharacters}
              个UTF-16代码单元；受保护正文不作为已校对文字。
            </p>
            <p>
              固定上限：{CADENCE_LIMITS.units}单元 / {CADENCE_LIMITS.characters}
              个来源UTF-16代码单元；超限整轮拒绝。计算最多{CADENCE_LIMITS.steps}
              步、{CADENCE_LIMITS.findings}项观察、{CADENCE_LIMITS.pairs}
              个配对、{CADENCE_LIMITS.fragments}个片段、{CADENCE_LIMITS.depth}
              层配对。已尝试{analysis.coverage.steps}
              步，可能包含未提交单元的工作。
            </p>
            {analysis.frontier ? (
              <p role="status">
                未扫描前沿：合格单元序号{analysis.frontier.unit}（从0起），
                {analysis.frontier.document}，路径[
                {analysis.frontier.path.join(", ")}]，UTF-16 /
                代码点起点均为0。原因：{analysis.limit}
                。本单元及后续均未提交；计数只是已扫描前缀的下界，空值不证明未出现。
              </p>
            ) : (
              <p role="status">
                声明范围的全部单元已提交；仍排除代码和结构断点，只反映固定字面规则，不是全文无误证明。
              </p>
            )}
          </section>
          <WritingCadenceReview
            controller={controller}
            analysis={analysis}
            marks={state.marks}
            explanation={state.explanation}
          />
          <section
            className="nw-overlap-report"
            aria-label="手动标点无正文报告"
          >
            <h2>手动无正文报告</h2>
            <p>
              白名单仅含摘要、条件、计数、嵌套关系、本机坐标和人工状态，不含正文、标题、摘要文字、文件名、URL或精确隐形字符序列。元数据仍敏感；不支持导入、应用或恢复。
            </p>
            <button
              className="nw-btn"
              type="button"
              onClick={() => {
                changed();
                controller.prepareReport();
              }}
            >
              准备标点无正文报告
            </button>
            {state.report ? (
              <>
                <p>
                  全局{state.report.items}项 / 尚未核对{state.report.unreviewed}
                  项，{state.report.bytes}字节。列表筛选不缩小范围；超过2
                  MiB整份拒绝，不截短。
                </p>
                <label className="nw-writing-check">
                  <input
                    type="checkbox"
                    checked={state.confirmed}
                    onChange={(event) => {
                      changed();
                      controller.confirmReport(event.target.checked);
                    }}
                  />
                  我已核对标点报告的全局范围、未扫描前沿与元数据隐私风险
                </label>
                <button
                  className="nw-btn"
                  type="button"
                  disabled={!state.confirmed}
                  onClick={save}
                >
                  下载标点无正文报告
                </button>
              </>
            ) : null}
          </section>
        </>
      ) : null}
    </section>
  );
}
