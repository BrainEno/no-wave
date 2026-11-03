"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, ReactNode } from "react";

/**
 * 写作台的内联浮层表单（issue #168）。
 *
 * 写作台曾用 `window.prompt` 收集链接地址、图片替代文本与图片说明，用
 * `window.alert` 报告这些输入不合法。原生对话框有三个问题，第三个最要紧：
 *
 * 1. 样式不受控制，与 `UI_DESIGN_SYSTEM.md` §4.9 的直角 1px 线框表单毫无关系；
 * 2. `alert` 抢焦点、阻塞脚本，屏幕阅读器只能读到一串没有上下文的句子，而
 *    `aria-describedby` 能把错误挂回它所属的输入框；
 * 3. 部分移动端内嵌 WebView 会**静默返回 `null`**（甚至完全忽略 `alert`）。
 *    于是「插入图片」在那里永远失败，而且失败得毫无痕迹——不是样式问题，
 *    是功能问题。
 *
 * 这个组件只补原生 `prompt` 做不到的几件事：把字段和错误留在页面里、把错误
 * 关联到具体字段、打开时把焦点放进去、关闭时还回去、Esc 与遮罩点击都能关。
 * 没有框架依赖，也没有任何浏览器原生对话框。
 */

export type InlineFormField = {
  name: string;
  label: string;
  /** 单行输入或多行文本；说明类字段用多行。 */
  multiline?: boolean;
  placeholder?: string;
  maxLength?: number;
  required?: boolean;
  /** 字段下方的一行说明，不参与校验。 */
  hint?: string;
};

export type InlineFormValues = Record<string, string>;

/** 字段名 → 该字段的错误文案；`null` 表示没有错误。 */
export type InlineFormErrors = Record<string, string> | null;

type InlineFormProps = {
  title: string;
  description?: string;
  /** 表单正文（例如一段不可编辑的说明），渲染在字段之前。 */
  body?: ReactNode;
  fields?: readonly InlineFormField[];
  submitLabel: string;
  cancelLabel?: string;
  validate?(values: InlineFormValues): InlineFormErrors;
  /**
   * 提交。返回 `null` 关闭浮层；返回错误则留在页内。
   *
   * 上传这类慢操作也在这里：原生对话框在等待期间关不掉，浮层可以，而且
   * 禁用按钮本来就是表单该有的样子。
   */
  onSubmit(values: InlineFormValues): InlineFormErrors | Promise<InlineFormErrors>;
  onCancel(): void;
};

/**
 * 一个字段的错误文案，带 `⚠` 前缀。
 *
 * 设计系统要求错误是「红色文字 + `⚠` 文本前缀」；`⚠` 是文本而不是图标，因为
 * 屏幕阅读器读出来的是「注意」，而不是一个空的图形节点。
 */
export function fieldErrorText(message: string): string {
  return `⚠ 错误：${message}`;
}

