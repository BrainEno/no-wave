import type { WorkType } from "./content.ts";
import type { LexicalEditorStateJson } from "./lexical-article-state.ts";

export type WritingDraft = {
  title: string;
  summary: string;
  locale: string;
  workType: WorkType;
  editorState: LexicalEditorStateJson | null;
};
export type WritingGuard = { dirty: boolean; revision: number };
export type WritingLeaveToken = { editorKey: string; revision: number };

/** A preview is an exact intent, including paths and whitespace, not a fuzzy diff. */
export function writingSnapshotKey(draft: WritingDraft): string {
  return JSON.stringify([draft.title, draft.summary, draft.locale, draft.workType, draft.editorState]);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object" || value === null) return value;
  const source = value as Record<string, unknown>;
  const node: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const item = source[key];
    // These are Lexical serialization defaults, not changes to the manuscript.
    if ((key === "direction" && (item === null || item === "ltr")) ||
        (["indent", "detail", "textFormat"].includes(key) && item === 0) ||
        (["style", "textStyle", "theme"].includes(key) && (item === "" || item === null)) ||
        (key === "format" && (item === "" || item === 0)) ||
        (key === "mode" && item === "normal") || (key === "version" && item === 1) ||
        (["rel", "target", "title", "checked"].includes(key) && (item === null || item === "")) ||
        (source.type === "listitem" && key === "value") ||
        (source.type === "list" && key === "start" && item === 1) ||
        (source.type === "code-highlight" && key === "highlightType")) continue;
    if (key === "children" && Array.isArray(item)) {
      const children: Record<string, unknown>[] = [];
      for (const raw of item) {
        const child = canonicalValue(raw) as Record<string, unknown>;
        if (child.type === "text" && child.text === "") continue;
        const previous = children.at(-1);
        if (previous?.type === "text" && child.type === "text" &&
            JSON.stringify({ ...previous, text: "" }) === JSON.stringify({ ...child, text: "" })) {
          previous.text = String(previous.text) + String(child.text);
        } else if (previous?.type === "link" && child.type === "link" &&
            JSON.stringify({ ...previous, children: [] }) === JSON.stringify({ ...child, children: [] })) {
          children[children.length - 1] = canonicalValue({ ...previous, children: [
            ...previous.children as unknown[], ...child.children as unknown[],
          ] }) as Record<string, unknown>;
        } else children.push(child);
      }
      node.children = children;
    } else if (key === "type" && item === "code-highlight") node.type = "text";
    else if (key === "language" && source.type === "code") node.language = item || "text";
    else node[key] = canonicalValue(item);
  }
  return node;
}

/** Equality for unsaved content; it deliberately excludes server IDs/revisions/status. */
export function writingDraftKey(draft: WritingDraft): string {
  return JSON.stringify([draft.title.trim(), draft.summary.trim(), draft.locale, draft.workType, canonicalValue(draft.editorState)]);
}

/** Acknowledgement is always supplied with the submitted/returned snapshot, never "now". */
export class WritingSession {
  private baseline: string;
  private current: string;
  private guard: WritingGuard = { dirty: false, revision: 0 };

  constructor(draft: WritingDraft) {
    this.baseline = writingDraftKey(draft);
    this.current = this.baseline;
  }

  update(draft: WritingDraft): WritingGuard {
    const key = writingDraftKey(draft);
    if (key !== this.current) {
      this.current = key;
      this.guard = { dirty: key !== this.baseline, revision: this.guard.revision + 1 };
    }
    return this.guard;
  }

  acknowledge(snapshot: WritingDraft): WritingGuard {
    this.baseline = writingDraftKey(snapshot);
    this.guard = { ...this.guard, dirty: this.current !== this.baseline };
    return this.guard;
  }

  getSnapshot(): WritingGuard { return this.guard; }
}

export function canLeaveWriting(token: WritingLeaveToken, editorKey: string, guard: WritingGuard, pendingCreate: boolean): boolean {
  return !pendingCreate && token.editorKey === editorKey && token.revision === guard.revision;
}

/** Install once, read synchronously: a same-tick edit/unload must not see stale React state. */
export function bindWritingUnload(shouldWarn: () => boolean, target: EventTarget): () => void {
  const warn = (event: Event) => {
    if (!shouldWarn()) return;
    event.preventDefault();
    (event as BeforeUnloadEvent).returnValue = "";
  };
  target.addEventListener("beforeunload", warn);
  return () => target.removeEventListener("beforeunload", warn);
}
