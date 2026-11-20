import { useId, useRef, useState } from "react";
import type {
  WritingVaultState,
  WritingVaultWorkbench,
} from "@/lib/writing-vault-controller.ts";

/** Uncontrolled password inputs: no password in React state, controller snapshots, URLs or storage. */
export function WritingVaultPassword({
  controller,
  state,
  busy,
  changed,
}: {
  controller: WritingVaultWorkbench;
  state: WritingVaultState;
  busy: boolean;
  changed: () => void;
}) {
  const password = useRef<HTMLInputElement | null>(null);
  const replacement = useRef<HTMLInputElement | null>(null);
  const confirmation = useRef<HTMLInputElement | null>(null);
  const consent = useRef<HTMLInputElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [rotating, setRotating] = useState(false);
  const description = useId();
  const plain = state.source?.kind === "plain";
  const sealing = plain || rotating;
  const disabled = busy || state.loading || state.phase === "working";
  function reset() {
    if (password.current) password.current.value = "";
    if (replacement.current) replacement.current.value = "";
    if (confirmation.current) confirmation.current.value = "";
    if (consent.current) consent.current.checked = false;
    setVisible(false);
  }
  function run(action: "seal" | "unlock" | "verify" | "rotate") {
    const first = password.current?.value ?? "";
    const next = replacement.current?.value ?? "";
    const second = confirmation.current?.value ?? "";
    const accepted = consent.current?.checked === true;
    // Clear DOM synchronously, before any KDF, progress callback or asynchronous work.
    reset();
    changed();
    if (action === "seal") void controller.seal(first, second, accepted);
    else if (action === "rotate")
      void controller.rotate(first, next, second, accepted);
    else if (action === "unlock") void controller.unlock(first);
    else void controller.verify(first);
  }
  function edited() {
    changed();
    controller.credentialsChanged();
  }
  const input = {
    type: visible ? "text" : "password",
    maxLength: 512,
    autoComplete: "off",
    autoCapitalize: "none",
    spellCheck: false,
    "aria-describedby": description,
    onChange: edited,
  };
  return (
    <form
      className="nw-vault-password"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        run(plain ? "seal" : rotating ? "rotate" : "unlock");
      }}
    >
      <fieldset disabled={disabled}>
        <legend>
          {plain ? "为新加密副本设置口令" : "用口令核验所选加密文件"}
        </legend>
        <p id={description}>
          至少 12、最多 256 个 Unicode
          字符，建议使用独立的随机多词长口令。长度合格不等于强度足够；大小写、空格与
          Unicode 组合形式必须完全一致。口令不做 trim
          或正规化，不上传、不托管，也没有找回入口。
        </p>
        {!plain ? (
          <label className="nw-writing-check">
            <input
              type="checkbox"
              checked={rotating}
              onChange={(event) => {
                reset();
                edited();
                setRotating(event.target.checked);
              }}
            />
            更换口令，不输出明文
          </label>
        ) : null}
        <label>
          {plain ? "新加密口令" : rotating ? "原解密口令" : "解密口令"}
          <input ref={password} {...input} />
        </label>
        {rotating && !plain ? (
          <label>
            替换加密口令
            <input ref={replacement} {...input} />
          </label>
        ) : null}
        {sealing ? (
          <label>
            再次输入新口令
            <input ref={confirmation} {...input} />
          </label>
        ) : null}
        {rotating && !plain ? (
          <p>
            先用原口令认证并严格校验，再用不同的新口令、新 salt/nonce
            另存加密副本，全程不生成明文下载。原文件仍接受原口令，绝不自动撤销或删除；若原副本已泄漏，更换新副本的口令不能消除旧副本的风险。
          </p>
        ) : null}
        <label className="nw-writing-check">
          <input
            type="checkbox"
            checked={visible}
            onChange={(event) => setVisible(event.target.checked)}
          />
          在屏幕上显示本次口令（留意旁观者）
        </label>
        {sealing ? (
          <label className="nw-writing-check">
            <input ref={consent} type="checkbox" />
            我理解忘记口令无法恢复，加密不删除原明文，也不能防住使用时的恶意脚本或扩展
          </label>
        ) : null}
        <div className="nw-authoring-actions">
          <button className="nw-btn" type="submit">
            {plain
              ? "加密并回解自检"
              : rotating
                ? "认证并另存新口令副本"
                : "解密并预览"}
          </button>
          {!plain && !rotating ? (
            <button
              className="nw-btn"
              type="button"
              onClick={() => run("verify")}
            >
              只验证，不展开文稿
            </button>
          ) : null}
          <button
            className="nw-btn"
            type="button"
            onClick={() => {
              reset();
              edited();
              password.current?.focus();
            }}
          >
            清空本次口令
          </button>
        </div>
      </fieldset>
      {busy ? (
        <p role="status">
          原生密码计算仍占用单个计算槽；取消只撤销意图，计算结束前不能另启一项，不会自动排队或重试。
        </p>
      ) : null}
      <p>
        提交后立即清空输入框；正在运行的原生计算仍需短暂使用口令。JavaScript
        字符串、浏览器、系统或密码管理器不能保证物理安全擦除，请只在可信设备使用。
      </p>
    </form>
  );
}
