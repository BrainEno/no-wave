import { useEffect, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { Link } from "@/lib/framework/link.tsx";
import {
  bindCollectionPrivacy,
  CollectionDownloadLease,
} from "@/lib/writing-collection-browser.ts";
import {
  WritingMergeWorkbench,
  type WritingMergeState,
} from "@/lib/writing-merge-controller.ts";
import {
  MERGE_ROLES,
  writingMergeProgress,
  type WritingMergeRole,
} from "@/lib/writing-merge.ts";
import { catalogueDate, catalogueLocaleLabel } from "./catalogue-versions.tsx";
import {
  MERGE_ROLE_LABELS,
  WritingMergeReview,
} from "./writing-merge-review.tsx";
import { WritingMergePlanPanel } from "./writing-merge-plan.tsx";
import { WritingMergeResult } from "./writing-merge-result.tsx";

export function LocalWritingMerge() {
  const [controller] = useState(() => new WritingMergeWorkbench());
  const [download] = useState(() => new CollectionDownloadLease());
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const [notice, setNotice] = useState<{
    witness: WritingMergeState;
    text: string;
    error: boolean;
  } | null>(null);
  const allReady = MERGE_ROLES.every(
    (role) => state.slots[role].status === "ready",
  );
  const analysis = state.analysis;
  const progress = analysis
    ? writingMergeProgress(analysis, state.decisions)
    : null;
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

  function feedback(text: string, error = false) {
    setNotice({ witness: controller.getSnapshot(), text, error });
  }
  function choose(role: WritingMergeRole, files: FileList | null) {
    download.release();
    setNotice(null);
    if (!files?.length) return;
    if (files.length !== 1) {
      feedback("每个角色一次只读取一份单篇文稿 JSON。", true);
      return;
    }
    void controller.load(role, files[0]!);
  }
  function clear(role?: WritingMergeRole) {
    controller.clear(role);
    download.release();
    setNotice(null);
  }
  function save(kind: "result" | "plan") {
    try {
      const snapshot = controller.getSnapshot();
      if (kind === "result") {
        const prepared = snapshot.prepared;
        download.download(
          controller.resultDownload(prepared),
          () =>
            prepared !== null && controller.getSnapshot().prepared === prepared,
        );
        feedback(
          "新的合并文稿已交给浏览器下载；没有修改原文件、编辑区或服务器。请妥善保管未加密的文稿。",
        );
      } else {
        const plan = snapshot.planArtifact;
        download.download(
          controller.planDownload(plan),
          () => plan !== null && controller.getSnapshot().planArtifact === plan,
        );
        feedback(
          "人工取舍计划已交给浏览器下载；不含正文，但三份原始文稿必须另外妥善保存。",
        );
      }
    } catch (error) {
      feedback(error instanceof Error ? error.message : "本机下载失败。", true);
    }
  }

  return (
    <section
      className="nw-authoring nw-collections nw-merge"
      aria-label="本机三方文稿合并工作台"
    >
      <header className="nw-authoring-header">
        <p className="nw-kicker">LOCAL / 三方取舍</p>
        <h1>本机三方文稿合并</h1>
        <p>
          用您明确选择的共同基线核对两份改稿，在内存中准备一份新
          JSON。不是服务器修订合并，也不是保存请求的回执。
        </p>
        <div className="nw-authoring-actions">
          <Link className="nw-btn" href="/write/collections">
            本机集合工具
          </Link>
          <Link className="nw-btn" href="/write/vault">
            本机加密备份
          </Link>
          <Link className="nw-btn" href="/write">
            返回写作台
          </Link>
          <button className="nw-btn" type="button" onClick={() => clear()}>
            清除全部合并内容
          </button>
        </div>
      </header>
      <p>
        每份来源须为现有单篇文稿备份 JSON，最多 2 MiB / 200
        个正文块；集合文件请先到本机集合工具拆分。严格检查
        UTF-8、重复字段、结构、链接和节点，不上传文件、不请求其中图片或链接，也不自动存入浏览器。
      </p>
      <p className="nw-merge-warning">
        选错共同基线或人工取舍可能遗漏内容。工具无法证明这三份文件确有共同来源；请自行核对。文件未加密，离开页面或进入历史缓存会清除本页内容，浏览器返回不会自动重读；请先手动下载所需文件与计划。
      </p>
      <div className="nw-merge-slots">
        {MERGE_ROLES.map((role) => {
          const slot = state.slots[role];
          return (
            <section
              className="nw-collection-slot"
              key={role}
              aria-label={`${MERGE_ROLE_LABELS[role]}来源`}
            >
              <h2>{MERGE_ROLE_LABELS[role]}</h2>
              <label className="nw-writing-file">
                {MERGE_ROLE_LABELS[role]}单篇文稿文件
                <input
                  type="file"
                  accept=".json,application/json"
                  onChange={(event) => {
                    choose(role, event.currentTarget.files);
                    event.currentTarget.value = "";
                  }}
                />
              </label>
              <button
                className="nw-btn"
                type="button"
                disabled={slot.status === "idle"}
                onClick={() => clear(role)}
              >
                清除{MERGE_ROLE_LABELS[role]}文件
              </button>
              {slot.name ? (
                <p className="nw-collection-filename">本机文件：{slot.name}</p>
              ) : null}
              {slot.status === "reading" || slot.status === "checking" ? (
                <p role="status">
                  {slot.status === "reading"
                    ? `正在读取 ${slot.percent}%`
                    : "正在严格校验来源，尚未接纳……"}
                </p>
              ) : null}
              {slot.error ? <p role="alert">{slot.error}</p> : null}
              {slot.backup ? (
                <>
                  <p role="status">单篇文稿结构校验通过。</p>
                  <h3>{slot.backup.draft.title || "（无标题）"}</h3>
                  <p>{slot.backup.draft.summary || "（没有摘要）"}</p>
                  <p>
                    {catalogueLocaleLabel(slot.backup.draft.locale)} ·{" "}
                    {slot.backup.draft.workType} ·{" "}
                    {slot.backup.draft.editorState!.root.children.length}{" "}
                    个正文块
                  </p>
                  <p>
                    备份时间 {catalogueDate(slot.backup.createdAt)}{" "}
                    UTC；原备份没有签名，结构校验不证明来源。
                  </p>
                </>
              ) : null}
            </section>
          );
        })}
      </div>
      <label className="nw-writing-check">
        <input
          type="checkbox"
          checked={state.baselineConfirmed}
          disabled={!allReady}
          onChange={(event) => controller.confirmBaseline(event.target.checked)}
        />
        我已核对角色，确认共同基线是两份改稿的共同起点
      </label>
      <div className="nw-authoring-actions">
        <button
          className="nw-btn"
          type="button"
          disabled={
            !allReady ||
            !state.baselineConfirmed ||
            state.analysisStatus === "running"
          }
          onClick={() => {
            download.release();
            void controller.analyze();
          }}
        >
          分析三份本机文稿
        </button>
        {state.analysisStatus === "running" ? (
          <button
            className="nw-btn"
            type="button"
            onClick={() => controller.cancelAnalysis()}
          >
            停止三方分析
          </button>
        ) : null}
      </div>
      {state.analysisStatus === "running" ? (
        <p role="status">正在有界对齐精确内容块；没有生成可下载结果……</p>
      ) : state.analysisStatus === "cancelled" ? (
        <p role="status">三方分析已取消，来源仍在内存中，可重新分析。</p>
      ) : null}
      {state.error ? <p role="alert">{state.error}</p> : null}
      {notice?.witness === state ? (
        <p role={notice.error ? "alert" : "status"}>{notice.text}</p>
      ) : null}
      {analysis && progress ? (
        <>
          <WritingMergeReview
            key={analysis.key}
            controller={controller}
            analysis={analysis}
            decisions={state.decisions}
          />
          <section className="nw-merge-prepare" aria-label="合并结果准备">
            <h2>校验完整输出</h2>
            <p>
              会重新验证合成后的全部字段、节点、文字、块数和字节限制，超限时整份拒绝，不截断或部分导出。
              {progress.unresolved
                ? `尚有 ${progress.unresolved} 项冲突需要取舍。`
                : "所有冲突已取舍，仍需核对生成后的完整结果。"}
            </p>
            <div className="nw-authoring-actions">
              <button
                className="nw-btn"
                type="button"
                disabled={progress.unresolved > 0 || state.preparing}
                onClick={() => {
                  download.release();
                  void controller.prepare();
                }}
              >
                校验并准备合并结果
              </button>
              {state.preparing ? (
                <button
                  className="nw-btn"
                  type="button"
                  onClick={() => controller.cancelPreparation()}
                >
                  停止结果准备
                </button>
              ) : null}
            </div>
            {state.preparing ? (
              <p role="status">
                正在校验合成文稿；来源或人工取舍变化会丢弃旧结果……
              </p>
            ) : null}
          </section>
          {state.prepared ? (
            <WritingMergeResult
              key={state.prepared.digest}
              analysis={analysis}
              decisions={state.decisions}
              prepared={state.prepared}
              save={() => save("result")}
            />
          ) : null}
          <WritingMergePlanPanel
            controller={controller}
            state={state}
            analysis={analysis}
            save={() => save("plan")}
            feedback={feedback}
          />
        </>
      ) : (
        <p>
          读取三份来源并确认角色后才会分析；不会从查询参数、磁盘目录、账号或服务器自动寻找文稿。
        </p>
      )}
    </section>
  );
}
