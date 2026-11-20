import { useEffect, useRef } from "react";
import type {
  VaultResult,
  WritingVaultState,
  WritingVaultWorkbench,
} from "@/lib/writing-vault-controller.ts";

export function WritingVaultResult({
  result,
  state,
  controller,
  save,
}: {
  result: VaultResult;
  state: WritingVaultState;
  controller: WritingVaultWorkbench;
  save: () => void;
}) {
  const region = useRef<HTMLElement | null>(null);
  const sealed = result.kind === "sealed";
  const readback = state.readback;
  useEffect(() => {
    region.current?.focus();
    region.current?.scrollIntoView({ block: "nearest" });
  }, []);
  function choose(files: FileList | null) {
    if (!files?.length) return;
    if (files.length !== 1) {
      controller.cancelReadback();
      return;
    }
    void controller.verifyDownloaded(files[0]!, result);
  }
  return (
    <section
      ref={region}
      tabIndex={-1}
      className="nw-vault-result"
      aria-label="本机加密工具的已校验输出"
    >
      <h2>{sealed ? "新加密副本已回解自检" : "明文已认证并校验，尚未下载"}</h2>
      <p role="status">
        {sealed
          ? "已从实际封装的密文回解，并逐字节核对与原稿完全一致；原明文预览已清除。"
          : "认证成功后才检查全部载荷，未作格式转换；没有把内容恢复到编辑器或服务器。"}
      </p>
      <p>
        新文件 <code>{result.name}</code> ·{" "}
        {result.bytes.toLocaleString("zh-CN")} 字节。
        {sealed
          ? "格式只暴露版本、固定算法参数、随机 salt/nonce 与长度，不含标题、原文件名、明文摘要或来源类型。"
          : "这是未加密的新 JSON；请留意浏览器下载历史、目录同步、共用设备和磁盘备份。"}
      </p>
      <details>
        <summary>本次输出字节 SHA-256（不是作者签名）</summary>
        <code className="nw-collection-digest">{result.digest}</code>
      </details>
      <p>
        {sealed
          ? "加密不删除您已有的明文、恢复缓存或其他副本。请独立保存口令；遗忘后无法恢复。自检不证明下载目录已成功落盘，下载后可用下方复读核对。"
          : "手动下载明文会重新产生未加密副本。只想检查文件时，请改用“只验证，不展开文稿”。后续恢复仍需在既有工具中重新选择文件、预览和确认。"}
      </p>
      <label className="nw-writing-check">
        <input
          type="checkbox"
          checked={state.confirmed}
          onChange={(event) =>
            controller.confirmResult(result, event.target.checked)
          }
        />
        {sealed
          ? "我已独立记住口令，理解原明文仍存在，手动下载新加密副本"
          : "我已复核内容，理解将手动下载未加密的私密 JSON"}
      </label>
      <div className="nw-authoring-actions">
        <button
          className="nw-btn"
          type="button"
          disabled={!state.confirmed}
          onClick={save}
        >
          {sealed ? "下载新加密副本" : "下载解密后的原始 JSON"}
        </button>
        <button
          className="nw-btn"
          type="button"
          onClick={() => controller.lock()}
        >
          {sealed ? "清除本次加密结果" : "重新锁定并清除明文"}
        </button>
      </div>
      <section aria-label="手动下载副本复读核对">
        <h3>下载后，重新选择副本作逐字节核对</h3>
        <p>
          只核对您实际选入的本机字节，不使用文件名、修改时间或 JSON
          语义相同来代替。不会自动读取下载目录，也不能证明未来磁盘、云盘或设备上所有副本安全。
        </p>
        <label className="nw-writing-file">
          重新选择已下载的副本
          <input
            type="file"
            accept={
              sealed
                ? ".nwvault,application/octet-stream"
                : ".json,application/json"
            }
            onChange={(event) => {
              choose(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
          />
        </label>
        {readback.status === "reading" || readback.status === "comparing" ? (
          <>
            <p role="status">
              {readback.status === "reading" ? "读取所选副本" : "比较完整字节"}{" "}
              {readback.percent}%；尚未报告核对成功。
            </p>
            <button
              className="nw-btn"
              type="button"
              onClick={() => controller.cancelReadback()}
            >
              停止副本核对
            </button>
          </>
        ) : null}
        {readback.status === "cancelled" ? (
          <p role="status">副本核对已取消；没有更换已准备的输出。</p>
        ) : null}
        {readback.error ? <p role="alert">{readback.error.message}</p> : null}
        {readback.report ? (
          <div role={readback.report.matches ? "status" : "alert"}>
            <p>
              {readback.report.matches
                ? "所选副本与本次输出逐字节一致。"
                : "所选副本与本次输出不一致；未替换原结果，请保留原稿并重新核对。"}
            </p>
            {!readback.report.matches ? (
              <p>
                预期 {readback.report.expectedBytes} / 实际{" "}
                {readback.report.actualBytes} 字节；
                {readback.report.reason === "truncated"
                  ? "尾部截断"
                  : readback.report.reason === "appended"
                    ? "尾部多出字节"
                    : "内容字节不同"}
                。不同或缺失字节 {readback.report.differentBytes}{" "}
                处，首个不同偏移 {readback.report.firstDifference}（从 0
                开始）；不展示差异字节内容。
              </p>
            ) : null}
            <details>
              <summary>所选副本的 SHA-256</summary>
              <code className="nw-collection-digest">
                {readback.report.actualDigest}
              </code>
            </details>
          </div>
        ) : null}
      </section>
    </section>
  );
}
