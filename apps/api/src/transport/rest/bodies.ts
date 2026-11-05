import type { IncomingMessage, ServerResponse } from "node:http";
import { USER_ROLES, type UserRole } from "../../domain/profile.ts";
import { lexicalEditorStateToArticleDocument } from "../../domain/lexical-document-adapter.ts";
import { ARTICLE_SUMMARY_MAX_LENGTH, summarizeArticleBlocks } from "../../domain/article-summary.ts";
import { ArticleInputError } from "../../domain/errors.ts";
import { normalizeCommentContentInput } from "../../domain/comment-content.ts";
import { isRecord } from "./http.ts";

/**
 * The REST-normalized article write body.
 *
 * `contentBlocks` is still a serialized JSON string here: the application
 * service parses it at the boundary (`createApplicationServices`). Keeping this
 * shape explicit stops a `Record<string, unknown>` spread from erasing the
 * knowledge that `title`, `locale`, `contentBlocks` and `summary` are always
 * present after validation.
 */
export type ArticleWriteBody = {
  title: string;
  locale: "zh-CN" | "zh-TW" | "en";
  contentBlocks: string;
  summary: string;
  slug?: string;
  publish?: boolean;
  workType?: string;
  contentBlocksVersion?: number;
  categoryIds?: readonly unknown[];
  tagIds?: readonly unknown[];
};
/** Updates address a stored article, so the slug and publish flag are mandatory. */
export type ArticleUpdateBody = ArticleWriteBody & { slug: string; publish: boolean };

/** A profile write body after validation; optional nullable URLs stay optional. */
export type ProfileWriteBody = {
  displayName: string;
  bio: string;
  locale: "zh-CN";
  avatarUrl?: string | null;
  websiteUrl?: string | null;
};

export const ARTICLE_WRITE_FIELDS = new Set([
  "slug", "title", "summary", "locale", "contentBlocks", "editorState", "contentBlocksVersion", "publish", "workType", "categoryIds", "tagIds",
]);

export function normalizeArticleWriteBody(body: Record<string, unknown>, requirePublish: true): { input: ArticleUpdateBody | null; error: string | null };
export function normalizeArticleWriteBody(body: Record<string, unknown>, requirePublish: boolean): { input: ArticleWriteBody | null; error: string | null };
export function normalizeArticleWriteBody(
  body: Record<string, unknown>,
  requirePublish: boolean,
): { input: ArticleWriteBody | null; error: string | null } {
  if (Object.keys(body).some((key) => !ARTICLE_WRITE_FIELDS.has(key))) {
    return { input: null, error: "The request contains unsupported fields." };
  }
  // Missing locale retains the historical Simplified Chinese default. An
  // explicit locale must pass through unchanged: zh-TW may be a legacy work
  // even though the desk no longer offers it for new compositions.
  const locale = body.locale === undefined ? "zh-CN" : body.locale;
  if (locale !== "zh-CN" && locale !== "zh-TW" && locale !== "en") {
    return { input: null, error: "locale must be zh-CN, zh-TW, or en." };
  }
  const title = body.title;
  if (typeof title !== "string") {
    return { input: null, error: "title must be a string." };
  }
  const slugValue = body.slug;
  if (slugValue !== undefined && typeof slugValue !== "string") {
    return { input: null, error: "slug must be a string when supplied." };
  }
  // Article creation may omit the slug: the route then derives one from the
  // title. Updates address a stored article, so they must name its slug.
  const requestedSlug = typeof slugValue === "string" ? slugValue.trim() : "";
  if (requirePublish && requestedSlug.length === 0) {
    return { input: null, error: "slug must be supplied as a non-empty string for article updates." };
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
    } catch (error: unknown) {
      if (error instanceof ArticleInputError) {
        // Report the adapter's reason — an empty document must not read like an
        // unsupported node — without exposing the internal error prefix.
        return { input: null, error: "editorState " + String(error.message).replace(/^Lexical adapter: /, "") };
      }
      return { input: null, error: "editorState contains invalid or unsupported article content." };
    }
  } else {
    if (!Array.isArray(body.contentBlocks)) {
      return { input: null, error: "contentBlocks must be a JSON array." };
    }
    contentBlocks = body.contentBlocks;
  }

  const summaryValue = body.summary;
  if (summaryValue !== undefined && typeof summaryValue !== "string") {
    return { input: null, error: "summary must be a string." };
  }
  const workType = body.workType;
  if (workType !== undefined && typeof workType !== "string") {
    return { input: null, error: "workType must be a string." };
  }
  const publish = body.publish;
  if (publish !== undefined && typeof publish !== "boolean") {
    return { input: null, error: "publish must be a boolean." };
  }
  if (requirePublish && typeof publish !== "boolean") {
    return { input: null, error: "publish must be supplied as a boolean for article updates." };
  }
  const contentBlocksVersion = body.contentBlocksVersion;
  if (contentBlocksVersion !== undefined &&
      (typeof contentBlocksVersion !== "number" || !Number.isInteger(contentBlocksVersion) ||
       (contentBlocksVersion !== 0 && contentBlocksVersion !== 1))) {
    return { input: null, error: "contentBlocksVersion must be 0 or 1." };
  }
  const categoryIds = body.categoryIds;
  const tagIds = body.tagIds;
  for (const [field, value] of [["categoryIds", categoryIds], ["tagIds", tagIds]] as const) {
    if (value !== undefined && !Array.isArray(value)) {
      return { input: null, error: field + " must be an array when supplied." };
    }
  }

  // An empty summary is derived from the beginning of the body text.
  const summary = typeof summaryValue === "string" && summaryValue.trim().length > 0
    ? summaryValue
    : summarizeArticleBlocks(contentBlocks, { maxLength: ARTICLE_SUMMARY_MAX_LENGTH });
  const input: ArticleWriteBody = {
    title,
    locale,
    contentBlocks: JSON.stringify(contentBlocks),
    summary,
  };
  if (requestedSlug.length > 0) {
    // No slug supplied: omit the key entirely so the route generates one
    // instead of forwarding an empty value the domain validator would reject.
    input.slug = requestedSlug;
  }
  if (hasEditorState) input.contentBlocksVersion = 1;
  else if (typeof contentBlocksVersion === "number") input.contentBlocksVersion = contentBlocksVersion;
  if (typeof publish === "boolean") input.publish = publish;
  if (typeof workType === "string") input.workType = workType;
  if (Array.isArray(categoryIds)) input.categoryIds = categoryIds;
  if (Array.isArray(tagIds)) input.tagIds = tagIds;
  return { input, error: null };
}

