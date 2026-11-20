import { useEffect, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { Link } from "@/lib/framework/link.tsx";
import {
  bindCollectionPrivacy,
  CollectionDownloadLease,
} from "@/lib/writing-collection-browser.ts";
import {
  WritingVaultWorkbench,
  type VaultResult,
} from "@/lib/writing-vault-controller.ts";
import { writingVaultWorker } from "@/lib/writing-vault-worker-client.ts";
import { WritingVaultPassword } from "./writing-vault-password.tsx";
import {
  WritingVaultReview,
  VAULT_KIND_LABELS,
} from "./writing-vault-review.tsx";
import { WritingVaultResult } from "./writing-vault-result.tsx";

const STAGES = {
  validating: "严格校验全部载荷",
  deriving: "使用固定参数计算口令密钥",
  encrypting: "加密副本",
  "self-checking": "回解实际封装并核对原始字节",
  decrypting: "认证并解密所选文件",
};
const noServerWork = () => "cold" as const;

export function LocalWritingVault() {
  const [controller] = useState(
    () =>
      new WritingVaultWorkbench({
        crypto: writingVaultWorker,
        inspect: async (bytes, signal) => {
          const inspected = await writingVaultWorker.inspect(bytes, signal);
          try {
            return inspected.review;
          } finally {
            inspected.bytes.fill(0);
          }
        },
      }),
  );
  const [download] = useState(() => new CollectionDownloadLease());
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const workerStatus = useSyncExternalStore(
    writingVaultWorker.subscribe,
    writingVaultWorker.getSnapshot,
    noServerWork,
  );
  const busy = workerStatus !== "idle";
  const [notice, setNotice] = useState<{
    result: VaultResult | null;
    text: string;
    error: boolean;
  } | null>(null);
  useEffect(() => {
    writingVaultWorker.warm();
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
  }, [download, state.result, state.confirmed]);
  useEffect(() => {
    if (workerStatus === "failed") {
      controller.clear();
      download.release();
      setNotice(null);
    }
  }, [workerStatus, controller, download]);
  function changed() {
    download.release();
    setNotice(null);
  }
  function clear() {
    changed();
    controller.clear();
  }
  function choose(files: FileList | null) {
    changed();
    if (!files?.length) return;
    if (files.length !== 1) {
      controller.clear();
      setNotice({
        result: null,
        text: "一次只读取一份本机 JSON 或加密文件，不会自动挑选第一份。",
        error: true,
      });
      return;
    }
    void controller.load(files[0]!);
  }
  function save() {
    const result = controller.getSnapshot().result;
    let artifact: ReturnType<WritingVaultWorkbench["artifact"]> | null = null;
    try {
      artifact = controller.artifact(result);
      download.downloadBytes(artifact, () => controller.permits(result));
      setNotice({
        result,
        text: "新的副本已交给浏览器下载；这不是已落盘回执。请重新选入实际下载文件作复读核对。",
        error: false,
      });
    } catch {
      setNotice({
        result,
        text: "下载失败或意图已变化，没有确认旧结果；请重新核对当前结果后手动下载。",
        error: true,
      });
    } finally {
      artifact?.bytes.fill(0);
    }
  }
  return (
    <section
      className="nw-authoring nw-collections nw-vault"
      aria-label="本机文稿加密备份工作台"
    >
      <header className="nw-authoring-header">
        <p className="nw-kicker">LOCAL / 密码文件</p>
        <h1>本机文稿加密备份</h1>
        <p>
          为您明确选择的现有备份准备一份加密副本，或先认证、校验再手动解密。文件和口令都不上传，不修改原文件、编辑区、恢复缓存或服务器。
        </p>
        <div className="nw-authoring-actions">
          <Link className="nw-btn" href="/write">
            返回写作台
          </Link>
          <Link className="nw-btn" href="/write/collections">
            本机集合工具
          </Link>
          <Link className="nw-btn" href="/write/merge">
            本机三方合并
          </Link>
          <button className="nw-btn" type="button" onClick={clear}>
            清除全部文件与结果
          </button>
        </div>
      </header>
      <p className="nw-merge-warning">
        仅在可信设备使用。忘记口令无法恢复；加密不删除已有明文，不保护正在使用时的同源恶意脚本、浏览器扩展、旁观者、系统或密码管理器。浏览器内存清除不等于物理安全擦除。请独立保管原稿及口令。
      </p>
      <p>
        支持单篇备份（最多 2 MiB）、文稿集合（最多 16 MiB / 20
        篇）和三方取舍计划（最多 64
        KiB）。仅接受既有格式，不接受任意文件、HTML、ZIP、图片字节或嵌套加密文件；格式校验不等于作者签名。加密文件只比明文多固定封装开销。
      </p>
      <p>
        采用浏览器原生 PBKDF2-SHA-256 / 600000 次与 AES-256-GCM，随机 32 字节
        salt、12 字节 nonce、128
        位认证标签；不提供弱参数回退。页面加载后可离线使用，不自动保存到浏览器；离开或进入历史缓存会清除本页，返回不自动重读。
      </p>
      {workerStatus === "idle" ? (
        <p role="status">专用本机工作线程已就绪；没有启动密码计算。</p>
      ) : workerStatus === "cold" || workerStatus === "starting" ? (
        <p role="status">
          正在载入同源专用工作线程，仅载入应用代码，不读取文件或口令……
        </p>
      ) : null}
      {workerStatus === "failed" ? (
        <p role="alert">
          专用工作线程不可用或超时；没有回退、自动重启或重放。请保留原稿，重新加载空白页面后再手动尝试。
          <button
            className="nw-btn"
            type="button"
            onClick={() => {
              clear();
              window.location.reload();
            }}
          >
            重新加载空白页面
          </button>
        </p>
      ) : null}
      <label className="nw-writing-file">
        本机 JSON 或加密文件
        <input
          type="file"
          accept=".json,.nwvault,application/json,application/octet-stream"
          disabled={
            workerStatus === "cold" ||
            workerStatus === "starting" ||
            workerStatus === "failed"
          }
          onChange={(event) => {
            choose(event.currentTarget.files);
            event.currentTarget.value = "";
          }}
        />
      </label>
      {state.loading ? (
        <p role="status">
          正在完整读取并校验本机文件 {state.percent}%；未接纳部分内容……
        </p>
      ) : null}
      {state.source ? (
        <section aria-label="当前明确选择的文件">
          <h2>
            {state.source.kind === "plain"
              ? "已校验的明文来源"
              : "待认证的加密来源"}
          </h2>
          <p className="nw-collection-filename">
            本机文件：{state.source.name} ·{" "}
            {state.source.bytes.toLocaleString("zh-CN")} 字节
          </p>
          {state.source.kind === "locked" ? (
            <p>
              目前只检查了固定文件头、参数和长度，尚未认证任何内容。不根据文件名推断标题、来源或作者。
            </p>
          ) : null}
          <WritingVaultPassword
            key={state.source.serial}
            controller={controller}
            state={state}
            busy={busy}
            changed={changed}
          />
        </section>
      ) : null}
      {state.loading || state.phase === "working" ? (
        <button
          className="nw-btn"
          type="button"
          onClick={() => {
            changed();
            controller.cancel();
          }}
        >
          取消当前读取或密码操作
        </button>
      ) : null}
      {state.phase === "working" ? (
        <p role="status">
          {state.stage ? STAGES[state.stage] : "正在准备本机操作"}
          ……尚无可下载结果。
        </p>
      ) : null}
      {state.phase === "cancelled" ? (
        <p role="status">
          本次意图已取消，迟到任务不能复活结果；原生密码计算如仍运行，会继续占用唯一计算槽直到结束。
        </p>
      ) : null}
      {workerStatus === "busy" && state.phase !== "working" ? (
        <p role="status">
          上一项原生密码计算尚未结束；可以清除或换文件，但不会排队开始新计算。
        </p>
      ) : null}
      {state.error ? <p role="alert">{state.error.message}</p> : null}
      {notice && notice.result === state.result ? (
        <p role={notice.error ? "alert" : "status"}>{notice.text}</p>
      ) : null}
      {state.verified ? (
        <section aria-label="仅核验的无正文结果">
          <h2>认证与完整载荷校验成功</h2>
          <p role="status">
            {VAULT_KIND_LABELS[state.verified.kind]} ·{" "}
            {state.verified.bytes.toLocaleString("zh-CN")} 个明文字节 ·{" "}
            {state.verified.documents} 篇文稿 · {state.verified.decisions}{" "}
            项取舍。未保留明文字节或正文预览，没有创建可下载明文。
          </p>
          <details>
            <summary>已核验明文字节的 SHA-256（不是签名）</summary>
            <code className="nw-collection-digest">
              {state.verified.digest}
            </code>
          </details>
          <button
            className="nw-btn"
            type="button"
            onClick={() => {
              changed();
              controller.lock();
            }}
          >
            清除核验结果并锁定
          </button>
        </section>
      ) : null}
      {state.result ? (
        <WritingVaultResult
          key={state.result.serial}
          result={state.result}
          state={state}
          controller={controller}
          save={save}
        />
      ) : null}
      {state.review ? (
        <WritingVaultReview
          key={state.review.digest}
          review={state.review}
          controller={controller}
        />
      ) : null}
    </section>
  );
}
