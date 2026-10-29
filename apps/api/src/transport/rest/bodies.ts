import type { IncomingMessage, ServerResponse } from "node:http";
import { lexicalEditorStateToArticleDocument } from "../../domain/lexical-document-adapter.ts";
import { normalizeCommentContentInput } from "../../domain/comment-content.ts";
import { isRecord } from "./http.ts";

export const ARTICLE_WRITE_FIELDS = new Set([
  "slug", "title", "summary", "locale", "contentBlocks", "editorState", "contentBlocksVersion", "publish", "workType", "categoryIds", "tagIds",
]);

export function normalizeArticleWriteBody(
  body: Record<string, unknown>,
  requirePublish: boolean,
): { input: Record<string, unknown> | null; error: string | null } {
  if (Object.keys(body).some((key) => !ARTICLE_WRITE_FIELDS.has(key))) {
    return { input: null, error: "The request contains unsupported fields." };
  }
  if (body.locale !== undefined && body.locale !== "zh-CN") {
    return { input: null, error: "The REST API currently supports only locale zh-CN." };
  }
  if (typeof body.slug !== "string" || typeof body.title !== "string") {
    return { input: null, error: "slug and title must be strings." };
  }

  // Lexical is an ingress format only. Normalize immediately to the
  // application-owned versioned block document; never persist EditorState JSON.
  const hasContentBlocks = Object.hasOwn(body, "contentBlocks");
  const hasEditorState = Object.hasOwn(body, "editorState");
  if (hasContentBlocks === hasEditorState) {
    return { input: null, error: "Supply exactly one of contentBlocks or editorState." };
  }
  let contentBlocks: unknown[];
  if (hasEditorState) {
    if (!isRecord(body.editorState)) {
      return { input: null, error: "editorState must be a serialized Lexical EditorState object." };
    }
    if (body.contentBlocksVersion !== undefined && body.contentBlocksVersion !== 1) {
      return { input: null, error: "editorState requires contentBlocksVersion 1." };
    }
    try {
      contentBlocks = lexicalEditorStateToArticleDocument(body.editorState).contentBlocks;
    } catch {
      return { input: null, error: "editorState contains invalid or unsupported article content." };
    }
  } else {
    if (!Array.isArray(body.contentBlocks)) {
      return { input: null, error: "contentBlocks must be a JSON array." };
    }
    contentBlocks = body.contentBlocks;
  }

  if (body.summary !== undefined && typeof body.summary !== "string") {
    return { input: null, error: "summary must be a string." };
  }
  if (body.workType !== undefined && typeof body.workType !== "string") {
    return { input: null, error: "workType must be a string." };
  }
  if (body.publish !== undefined && typeof body.publish !== "boolean") {
    return { input: null, error: "publish must be a boolean." };
  }
  if (requirePublish && typeof body.publish !== "boolean") {
    return { input: null, error: "publish must be supplied as a boolean for article updates." };
  }
  if (body.contentBlocksVersion !== undefined &&
      (!Number.isInteger(body.contentBlocksVersion) ||
       (body.contentBlocksVersion !== 0 && body.contentBlocksVersion !== 1))) {
    return { input: null, error: "contentBlocksVersion must be 0 or 1." };
  }
  for (const field of ["categoryIds", "tagIds"] as const) {
    if (body[field] !== undefined && !Array.isArray(body[field])) {
      return { input: null, error: field + " must be an array when supplied." };
    }
  }

  const input: Record<string, unknown> = {
    ...body,
    locale: "zh-CN",
    contentBlocks: JSON.stringify(contentBlocks),
  };
  delete input.editorState;
  if (hasEditorState) input.contentBlocksVersion = 1;
  return { input, error: null };
}

export const PROFILE_WRITE_FIELDS = new Set(["displayName", "bio", "avatarUrl", "websiteUrl", "locale"]);

export function normalizeProfileWriteBody(
  body: Record<string, unknown>,
): { input: Record<string, unknown> | null; error: string | null } {
  if (Object.keys(body).some((key) => !PROFILE_WRITE_FIELDS.has(key))) {
    return { input: null, error: "The request contains unsupported fields." };
  }
  if (body.locale !== undefined && body.locale !== "zh-CN") {
    return { input: null, error: "The REST API currently supports only locale zh-CN." };
  }
  if (typeof body.displayName !== "string") {
    return { input: null, error: "displayName must be a string." };
  }
  if (body.bio !== undefined && typeof body.bio !== "string") {
    return { input: null, error: "bio must be a string." };
  }
  for (const field of ["avatarUrl", "websiteUrl"] as const) {
    if (body[field] !== undefined && body[field] !== null && typeof body[field] !== "string") {
      return { input: null, error: field + " must be a string or null." };
    }
  }
  const input: Record<string, unknown> = {
    displayName: body.displayName,
    bio: body.bio ?? "",
    locale: "zh-CN",
  };
  if (Object.hasOwn(body, "avatarUrl")) input.avatarUrl = body.avatarUrl;
  if (Object.hasOwn(body, "websiteUrl")) input.websiteUrl = body.websiteUrl;
  return { input, error: null };
}

export function normalizeLikeWriteBody(
  body: Record<string, unknown>,
): { liked: boolean | null; error: string | null } {
  if (Object.keys(body).some((key) => key !== "liked")) {
    return { liked: null, error: "The request contains unsupported fields." };
  }
  if (typeof body.liked !== "boolean") {
    return { liked: null, error: "liked must be a boolean." };
  }
  return { liked: body.liked, error: null };
}