export function InlineForm({
  title, description, body, fields = [], submitLabel, cancelLabel = "取消", validate, onSubmit, onCancel,
}: InlineFormProps) {
  const [values, setValues] = useState<InlineFormValues>(() => Object.fromEntries(fields.map((field) => [field.name, ""])));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const restoreFocusRef = useRef<Element | null>(null);
  const ids = useId();
  const fieldId = (name: string) => `${ids}-${name}`;
  const hintId = (name: string) => `${ids}-${name}-hint`;
  const errorId = (name: string) => `${ids}-${name}-error`;

  // 焦点进出：打开时进第一个字段，关闭时回到打开它的那个按钮。原生 `prompt`
  // 自己会做这件事；换成自定义浮层后必须自己补上，否则键盘用户会迷失。
  useEffect(() => {
    restoreFocusRef.current = typeof document === "undefined" ? null : document.activeElement;
    firstFieldRef.current?.focus();
    return () => {
      const previous = restoreFocusRef.current;
      if (previous instanceof HTMLElement && typeof previous.focus === "function") previous.focus();
    };
  }, []);

  // Esc 关闭；Tab 在浮层内循环，不会跑到浮层后面的页面上。
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCancel();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        "input, textarea, button, [href], select, [tabindex]:not([tabindex='-1'])",
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onCancel]);

  function update(name: string, value: string) {
    setValues((current) => ({ ...current, [name]: value }));
    // 用户开始改这一格，这一格的旧错误就不再成立。
    setErrors((current) => {
      if (!(name in current)) return current;
      const next = { ...current };
      delete next[name];
      return next;
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const checked = validate ? validate(values) : null;
    if (checked && Object.keys(checked).length > 0) {
      setErrors(checked);
      return;
    }
    setPending(true);
    try {
      const failure = await onSubmit(values);
      if (failure && Object.keys(failure).length > 0) setErrors(failure);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="nw-overlay" role="presentation" onMouseDown={(event) => {
      // 点击遮罩关闭：只在真正的遮罩上按下时生效，浮层内部的拖动不算。
      if (event.target === event.currentTarget) onCancel();
    }}>
      <div className="nw-overlay-panel" ref={panelRef} role="dialog" aria-modal="true" aria-label={title}>
        <form onSubmit={(event) => void submit(event)} noValidate>
          <h2 className="nw-overlay-title">{title}</h2>
          {description ? <p className="nw-overlay-desc">{description}</p> : null}
          {body ? <div className="nw-overlay-body">{body}</div> : null}
          {fields.length > 0 ? (
            <div className="nw-overlay-fields">
              {fields.map((field, index) => {
                const error = errors[field.name];
                const describedBy = [
                  field.hint ? hintId(field.name) : null,
                  error ? errorId(field.name) : null,
                ].filter(Boolean).join(" ");
                const shared = {
                  id: fieldId(field.name),
                  name: field.name,
                  value: values[field.name] ?? "",
                  placeholder: field.placeholder,
                  maxLength: field.maxLength,
                  "aria-describedby": describedBy.length > 0 ? describedBy : undefined,
                  "aria-invalid": error ? true : undefined,
                  onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => update(field.name, event.target.value),
                };
                const firstRef = index === 0
                  ? (node: HTMLInputElement | HTMLTextAreaElement | null) => { firstFieldRef.current = node; }
                  : undefined;
                return (
                  <div className="nw-overlay-field" key={field.name}>
                    <label htmlFor={fieldId(field.name)}>
                      {field.label}{field.required ? <span aria-hidden="true"> *</span> : null}
                    </label>
                    {field.multiline
                      ? <textarea {...shared} ref={firstRef} rows={3} />
                      : <input {...shared} ref={firstRef} />}
                    {field.hint ? <p className="nw-overlay-hint" id={hintId(field.name)}>{field.hint}</p> : null}
                    {error ? <p className="nw-overlay-error" id={errorId(field.name)} role="alert">{fieldErrorText(error)}</p> : null}
                  </div>
                );
              })}
            </div>
          ) : null}
          <div className="nw-overlay-actions">
            <button className="nw-btn" type="button" onClick={onCancel}>{cancelLabel}</button>
            <button className="nw-btn nw-pri" type="submit" disabled={pending}>{pending ? "处理中…" : submitLabel}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * 一个可复用的确认浮层，替代 `window.confirm`。
 *
 * 确认按钮就是表单的提交按钮，所以回车与鼠标是同一个动作；取消是 `type=
 * "button"`，永远不会提交。`danger` 只是给按钮换一个语义色，不改变行为。
 */
export function InlineConfirm({ title, body, confirmLabel, cancelLabel = "取消", danger = false, onConfirm, onCancel }: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  return (
    <div className="nw-overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onCancel();
    }}>
      <div className="nw-overlay-panel" role="dialog" aria-modal="true" aria-label={title}>
        <div className="nw-overlay-confirm-body">
          <h2 className="nw-overlay-title">{title}</h2>
          <div className="nw-overlay-body">{body}</div>
          <div className="nw-overlay-actions">
            <button className="nw-btn" type="button" onClick={onCancel}>{cancelLabel}</button>
            <button className={danger ? "nw-btn nw-pri nw-danger" : "nw-btn nw-pri"} type="button" onClick={onConfirm}>{confirmLabel}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
