import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";
import { Link } from "@/lib/framework/link.tsx";
import { useConfirm } from "@/components/ui/confirm-dialog.tsx";
import {
  parseWritingBackup,
  WRITING_FIELDS,
  writingDownloadName,
  type WritingField,
} from "@/lib/writing-backup.ts";
import { inspectWriting } from "@/lib/writing-document.ts";
import {
  writingSnapshotKey,
  type WritingDraft,
} from "@/lib/writing-session.ts";
import {
  recoverySize,
  type RecoveryPreview,
} from "@/lib/writing-recovery-model.ts";
import type { WritingRecoveryController } from "@/lib/writing-recovery-controller.ts";
import type { IndexedWritingRecoveryStore } from "@/lib/writing-recovery-store.ts";
import { bindWritingRecovery } from "@/lib/writing-recovery-lifecycle.ts";
import { writingRecoveryBoundary } from "@/lib/writing-recovery-boundary.ts";
import { CollectionDownloadLease } from "@/lib/writing-collection-browser.ts";
import type { RecoverySourceReview } from "@/lib/writing-recovery-source.ts";

export type WritingRecoveryOwner = {
  controller: WritingRecoveryController;
  store: IndexedWritingRecoveryStore;
  actor: string | null;
  source: string;
  register(
    read: () => WritingDraft,
    apply: (draft: WritingDraft) => void,
  ): () => void;
};
type RecoveryProps = {
  owner: WritingRecoveryOwner;
  draft: WritingDraft;
  read(): WritingDraft;
  apply(draft: WritingDraft): void;
  locked: boolean;
};
const LABELS: Record<WritingField, string> = {
  title: "标题",
  summary: "摘要",
  locale: "作品语言",
  workType: "作品类型",
  editorState: "正文（含格式）",
};