export function normalizeCommentWriteBody(
  body: Record<string, unknown>,
): { input: { content: string; contentBlocks: unknown[] | null; contentBlocksVersion: number; parentCommentId: string | null } | null; error: string | null } {
  if (Object.keys(body).some((key) => !["content", "contentBlocks", "editorState", "contentBlocksVersion", "parentCommentId"].includes(key))) {
    return { input: null, error: "The request contains unsupported fields." };
  }
  const parentCommentId = body.parentCommentId;
  if (parentCommentId !== undefined && parentCommentId !== null &&
      (typeof parentCommentId !== "string" || parentCommentId.length === 0 || parentCommentId.length > 300)) {
    return { input: null, error: "parentCommentId must be a comment ID or null." };
  }
  try {
    const normalizedContent = normalizeCommentContentInput(body);
    return {
      input: { ...normalizedContent, parentCommentId: typeof parentCommentId === "string" ? parentCommentId : null },
      error: null,
    };
  } catch {
    return { input: null, error: "Comment content is invalid or contains unsupported rich-text content." };
  }
}

export function normalizeCreateTagBody(
  body: Record<string, unknown>,
): { input: { name: string; locale: "zh-CN" } | null; error: string | null } {
  if (Object.keys(body).some((key) => key !== "name" && key !== "locale")) {
    return { input: null, error: "The request contains unsupported fields." };
  }
  if (body.locale !== undefined && body.locale !== "zh-CN") {
    return { input: null, error: "The REST API currently supports only locale zh-CN." };
  }
  if (typeof body.name !== "string" || body.name.trim().length === 0 || body.name.length > 120) {
    return { input: null, error: "name must be non-empty and no longer than 120 characters." };
  }
  return { input: { name: body.name, locale: "zh-CN" }, error: null };
}

export function normalizeCreateTaxonomyBody(
  body: Record<string, unknown>,
): { input: { kind: string; slug: string; name: string; description: string; locale: "zh-CN" } | null; error: string | null } {
  if (Object.keys(body).some((key) => !["kind", "slug", "name", "description", "locale"].includes(key))) {
    return { input: null, error: "The request contains unsupported fields." };
  }
  if (body.locale !== undefined && body.locale !== "zh-CN") {
    return { input: null, error: "The REST API currently supports only locale zh-CN." };
  }
  if (typeof body.kind !== "string" || typeof body.slug !== "string" || typeof body.name !== "string") {
    return { input: null, error: "kind, slug, and name must be strings." };
  }
  const descriptionValue = body.description;
  if (descriptionValue !== undefined && typeof descriptionValue !== "string") {
    return { input: null, error: "description must be a string." };
  }
  const description = typeof descriptionValue === "string" ? descriptionValue : "";
  if (description.length > 2000) {
    return { input: null, error: "description must be no longer than 2000 characters." };
  }
  return {
    input: {
      kind: body.kind,
      slug: body.slug,
      name: body.name,
      description,
      locale: "zh-CN",
    },
    error: null,
  };
}

export function normalizeConversationCreateBody(
  body: Record<string, unknown>,
): { participantIds: string[] | null; error: string | null } {
  if (Object.keys(body).some((key) => key !== "participantIds")) {
    return { participantIds: null, error: "The request contains unsupported fields." };
  }
  if (!Array.isArray(body.participantIds) || body.participantIds.length === 0 || body.participantIds.length > 20 ||
      body.participantIds.some((id) => typeof id !== "string" || id.length === 0 || id.length > 300 || id.trim() !== id)) {
    return { participantIds: null, error: "participantIds must be a non-empty array of at most 20 user IDs." };
  }
  return { participantIds: body.participantIds as string[], error: null };
}

export function normalizeConversationParticipantsBody(
  body: Record<string, unknown>,
): { input: { addUserIds: string[]; removeUserIds: string[] } | null; error: string | null } {
  if (Object.keys(body).some((key) => key !== "addUserIds" && key !== "removeUserIds")) {
    return { input: null, error: "The request contains unsupported fields." };
  }
  const addUserIds = body.addUserIds ?? [];
  const removeUserIds = body.removeUserIds ?? [];
  for (const [name, value] of [["addUserIds", addUserIds], ["removeUserIds", removeUserIds]] as const) {
    if (!Array.isArray(value) || value.length > 20 ||
        value.some((id) => typeof id !== "string" || id.length === 0 || id.length > 300 || id.trim() !== id)) {
      return { input: null, error: name + " must be an array of at most 20 user IDs." };
    }
  }
  return { input: { addUserIds: addUserIds as string[], removeUserIds: removeUserIds as string[] }, error: null };
}

export function normalizeMessageWriteBody(
  body: Record<string, unknown>,
): { body: string | null; error: string | null } {
  if (Object.keys(body).some((key) => key !== "body")) {
    return { body: null, error: "The request contains unsupported fields." };
  }
  if (typeof body.body !== "string" || body.body.length === 0 || body.body.length > 20000 ||
      body.body.trim().length === 0 || body.body.trim() !== body.body) {
    return { body: null, error: "body must be non-empty, trimmed text no longer than 20000 characters." };
  }
  return { body: body.body, error: null };
}
