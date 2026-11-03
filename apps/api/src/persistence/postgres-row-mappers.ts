/**
 * Row mappers shared by the PostgreSQL domain slices.
 *
 * One mapper per stored shape, in one place. A slice that reshapes a row itself
 * is how two endpoints end up answering different JSON for the same work — and
 * the row shapes here are the adapter's private vocabulary, so they live beside
 * the slices rather than in a shared package.
 */
import { createHash } from "node:crypto";
import { normalizeStoredRole } from "../domain/profile.ts";

/** A stable digest of a request payload, used for idempotency conflict detection. */
export function requestHash(value): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function parseJsonValue(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

export function isoDate(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function mapMessage(row, duplicate = false) {
  const createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString();
  return { id: row.id, conversationId: row.conversation_id, senderId: row.sender_id, body: row.body, createdAt, duplicate };
}

export function mapConversation(row) {
  return {
    id: row.id,
    createdBy: row.created_by ?? null,
    participantIds: row.participant_ids ?? [],
    createdAt: isoDate(row.created_at),
    lastActivityAt: isoDate(row.last_activity_at ?? row.created_at),
    unreadCount: Number(row.unread_count ?? 0),
    lastMessage: row.latest_message_id ? mapMessage({
      id: row.latest_message_id,
      conversation_id: row.latest_message_conversation_id,
      sender_id: row.latest_message_sender_id,
      body: row.latest_message_body,
      created_at: row.latest_message_created_at,
    }) : null,
  };
}

export function mapArticleComment(row) {
  const iso = (value) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  return {
    id: row.id,
    articleId: row.article_id,
    authorId: row.author_id,
    parentCommentId: row.parent_comment_id,
    content: row.content,
    contentBlocks: row.content_blocks == null ? null : parseJsonValue(row.content_blocks),
    contentBlocksVersion: Number(row.content_blocks_version ?? 0),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    locale: row.locale,
    replies: [],
  };
}

export function mapTaxonomy(row) {
  return {
    id: row.id,
    kind: row.kind,
    slug: row.slug,
    name: row.name,
    description: row.description ?? "",
    locale: row.locale,
    createdBy: row.created_by,
    articleCount: Number(row.article_count ?? 0),
  };
}

export function mapArticle(row) {
  const iso = (value) => value == null ? null : (value instanceof Date ? value.toISOString() : new Date(value).toISOString());
  return {
    id: row.id,
    authorId: row.author_id,
    slug: row.slug,
    workType: row.work_type ?? "other",
    status: row.status,
    locale: row.locale,
    title: row.title,
    summary: row.summary,
    contentBlocks: parseJsonValue(row.content_blocks),
    contentBlocksVersion: Number(row.content_blocks_version ?? 0),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    publishedAt: iso(row.published_at),
  };
}

export function mapAuthorProfile(row) {
  const iso = (value) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  return {
    userId: row.user_id,
    role: normalizeStoredRole(row.role),
    displayName: row.display_name,
    bio: row.bio,
    avatarUrl: row.avatar_url,
    websiteUrl: row.website_url,
    locale: row.locale,
    followerCount: Number(row.follower_count ?? 0),
    followingCount: Number(row.following_count ?? 0),
    isFollowing: Boolean(row.is_following_viewer ?? false),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
