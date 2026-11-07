import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactElement } from "react";

/**
 * The confirmation dialog: one question, a cancel, and the action it is asking
 * about (#F-12).
 *
 * The desk used to ask three of these through `window.confirm` — deleting a
 * work, withdrawing a published one, deleting an image. `confirm()` is not a
 * dialog the product owns: it is unstyled, its text is plain unformatted prose
 * (the delete message needed a paragraph break to separate "what happens now"
 * from "what a restore cannot give back"), its button labels are the browser's,
 * and some mobile WebViews suppress it while still returning `false` — which
 * turns a destructive action into a button that does nothing at all, silently.
 * That last failure mode is why this is a test-guarded rule rather than a style
 * preference.
 *
 * Deliberately **not** a `<form>`: Enter must not fire a delete. Focus starts on
 * 取消, the dialog has no default action, and the only way to proceed is to aim
 * at the button that names what it does.
 */
export type ConfirmAsk = {
  /** The question. Also the dialog's accessible name. */
  title: string;
  /**
   * What the reader is agreeing to. One string, split on newlines into
   * paragraphs — the delete confirmation says three things and merging them into
   * one block is how a warning turns into a wall of text.
   */
  description?: string;
  /** Names the action ("删除作品"), not "确定": a button should say what it does. */
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` colours the confirm button: this cannot be undone. */
  tone?: "default" | "danger";
};

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "确认",
  cancelLabel = "取消",
  tone = "default",
  onCancel,
  onConfirm,
}: ConfirmAsk & {
  open: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const idBase = useId();
  const paragraphs = (description ?? "").split("\n").map((line) => line.trim()).filter(Boolean);

  // Same opening rule as `PromptDialog`: the native element owns the backdrop,
  // the focus trap and Escape, so it is opened and closed rather than mounted and
  // unmounted.
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    else if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className="nw-dialog"
      aria-labelledby={`${idBase}-title`}
      aria-describedby={paragraphs.length > 0 ? `${idBase}-desc` : undefined}
      onCancel={(event) => {
        // Escape closes through the parent, which is the one place that knows
        // whether an answer was given — and resolves the pending promise once.
        event.preventDefault();
        onCancel();
      }}
      onClose={onCancel}
    >
      <div className="nw-dialog-form">
        <h2 id={`${idBase}-title`} className="nw-dialog-title">{title}</h2>
        {paragraphs.length > 0 ? (
          // One `id` on the group, so a screen reader reads the whole warning
          // when the dialog opens instead of a single line of it.
          <div id={`${idBase}-desc`}>
            {paragraphs.map((line) => <p className="nw-dialog-desc" key={line}>{line}</p>)}
          </div>
        ) : null}
        <div className="nw-dialog-actions">
          {/* Cancel is the default: `autoFocus`, no form, no Enter handler. */}
          <button className="nw-btn" type="button" autoFocus onClick={onCancel}>{cancelLabel}</button>
          <button
            className={`nw-btn ${tone === "danger" ? "nw-btn-danger" : "nw-pri"}`}
            type="button"
            onClick={onConfirm}
          >{confirmLabel}</button>
        </div>
      </div>
    </dialog>
  );
}

type Pending = { ask: ConfirmAsk; resolve(value: boolean): void };

/**
 * `confirm()` as a promise, so a call site reads like the `window.confirm` it
 * replaced:
 *
 *     if (!(await confirm({ title: "删除这张图片？" }))) return;
 *
 * The promise resolves exactly once. Escape, 取消 and the browser's `close` event
 * can all arrive for the same dialog; the resolver is cleared before it is
 * called, so a late second event resolves nothing.
 */
export function useConfirm(): { confirm(ask: ConfirmAsk): Promise<boolean>; dialog: ReactElement } {
  const [pending, setPending] = useState<Pending | null>(null);
  const resolver = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback((ask: ConfirmAsk) => new Promise<boolean>((resolve) => {
    resolver.current = resolve;
    setPending({ ask, resolve });
  }), []);

  const settle = useCallback((value: boolean) => {
    const resolve = resolver.current;
    resolver.current = null;
    setPending(null);
    resolve?.(value);
  }, []);

  const ask = pending?.ask;
  return {
    confirm,
    dialog: (
      <ConfirmDialog
        open={pending !== null}
        title={ask?.title ?? ""}
        description={ask?.description}
        confirmLabel={ask?.confirmLabel}
        cancelLabel={ask?.cancelLabel}
        tone={ask?.tone}
        onCancel={() => settle(false)}
        onConfirm={() => settle(true)}
      />
    ),
  };
}
