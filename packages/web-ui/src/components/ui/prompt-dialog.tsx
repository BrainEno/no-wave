import { useEffect, useId, useRef, useState } from "react";

/**
 * A small form in a native `<dialog>`, used where the editor would otherwise
 * call `window.prompt` (#195).
 *
 * `prompt()` is not merely unstyled: some mobile WebViews return `null` from it
 * without showing anything, so tapping "insert image" does nothing at all and no
 * error is ever displayed. A dialog cannot fail that way, and it can be laid out
 * and validated the way the rest of the site is (UI_DESIGN_SYSTEM §4.9, §4.10).
 *
 * Shape: label above a 52-high 1px square input, error below in red with the
 * `⚠ 错误：` prefix and `aria-describedby` pointing at it. The value survives a
 * failed validation — the reason the form is still open is so it can be fixed,
 * not retyped.
 */
export type PromptDialogField = {
  /** Stable key, also the `id` suffix. */
  name: string;
  label: string;
  multiline?: boolean;
  maxLength: number;
  /** Trimmed value must be non-empty. */
  required?: boolean;
  hint?: string;
  placeholder?: string;
  /** Message shown when `required` and the value is blank. */
  requiredMessage?: string;
};

export function PromptDialog({
  open,
  title,
  description,
  fields,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  title: string;
  description?: string;
  fields: readonly PromptDialogField[];
  submitLabel: string;
  onCancel(): void;
  onSubmit(values: Record<string, string>): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const idBase = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [errorField, setErrorField] = useState("");

  // Open/close the native dialog rather than rendering it conditionally, so the
  // browser handles the backdrop, focus trapping and Escape for us.
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      setValues({});
      setError("");
      setErrorField("");
      element.showModal();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    for (const field of fields) {
      const raw = values[field.name] ?? "";
      if (raw.length > field.maxLength) {
        setError(`${field.label}不得超过 ${field.maxLength} 字符。`);
        setErrorField(field.name);
        return;
      }
      if (field.required && !raw.trim()) {
        setError(field.requiredMessage ?? `${field.label}不能为空。`);
        setErrorField(field.name);
        return;
      }
    }
    setError("");
    setErrorField("");
    onSubmit(values);
  }

  return (
    <dialog
      ref={dialog}
      className="nw-dialog"
      aria-labelledby={`${idBase}-title`}
      onCancel={(event) => {
        // Escape: close through the parent so its state stays the source of
        // truth about whether the dialog is open.
        event.preventDefault();
        onCancel();
      }}
      onClose={onCancel}
    >
      <form className="nw-dialog-form" onSubmit={submit} noValidate>
        <h2 id={`${idBase}-title`} className="nw-dialog-title">{title}</h2>
        {description ? <p className="nw-dialog-desc">{description}</p> : null}
        {fields.map((field) => {
          const inputId = `${idBase}-${field.name}`;
          const errorId = `${idBase}-${field.name}-error`;
          const ownError = errorField === field.name ? error : "";
          const shared = {
            id: inputId,
            name: field.name,
            value: values[field.name] ?? "",
            "aria-invalid": ownError ? ("true" as const) : undefined,
            "aria-describedby": ownError ? errorId : field.hint ? `${inputId}-hint` : undefined,
            onChange: (event: { currentTarget: { value: string } }) => {
              setValues((current) => ({ ...current, [field.name]: event.currentTarget.value }));
              if (errorField === field.name) {
                setError("");
                setErrorField("");
              }
            },
          };
          return (
            <div className="nw-dialog-field" key={field.name}>
              <label htmlFor={inputId}>{field.label}</label>
              {field.multiline ? (
                <textarea {...shared} maxLength={field.maxLength} placeholder={field.placeholder} />
              ) : (
                <input {...shared} maxLength={field.maxLength} placeholder={field.placeholder} />
              )}
              {field.hint ? <p className="nw-dialog-hint" id={`${inputId}-hint`}>{field.hint}</p> : null}
              {ownError ? (
                <p className="nw-dialog-error" id={errorId} role="alert">⚠ 错误：{ownError}</p>
              ) : null}
            </div>
          );
        })}
        {error && !errorField ? <p className="nw-dialog-error" role="alert">⚠ 错误：{error}</p> : null}
        <div className="nw-dialog-actions">
          <button className="nw-btn" type="button" onClick={onCancel}>取消</button>
          <button className="nw-btn nw-pri" type="submit">{submitLabel}</button>
        </div>
      </form>
    </dialog>
  );
}

/**
 * The minimum a caller needs to run one of these: which dialog is open, plus the
 * values it resolved to. Kept separate from the component so the editor can hold
 * the state without importing anything browser-shaped.
 */
export type PromptRequest = {
  kind: "link" | "image";
  /** Where the result goes: the toolbar that asked for it. */
  resolve(values: Record<string, string> | null): void;
};
