import { useEffect, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { Link } from "@/lib/framework/link.tsx";
import {
  bindCollectionPrivacy,
  CollectionDownloadLease,
} from "@/lib/writing-collection-browser.ts";
import {
  WritingParallelWorkbench,
  type ParallelWorkbenchState,
} from "@/lib/writing-parallel-controller.ts";
import {
  DEFAULT_PARALLEL_POLICY,
  PARALLEL_LIMITS,
  type ParallelPolicy,
} from "@/lib/writing-parallel-model.ts";
import { WritingParallelProfile } from "./writing-parallel-profile.tsx";
import { WritingParallelReview } from "./writing-parallel-review.tsx";

const defaultDraft = (): ParallelPolicy => ({
  ...DEFAULT_PARALLEL_POLICY,
});

export function LocalWritingParallel() {
  const [controller] = useState(() => new WritingParallelWorkbench());
  const [download] = useState(() => new CollectionDownloadLease());
  const [ready, setReady] = useState(false);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const [draft, setDraft] = useState(defaultDraft);
  const [notice, setNotice] = useState<{
    witness: ParallelWorkbenchState;
    message: string;
  } | null>(null);

  useEffect(() => {
    const clear = () => {
      controller.clear();
      download.release();
      setDraft(defaultDraft());
      setNotice(null);
    };
    const release = bindCollectionPrivacy(window, clear, flushSync);
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

  function conditions(next: ParallelPolicy) {
    changed();
    setDraft(next);
    void controller.setPolicy(next);
  }

  function save() {
    let report = controller.getSnapshot().report;
    if (!report) {
      report = controller.prepareReport();
    }
    try {
      download.download(controller.reportDownload(report), () =>
        controller.permitsReport(report),
      );
      setNotice({
        witness: controller.getSnapshot(),
        message:
          "无正文脱敏对照报告已交付浏览器下载。报告仅包含结构相似度、对齐比例与哈希元数据，请妥善保管。",
      });
    } catch {
      setNotice({
        witness: controller.getSnapshot(),
        message:
          "来源、标记或下载确认已变化，或浏览器交付失败；未能导出旧报告，请重新核对。",
      });
    }
  }

  return (
    <section
      className="nw-authoring nw-collections nw-overlap nw-parallel"
      aria-label="本机双语与平行文稿对照审阅工作台"
    >
      <header className="nw-authoring-header">
        <p className="nw-kicker">LOCAL / 多语言对照</p>
        <h1>本机双语与平行文稿对照审阅</h1>
        <p>
          对齐多语言版本（如中/英、简/繁）或不同修订版之间的骨架结构，快速发现单侧段落遗漏、章节标题漂移、外链不对称与插图脱节。
          计算均在浏览器本地内存完成，绝不上传正文，严守隐私底线。
        </p>
        <div className="nw-authoring-actions">
          <Link className="nw-btn" href="/write/collections">
            本机集合工具
          </Link>
          <Link className="nw-btn" href="/write/cadence">
            本机标点与节奏
          </Link>
          <Link className="nw-btn" href="/write/terms">
            本机术语审阅
          </Link>
          <Link className="nw-btn" href="/write">
            返回写作台
          </Link>
          <button className="nw-btn" type="button" onClick={clear}>
            清除全部对照内容
          </button>
        </div>
      </header>

      <p className="nw-merge-warning">
        正文只在使用中的内存处理；不上传、不持久化、不请求来源中的链接或图片，不改原文件、编辑区、恢复缓存或服务器。离页和历史缓存过渡会清空本页，返回不自动重读。
      </p>

      {/* Source slot */}
      <section className="nw-collection-slot" aria-label="双语审阅来源">
        <h2>明确选择本机集合或文稿备份</h2>
        <p>
          请选择包含两篇或多篇文稿的集合 JSON（最多 20 篇 / 16 MiB）。亦可选择单篇备份，但平行对照需要至少两篇文稿以构成对照对。
        </p>
        <label className="nw-writing-file">
          选择双语对照备份或集合文件
          <input
            type="file"
            disabled={!ready}
            accept=".json,application/json"
            onChange={(event) => {
              if (!ready) return;
              changed();
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

        {state.input.status === "reading" || state.input.status === "checking" ? (
          <p role="status">
            {state.input.status === "reading"
              ? `读取中 ${state.input.percent}%`
              : "严格核对完整来源与 SHA-256 中，不接纳部分文稿……"}
          </p>
        ) : null}

        {state.input.status === "failed" ? (
          <p role="alert">载入失败：{state.input.error}</p>
        ) : null}

        {state.input.status === "ready" ? (
          <>
            <p role="status">
              来源校验通过，共包含 {state.input.documents.length} 篇文稿。
            </p>
            <ul aria-label="双语对照文稿列表">
              {state.input.documents.map((doc) => (
                <li key={doc.id}>
                  <code>{doc.id}</code> · <bdi>{doc.title || "（无标题）"}</bdi> ·{" "}
                  <span className="nw-parallel-badge">{doc.locale}</span>
                </li>
              ))}
            </ul>
            {state.input.documents.length < 2 ? (
              <p role="status" className="nw-or">
                提示：当前集合仅有 1 篇文稿，无法构建双语对照对。请使用“本机文稿集合工具”将译稿与原稿打包为集合文件。
              </p>
            ) : null}
          </>
        ) : null}
      </section>

      {/* Analysis Conditions / Policy */}
      <section aria-label="对齐分析条件与阈值">
        <h2>对照分析条件设定</h2>
        <div className="nw-authoring-actions">
          <label>
            对齐范围
            <select
              aria-label="对齐分析范围"
              value={draft.scope}
              onChange={(e) =>
                conditions({
                  ...draft,
                  scope: e.target.value as ParallelPolicy["scope"],
                })
              }
            >
              <option value="all">全量结构（段落、标题、引用、列表）</option>
              <option value="paragraphs">仅正文段落</option>
              <option value="headings">仅章节标题</option>
              <option value="structural">仅结构化骨架（标题与引用）</option>
            </select>
          </label>

          <label>
            长短比例预警阈值
            <select
              aria-label="长短比例预警阈值"
              value={draft.ratioThreshold}
              onChange={(e) =>
                conditions({
                  ...draft,
                  ratioThreshold: Number(e.target.value),
                })
              }
            >
              <option value={2.5}>2.5:1 (严格)</option>
              <option value={3.5}>3.5:1 (标准 - 适合中英)</option>
              <option value={5.0}>5.0:1 (宽松)</option>
            </select>
          </label>

          <label className="nw-writing-check">
            <input
              type="checkbox"
              checked={draft.linkParity}
              onChange={(e) =>
                conditions({
                  ...draft,
                  linkParity: e.target.checked,
                })
              }
            />
            引用外链对称性检查
          </label>
        </div>
      </section>

      {/* Notice alert */}
      {notice ? <p role="status">{notice.message}</p> : null}

      {/* Analysis Results View */}
      {state.analysis ? (
        <>
          <WritingParallelProfile analysis={state.analysis} />

          <WritingParallelReview
            controller={controller}
            analysis={state.analysis}
            marks={state.marks}
            explanation={state.explanation}
          />

          {/* Desensitized Report Download */}
          <section aria-label="脱敏报告导出" className="nw-parallel-detail">
            <h3>导出离线脱敏审计报告</h3>
            <p>
              脱敏报告（JSON）仅包含：分析时间、集合与文稿哈希、对齐度指标、各对齐块的类型与长宽比、异常项统计以及您的人工审阅标记（确认/有意空缺/后续修改）。
              <strong>严禁且不会导出任何正文文字、标题文字或节点结构。</strong>
            </p>
            <div className="nw-authoring-actions">
              <label className="nw-writing-check">
                <input
                  type="checkbox"
                  checked={state.confirmed}
                  onChange={(e) => controller.setConfirmed(e.target.checked)}
                />
                我已知晓报告仅包含脱敏统计与哈希元数据，并授权生成下载
              </label>

              <button
                className="nw-btn"
                type="button"
                disabled={!state.confirmed || !state.analysis}
                onClick={save}
              >
                下载脱敏对照报告 (JSON)
              </button>
            </div>
          </section>
        </>
      ) : null}
    </section>
  );
}
