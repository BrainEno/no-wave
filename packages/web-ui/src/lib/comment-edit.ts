import type { Locale } from "./content.ts";

/**
 * Comment editing (ADR 0031) decided in one place.
 *
 * The rules are small but they are the kind of small that gets duplicated and
 * then disagrees: who may edit, what the "edited" marker says, and which request
 * body an edit sends. They live here so the component only renders decisions and
 * a unit test can hold the rules without a DOM.
 *
 * The browser never decides *whether* an edit is allowed — the API answers that,
 * and it answers `403` for somebody else's comment. `canEditComment` only decides
 * whether to offer the button, so a reader is not invited to perform an action
 * that would be refused.
 */

/** The part of a comment these rules read. */
export type EditableComment = {
  readonly authorId?: string | null;
  readonly editedAt?: string | null;
};

/** True when the signed-in reader wrote this comment and may correct it. */
export function canEditComment(viewerId: string | null | undefined, comment: EditableComment): boolean {
  if (typeof viewerId !== "string" || viewerId.length === 0) return false;
  return typeof comment.authorId === "string" && comment.authorId === viewerId;
}

/** The marker that tells a reader the text changed, or `null` for as-written text. */
export function editedMarker(locale: Locale, comment: EditableComment): string | null {
  if (typeof comment.editedAt !== "string" || comment.editedAt.length === 0) return null;
  return locale === "en" ? "edited" : "已编辑";
}

/**
 * The address a new comment is sent to.
 *
 * Both write paths sit under `/api/authoring` because that is where the access
 * cookie is scoped (ADR 0025): the browser only sends `nw_access` for paths under
 * that prefix. Registering the write on `/api/articles/...` — which is where the
 * *read* belongs, and where it still is — meant every comment submission arrived
 * without a credential, took a 401, and paid for a refresh-token rotation before
 * the retry could work (#242). The read stays public and cache-shaped; the writes
 * need the credential, so they live where the credential is.
 */
export function commentCreatePath(slug: string, locale: string): string {
  return "/api/authoring/articles/" + encodeURIComponent(slug) + "/comments?locale=" + encodeURIComponent(locale);
}

/** The address an edit is sent to; the locale is the edition to answer in. */
export function commentEditPath(commentId: string, locale: string): string {
  return "/api/authoring/comments/" + encodeURIComponent(commentId) + "?locale=" + encodeURIComponent(locale);
}

/**
 * The body of an edit.
 *
 * Version 1 is the versioned block document the composer already produces for a
 * new comment, so an edit and a creation go through the same normalization on the
 * API. Plain-text version 0 is deliberately not used here: the composer's content
 * is rich, and downgrading it would drop the marks the author used.
 */
export function commentEditBody(editorState: unknown): { editorState: unknown; contentBlocksVersion: 1 } {
  return { editorState, contentBlocksVersion: 1 };
}

/** The labels the comment section needs, so copy stays out of the render tree. */
export function commentCopy(locale: Locale): {
  readonly edit: string;
  readonly save: string;
  readonly cancel: string;
  readonly saving: string;
  readonly updated: string;
  readonly staleList: string;
  readonly signInToEdit: string;
  readonly failed: string;
} {
  if (locale === "en") {
    return {
      edit: "Edit",
      save: "Save changes",
      cancel: "Cancel",
      saving: "Saving…",
      updated: "Comment updated.",
      staleList: "Comment updated, but the list could not be reloaded. Reload the page to see it.",
      signInToEdit: "Sign in to edit your comment.",
      failed: "The comment could not be updated. Try again.",
    };
  }
  return {
    edit: "编辑",
    save: "保存修改",
    cancel: "取消",
    saving: "正在保存…",
    updated: "评论已更新。",
    staleList: "评论已更新，但列表刷新失败，请稍后重新载入。",
    signInToEdit: "请先登录后再编辑评论。",
    failed: "评论更新失败，请稍后重试。",
  };
}