function SourceReview({ result }: { result: RecoverySourceReview }) {
  const comparison = result.comparison;
  const changed = comparison?.rows.filter((row) => row.kind !== "same") ?? [];
  const relations = {
    same: "服务器修订与缓存基线相同",
    advanced: "服务器已有更高修订，恢复旧稿可能覆盖新内容",
    rewound: "服务器修订低于缓存基线，请先核对部署或备份回退",
    unknown: "缓存没有可比较的服务器基线修订",
  };
  return (
    <section className="nw-writing-restore" aria-label="来源服务器只读核对">
      <h3>来源服务器只读核对</h3>
      <p>
        核对时间：{new Date(result.checkedAt).toLocaleString()}
        。这是一次读取的结果，不持续跟踪，不表示刚刚保存成功。
      </p>
      {result.kind === "unlinked" ? (
        <p>
          缓存未关联服务器作品，未猜测或读取任何作品。请在新标签页人工核对作品目录。
        </p>
      ) : result.kind === "missing" ? (
        <p>
          来源语言版本不可读取，可能已删除、移动或不属于当前账户；没有回退到其他语言或其他作品。
        </p>
      ) : (
        <>
          <p>
            服务器修订：{result.serverRevision} ·{" "}
            {result.serverStatus === "published" ? "已发布" : "草稿"}。
            {relations[result.relation]}。
          </p>
          <p>
            {result.equivalent
              ? "缓存与这次读取的服务器文稿等价（忽略编辑器默认字段和首尾空白）。"
              : "缓存与这次读取的服务器文稿不同。"}{" "}
            无论是否相同，都不能据此确认原请求是否成功，也不会解除保存拦截。
          </p>
          {comparison?.fields.length ? (
            <dl>
              {comparison.fields.map((field) => (
                <div key={field.field}>
                  <dt>{LABELS[field.field]}</dt>
                  <dd>
                    <pre>
                      缓存：
                      {field.difference.prefix +
                        field.difference.removed +
                        field.difference.suffix}
                      {"\n"}服务器：
                      {field.difference.prefix +
                        field.difference.inserted +
                        field.difference.suffix}
                    </pre>
                    {field.difference.truncated ? (
                      <p>字段片段达到 1200 字符上限，尚有内容未显示。</p>
                    ) : null}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p>标题、摘要、语言和类型相同。</p>
          )}
          {comparison ? (
            <p>
              正文：{comparison.counts.same} 块相同 ·{" "}
              {comparison.counts.changed} 块变化 · {comparison.counts.added}{" "}
              块仅服务器有 · {comparison.counts.removed} 块仅缓存有 ·{" "}
              {comparison.counts.moved} 块位置变化
            </p>
          ) : null}
          {changed.length ? (
            <ol aria-label="缓存与服务器正文差异">
              {changed.map((row, index) => (
                <li key={index}>
                  <p>
                    缓存
                    {row.currentIndex === null
                      ? "无对应块"
                      : `第 ${row.currentIndex + 1} 块`}{" "}
                    / 服务器
                    {row.backupIndex === null
                      ? "无对应块"
                      : `第 ${row.backupIndex + 1} 块`}{" "}
                    · {row.blockType}
                    {row.formatChanged ? " · 文字相同但格式或地址变化" : ""}
                  </p>
                  <pre>
                    缓存：
                    {row.difference.prefix +
                      row.difference.removed +
                      row.difference.suffix}
                    {"\n"}服务器：
                    {row.difference.prefix +
                      row.difference.inserted +
                      row.difference.suffix}
                  </pre>
                  {row.difference.truncated ? (
                    <p>正文片段达到 1200 字符上限，请另行核对完整作品。</p>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : (
            <p>没有不同的正文块。</p>
          )}
        </>
      )}
      <p className="nw-m">
        此处只显示文字差异，不载入图片、不跟随链接，不切换编辑区，不更新缓存基线，不写入服务器。
      </p>
    </section>
  );
}

function RecoveryPlan({
  plan,
  controller,
  draft,
  locked,
}: {
  plan: RecoveryPreview;
  controller: WritingRecoveryController;
  draft: WritingDraft;
  locked: boolean;
}) {
  const [fields, setFields] = useState<WritingField[]>(() =>
    plan.restore.changedFields.filter(
      (field) =>
        !(
          field === "locale" &&
          plan.restore.backup.draft.locale === "zh-TW" &&
          draft.locale !== "zh-TW"
        ) &&
        !(
          field === "workType" &&
          plan.restore.backup.draft.workType === "serial" &&
          draft.workType !== "serial"
        ),
    ),
  );
  const [differentBase, setDifferentBase] = useState(false);
  const [remoteImages, setRemoteImages] = useState(false);
  const inspection = useMemo(
    () => inspectWriting(plan.restore.backup.draft),
    [plan],
  );
  const stale = plan.restore.source !== writingSnapshotKey(draft);
  const source = plan.restore.backup.draft;
  const needsRemote =
    fields.includes("editorState") && plan.restore.remoteImages > 0;
  return (
    <section className="nw-writing-restore" aria-label="本机缓存恢复预览">
      <h3>本机缓存恢复预览</h3>
      <p>
        缓存标题：{source.title || "（空标题）"} · {source.locale} ·{" "}
        {source.workType}
      </p>
      <p>缓存摘要：{source.summary || "（空摘要）"}</p>
      <p>
        缓存时间：{new Date(plan.restore.backup.createdAt).toLocaleString()} ·{" "}
        {inspection.statistics.characters} 个正文字符 ·{" "}
        {inspection.statistics.images} 张图片
      </p>
      <p>正文片段（最多 1200 字符；不加载链接或图片）：</p>
      <pre>
        {inspection.blocks
          .map((block) => block.text)
          .join("\n")
          .slice(0, 1200) || "（没有文字正文）"}
      </pre>
      {plan.outcomeUnknown ? (
        <p role="alert">
          这份稿的上次服务器保存结果未知。恢复后会拦截新的保存或发布，直到您手动核对作品列表并确认；不会重放原请求。
        </p>
      ) : null}
      <fieldset disabled={locked || stale}>
        <legend>选择从缓存恢复的字段</legend>
        {WRITING_FIELDS.map((field) => (
          <label className="nw-writing-check" key={field}>
            <input
              type="checkbox"
              aria-label={`从缓存恢复${LABELS[field]}`}
              checked={fields.includes(field)}
              onChange={(event) => {
                const checked = event.target.checked;
                setFields((values) =>
                  checked
                    ? [...values, field]
                    : values.filter((value) => value !== field),
                );
              }}
            />
            {LABELS[field]}（
            {plan.restore.changedFields.includes(field)
              ? "与当前不同"
              : "与当前相同"}
            ）
          </label>
        ))}
      </fieldset>
      {plan.differentBase ? (
        <label className="nw-writing-check">
          <input
            type="checkbox"
            checked={differentBase}
            onChange={(event) => setDifferentBase(event.target.checked)}
          />
          来源作品或服务器修订与当前目标不同，我仅把所选字段复制到当前编辑区，不更改服务器作品身份
        </label>
      ) : null}
      {needsRemote ? (
        <label className="nw-writing-check">
          <input
            type="checkbox"
            checked={remoteImages}
            onChange={(event) => setRemoteImages(event.target.checked)}
          />
          同意恢复后向 {plan.restore.remoteImages} 张远程图片的地址发出请求
        </label>
      ) : null}
      <button
        className="nw-btn nw-pri"
        type="button"
        disabled={
          locked ||
          stale ||
          !fields.length ||
          (plan.differentBase && !differentBase) ||
          (needsRemote && !remoteImages)
        }
        onClick={() =>
          void controller.restore(fields, { differentBase, remoteImages })
        }
      >
        将缓存所选字段恢复到编辑区
      </button>
      {stale ? (
        <p role="alert">本机恢复预览已过期，当前文稿已变化；请重新预览缓存。</p>
      ) : null}
      {locked ? (
        <p>请先结束当前保存并确认未完成的创建请求；缓存不会替换原请求。</p>
      ) : null}
      <p className="nw-m">
        仅正文进入富文本撤销记录，其他字段不支持富文本撤销。恢复不表示已保存到服务器。
      </p>
    </section>
  );
}

/** Always mounted with Lexical, independently of the optional tools panels. */
export function WritingRecovery({
  owner,
  draft,
  read,
  apply,
  locked,
}: RecoveryProps) {
  const { controller, store, actor, source, register } = owner;
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getServerSnapshot,
  );
  const [consent, setConsent] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [downloads] = useState(() => new CollectionDownloadLease());
  const { confirm, dialog } = useConfirm();
  const summaries = useMemo(
    () =>
      state.entries.map((entry) => ({
        entry,
        draft: parseWritingBackup(entry.backup).draft,
      })),
    [state.entries],
  );
  const bytes = useMemo(
    () => state.entries.reduce((total, row) => total + recoverySize(row), 0),
    [state.entries],
  );
  useLayoutEffect(() => register(read, apply), [register, read, apply]);
  useEffect(() => {
    if (!actor) return;
    const stop = bindWritingRecovery(
      controller,
      actor,
      source,
      writingRecoveryBoundary(),
      {
        window,
        document,
        visible: () => document.visibilityState === "visible",
        flush: flushSync,
      },
    );
    return () => {
      stop();
      downloads.release();
      store.close();
    };
  }, [controller, store, actor, source, downloads]);
  useEffect(() => {
    if (!state.requiresReview) setReviewed(false);
  }, [state.requiresReview]);
  useEffect(() => {
    if (state.status !== "ready") downloads.release();
  }, [state.status, downloads]);

  async function disable() {
    const approved = await confirm({
      title: "清除全部本机缓存并关闭？",
      description:
        "本浏览器本站下所有缓存文稿将被删除，其他标签的旧写入会失效。不会删除服务器作品，也不会清空当前编辑区；需要的旧稿请先下载。",
      confirmLabel: "清除缓存并关闭",
      tone: "danger",
    });
    if (approved) {
      setConsent(false);
      await controller.disable();
    }
  }
  async function discard(id: string, revision: number, title: string) {
    const approved = await confirm({
      title: `删除本机缓存《${title || "空标题"}》？`,
      description:
        "仅删除所选本机版本，不删除服务器作品，不清空当前输入。较新的缓存不会被此确认覆盖或删除。",
      confirmLabel: "删除这份本机缓存",
      tone: "danger",
    });
    if (approved) await controller.discard(id, revision);
  }
  function download(id: string, revision: number) {
    void controller.download(id, revision, (entry, permitted) => {
      const backup = parseWritingBackup(entry.backup);
      downloads.download(
        {
          name: writingDownloadName(backup.draft.title, "json"),
          mime: "application/json;charset=utf-8",
          text: entry.backup,
        },
        permitted,
      );
    });
  }
  return (
    <section
      className="nw-writing-tools nw-writing-recovery"
      aria-label="可选本机文稿恢复"
    >
      <h2>可选本机文稿恢复</h2>
      <p>
        默认关闭。明确启用后，修改会延迟约 0.6 秒缓存到本浏览器本站的
        IndexedDB；刷新后仍需手动预览和恢复。不会自动保存或发布服务器作品，也不保存登录凭据或重试请求。
      </p>
      <p className="nw-m">
        缓存未加密；同源脚本、共用浏览器的人可能读取。不要在共享设备启用。最多
        20 份、合计 16
        MiB，满额不会自动淘汰旧稿。浏览器可清理缓存，崩溃前最后输入未必已落盘；重要内容仍请下载
        JSON 备份。
      </p>
      {state.status === "idle" || state.status === "checking" ? (
        <p role="status">
          正在核对当前账户与本机缓存；不会据缓存推断登录身份。
        </p>
      ) : null}
      {state.status === "off" ? (
        <>
          <p role="status">本机文稿恢复已关闭，未保存输入只在本页。</p>
          <label className="nw-writing-check">
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
            />
            我了解缓存未加密、可被浏览器清理，并同意在此设备保存本机文稿
          </label>
          <button
            className="nw-btn"
            type="button"
            disabled={!consent || !actor}
            onClick={() => void controller.enable()}
          >
            在此设备启用本机恢复
          </button>
        </>
      ) : null}
      {state.status === "ready" ? (
        <>
          <p role="status">
            本机恢复已启用 · {state.entries.length} / 20 份 ·{" "}
            {(bytes / 1024 / 1024).toFixed(2)} / 16 MiB。
            {state.saving
              ? "正在缓存，尚未确认完成。"
              : state.savedAt !== null
                ? `本编辑区上次缓存：${new Date(state.savedAt).toLocaleTimeString()}。不是服务器保存。`
                : "本编辑区尚无未保存缓存。"}
          </p>
          <button
            className="nw-btn"
            type="button"
            disabled={state.saving}
            onClick={() => void controller.flush()}
          >
            立即缓存当前输入
          </button>
        </>
      ) : null}
      {state.error ? (
        <p className="nw-auth-error" role="alert">
          {state.error} 当前输入未被此操作清空；可使用下方文稿工具下载备份。
        </p>
      ) : null}
      {state.status === "revoked" ? (
        <p>
          此旧标签已失效，不能重新开启或保存；请先下载当前输入，再重新载入并核对账户。
        </p>
      ) : (
        <div className="nw-authoring-actions">
          <button
            className="nw-btn"
            type="button"
            disabled={!actor || state.status === "checking"}
            onClick={() => actor && void controller.connect(actor)}
          >
            核对账户并刷新本机列表
          </button>
          {state.status === "ready" || state.status === "error" ? (
            <button
              className="nw-btn"
              type="button"
              onClick={() => void disable()}
            >
              清除全部本机缓存并关闭
            </button>
          ) : null}
        </div>
      )}
      {summaries.length ? (
        <ul aria-label="本机缓存文稿列表">
          {summaries.map(({ entry, draft: cached }) => (
            <li key={entry.id}>
              <p>
                {cached.title || "（空标题）"} · {entry.base.locale} ·{" "}
                {new Date(entry.updatedAt).toLocaleString()} · 本机修订{" "}
                {entry.revision}
                {entry.outcomeUnknown ? " · 上次服务器保存结果未知" : ""}
              </p>
              <p className="nw-m">
                {entry.base.articleId
                  ? `来源作品 ${entry.base.articleId}；服务器修订 ${entry.base.revision ?? "未知"}`
                  : "来源是未关联服务器作品的编辑区"}
                。恢复只复制字段，不切换作品。
              </p>
              <div className="nw-authoring-actions">
                <button
                  className="nw-btn"
                  type="button"
                  disabled={locked}
                  aria-label={`预览本机缓存：${cached.title || "空标题"}`}
                  onClick={() => void controller.preview(entry.id)}
                >
                  预览本机缓存
                </button>
                <button
                  className="nw-btn"
                  type="button"
                  aria-label={`下载本机缓存：${cached.title || "空标题"}`}
                  onClick={() => download(entry.id, entry.revision)}
                >
                  下载此缓存 JSON
                </button>
                <button
                  className="nw-btn"
                  type="button"
                  disabled={state.sourceBusy}
                  aria-label={`核对来源服务器：${cached.title || "空标题"}`}
                  onClick={() => void controller.reviewSource(entry.id)}
                >
                  只读核对来源服务器
                </button>
                <button
                  className="nw-btn"
                  type="button"
                  aria-label={`删除本机缓存：${cached.title || "空标题"}`}
                  onClick={() =>
                    void discard(entry.id, entry.revision, cached.title)
                  }
                >
                  删除此缓存
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {state.sourceBusy ? (
        <p role="status">
          正在只读核对缓存来源的精确语言版本，不会自动重试、保存或发布……
        </p>
      ) : null}
      {state.sourceError ? (
        <p className="nw-auth-error" role="alert">
          来源核对未完成：{state.sourceError}{" "}
          不影响当前输入，未采用旧的服务器响应。
        </p>
      ) : null}
      {state.sourceReview ? <SourceReview result={state.sourceReview} /> : null}
      {state.preview ? (
        <RecoveryPlan
          key={state.preview.witness + state.preview.restore.source}
          plan={state.preview}
          controller={controller}
          draft={draft}
          locked={locked}
        />
      ) : null}
      {state.requiresReview ? (
        <div className="nw-authoring-recovery">
          <p role="alert">
            恢复内容的上次服务器保存结果不明，已拦截新的保存和发布。请先
            <Link
              href="/write/library"
              target="_blank"
              rel="noopener noreferrer"
            >
              在新标签页核对服务器作品目录
            </Link>
            ；本机缓存没有原请求的重试标识，不能用来确认或重放。
          </p>
          <label className="nw-writing-check">
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(event) => setReviewed(event.target.checked)}
            />
            我已核对服务器作品，理解再次保存可能产生重复作品，并确认解除拦截
          </label>
          <button
            className="nw-btn"
            type="button"
            disabled={!reviewed || locked}
            onClick={() => void controller.acknowledgeReview()}
          >
            确认核对并解除保存拦截
          </button>
        </div>
      ) : null}
      {dialog}
    </section>
  );
}
