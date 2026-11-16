import { restoreWritingFields, validateWritingState, type WritingField, type WritingRestore } from "./writing-backup.ts";
import { writingSnapshotKey, type WritingDraft } from "./writing-session.ts";

export type WritingBodyRestore = { mode: "replace" } | { mode: "append"; blocks: readonly number[] };

/** Add chosen backup blocks to the current document without inventing server identity or revisions. */
export function restoreWritingSelection(current: WritingDraft, preview: WritingRestore, fields: readonly WritingField[], body: WritingBodyRestore = { mode: "replace" }): WritingDraft {
  if (writingSnapshotKey(current) !== preview.source) throw new Error("恢复预览已过期，请重新选择备份文件。");
  const next = restoreWritingFields(current, preview, fields);
  if (!fields.includes("editorState") || body.mode === "replace") return next;
  const incoming = preview.backup.draft.editorState?.root.children;
  const existing = current.editorState;
  if (!existing || !incoming) throw new Error("编辑器或备份正文尚未初始化。");
  if (!body.blocks.length || new Set(body.blocks).size !== body.blocks.length || body.blocks.some(index => !Number.isSafeInteger(index) || index < 0 || index >= incoming.length)) {
    throw new Error("请选择有效且不重复的备份内容块。");
  }
  if (existing.root.children.length + body.blocks.length > 200) throw new Error("追加后将超过 200 个内容块，请减少选择或拆分文稿。");
  const selected = new Set(body.blocks);
  const appended = incoming.filter((_, index) => selected.has(index));
  const combined = { root: { ...existing.root, children: [...existing.root.children, ...appended] } };
  // Validate the combined result before returning any metadata/body update.
  // A separately valid file must not make an oversized/unsupported local draft
  // look safely restorable, and failure must not partially restore the title.
  next.editorState = validateWritingState(combined);
  return next;
}