export const PROFILE_WRITE_FIELDS = new Set(["displayName", "bio", "avatarUrl", "websiteUrl", "locale"]);

export function normalizeProfileWriteBody(
  body: Record<string, unknown>,
): { input: ProfileWriteBody | null; error: string | null } {
  if (Object.keys(body).some((key) => !PROFILE_WRITE_FIELDS.has(key))) {
    return { input: null, error: "The request contains unsupported fields." };
  }
  if (body.locale !== undefined && body.locale !== "zh-CN") {
    return { input: null, error: "The REST API currently supports only locale zh-CN." };
  }
  const displayName = body.displayName;
  if (typeof displayName !== "string") {
    return { input: null, error: "displayName must be a string." };
  }
  const bio = body.bio;
  if (bio !== undefined && typeof bio !== "string") {
    return { input: null, error: "bio must be a string." };
  }
  const avatarUrl = body.avatarUrl;
  const websiteUrl = body.websiteUrl;
  for (const [field, value] of [["avatarUrl", avatarUrl], ["websiteUrl", websiteUrl]] as const) {
    if (value !== undefined && value !== null && typeof value !== "string") {
      return { input: null, error: field + " must be a string or null." };
    }
  }
  const input: ProfileWriteBody = {
    displayName,
    bio: typeof bio === "string" ? bio : "",
    locale: "zh-CN",
  };
  if (Object.hasOwn(body, "avatarUrl")) {
    if (avatarUrl === null) input.avatarUrl = null;
    else if (typeof avatarUrl === "string") input.avatarUrl = avatarUrl;
    else input.avatarUrl = undefined;
  }
  if (Object.hasOwn(body, "websiteUrl")) {
    if (websiteUrl === null) input.websiteUrl = null;
    else if (typeof websiteUrl === "string") input.websiteUrl = websiteUrl;
    else input.websiteUrl = undefined;
  }
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

/**
 * Role assignment body: exactly one field, and only the values the schema accepts.
 *
 * The whitelist lives here and not only in the persistence layer so an unsupported
 * role is a 400 about the request rather than a 500 from a CHECK constraint.
 */
export function normalizeRoleWriteBody(
  body: Record<string, unknown>,
): { input: { role: UserRole } | null; error: string | null } {
  if (Object.keys(body).some((key) => key !== "role")) {
    return { input: null, error: "The request contains unsupported fields." };
  }
  if (typeof body.role !== "string" || !USER_ROLES.includes(body.role as UserRole)) {
    return { input: null, error: `role must be one of: ${USER_ROLES.join(", ")}.` };
  }
  return { input: { role: body.role as UserRole }, error: null };
}

/**
 * Featured-shelf body: exactly one field, the whole ordered list.
 *
 * Shape only — bounds and publishability are the persistence layer's job, because
 * it is the layer that can see whether a work is actually published.
 */
export function normalizeFeaturedWriteBody(
  body: Record<string, unknown>,
): { input: { articleIds: string[] } | null; error: string | null } {
  if (Object.keys(body).some((key) => key !== "articleIds")) {
    return { input: null, error: "The request contains unsupported fields." };
  }
  if (!Array.isArray(body.articleIds) || !body.articleIds.every((id) => typeof id === "string")) {
    return { input: null, error: "articleIds must be an array of article identifiers." };
  }
  return { input: { articleIds: body.articleIds as string[] }, error: null };
}
