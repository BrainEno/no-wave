import { ARTICLE_SUMMARY_MAX_LENGTH } from "../../../domain/article-summary.ts";
import {
  SUPPORTED_ARTICLE_LOCALES,
  retiredArticleWorkTypes,
  supportedArticleWorkTypes,
} from "../../../domain/article.ts";
import { USER_ROLES } from "../../../domain/profile.ts";

/**
 * The component schemas of the published OpenAPI document.
 *
 * Every schema here is a **reading** of a type the API already has, not a second
 * contract: `Article` mirrors `StoredArticle` plus the three projections
 * `serializeRestArticle` adds, `AuthorProfile` mirrors `StoredAuthorProfile`, and
 * the request bodies mirror the `normalize*Body` functions in `../bodies.ts`.
 * Where a bound exists in code (`ARTICLE_SUMMARY_MAX_LENGTH`, the work-type list,
 * `USER_ROLES`, the media page size) it is imported rather than copied, so the
 * document cannot describe a limit the server does not enforce.
 *
 * What these schemas deliberately do **not** claim:
 *
 * - `additionalProperties` is never set to `false`. The document is a description
 *   of the fields a reader can rely on, and the projection layer passes values it
 *   does not understand through untouched; claiming a closed object would be a
 *   promise the serializers do not make.
 * - Block bodies (`contentBlocks`) are `array` of `object`: the application
 *   contract is versioned and owned by the domain, and pinning it here would put
 *   a second copy of the block schema in the transport.
 */

export type JsonSchema = Readonly<Record<string, unknown>>;

/** `$ref` into the component section of the same document. */
const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });

/** A value that may be `null`, spelled without JSON-Schema type arrays. */
const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: "null" }] });

const LOCALES: readonly string[] = [...SUPPORTED_ARTICLE_LOCALES];

/** Types a **new** work may be created with: `serial` exists but is retired. */
const CHOOSABLE_WORK_TYPES: readonly string[] = supportedArticleWorkTypes.filter(
  (workType) => !retiredArticleWorkTypes.includes(workType),
);

const TEXT = { type: "string" } as const;
const TIMESTAMP: JsonSchema = { type: "string", format: "date-time" };
const NULLABLE_TIMESTAMP: JsonSchema = nullable(TIMESTAMP);

/** One block of application-owned article content. */
const CONTENT_BLOCKS: JsonSchema = {
  type: "array",
  items: { type: "object" },
  description:
    "Application-owned content blocks. Version 0 is text-only (`{id, type, text}`); version 1 adds inline marks and links. Raw Lexical JSON is never stored or returned.",
};

const ERROR_RESPONSE: JsonSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: { type: "string", description: "Stable machine-readable error code, for example `BAD_USER_INPUT` or `IDEMPOTENCY_CONFLICT`." },
        message: { type: "string", description: "Sanitized human-readable message. Internal details are never included." },
        details: { type: "object", description: "Optional structured detail, for example the works that reference a media asset." },
      },
    },
  },
};

export const SCHEMAS: Readonly<Record<string, JsonSchema>> = Object.freeze({
  Error: ERROR_RESPONSE,

  Health: {
    type: "object",
    required: ["status", "service", "version"],
    properties: {
      status: { type: "string", enum: ["ok"] },
      service: { type: "string", enum: ["api"] },
      version: { type: "string" },
    },
  },

  CurrentUser: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", description: "The authenticated account's stable user id." } },
  },

  AuthSession: {
    type: "object",
    required: ["accessToken", "tokenType", "accessExpiresAt", "refreshToken", "refreshExpiresAt"],
    description:
      "Bearer credentials. Send `accessToken` as `Authorization: Bearer <token>`; spend `refreshToken` exactly once at `POST /auth/refresh`.",
    properties: {
      accessToken: TEXT,
      tokenType: { type: "string", enum: ["Bearer"] },
      accessExpiresAt: TIMESTAMP,
      refreshToken: TEXT,
      refreshExpiresAt: TIMESTAMP,
    },
  },

  Ok: {
    type: "object",
    required: ["ok"],
    properties: { ok: { type: "boolean", enum: [true] } },
  },

  SessionSummary: {
    type: "object",
    required: ["sessionId", "createdAt", "expiresAt", "current"],
    properties: {
      sessionId: TEXT,
      createdAt: TIMESTAMP,
      lastUsedAt: NULLABLE_TIMESTAMP,
      expiresAt: TIMESTAMP,
      current: { type: "boolean", description: "True for the session that made this request." },
    },
  },

  SessionList: {
    type: "object",
    required: ["sessions"],
    properties: { sessions: { type: "array", items: ref("SessionSummary") } },
  },

  SessionRevocationReceipt: {
    type: "object",
    required: ["ok", "revokedSessions"],
    properties: {
      ok: { type: "boolean", enum: [true] },
      revokedSessions: { type: "integer", minimum: 0, description: "How many other sessions were signed out. The asking session is spared." },
    },
  },

  EmailChangeReceipt: {
    type: "object",
    required: ["ok", "email"],
    properties: {
      ok: { type: "boolean", enum: [true] },
      email: { type: "string", format: "email" },
      emailVerifiedAt: NULLABLE_TIMESTAMP,
    },
  },

  EmailVerificationReceipt: {
    type: "object",
    required: ["ok", "alreadyVerified"],
    properties: {
      ok: { type: "boolean", enum: [true] },
      alreadyVerified: { type: "boolean", description: "An address that was already verified is not mailed again." },
    },
  },

  AuthorProfile: {
    type: "object",
    required: ["userId", "role", "displayName", "bio", "locale"],
    description: "A member's public profile, plus the viewer-specific follow state when a token was presented.",
    properties: {
      userId: TEXT,
      role: { type: "string", enum: [...USER_ROLES] },
      displayName: TEXT,
      bio: TEXT,
      avatarUrl: nullable(TEXT),
      websiteUrl: nullable(TEXT),
      locale: { type: "string", enum: LOCALES },
      followerCount: { type: "integer", minimum: 0 },
      followingCount: { type: "integer", minimum: 0 },
      isFollowing: { type: "boolean", description: "True when the authenticated viewer follows this author." },
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    },
  },

  AuthorDirectoryEntry: {
    type: "object",
    required: ["userId", "displayName", "bio", "locale"],
    description: "One row of the public author directory: reach and published-work count, no contact details.",
    properties: {
      userId: TEXT,
      displayName: TEXT,
      bio: TEXT,
      locale: { type: "string", enum: LOCALES },
      followerCount: { type: "integer", minimum: 0 },
      workCount: { type: "integer", minimum: 0 },
    },
  },

  Article: {
    type: "object",
    required: ["id", "authorId", "slug", "workType", "status", "locale", "title", "summary", "contentBlocks", "contentBlocksVersion"],
    description:
      "A stored work plus the `author`, `categories` and `tags` the API adds. One id identifies the work; `(id, locale)` identifies one of its translations.",
    properties: {
      id: TEXT,
      authorId: TEXT,
      slug: { type: "string", description: "Work-wide address, not per translation." },
      workType: {
        type: "string",
        enum: [...supportedArticleWorkTypes],
        description: "`serial` is retired: it can be read and saved but not chosen for new work.",
      },
      status: { type: "string", enum: ["draft", "published"] },
      locale: { type: "string", enum: LOCALES },
      title: TEXT,
      summary: { type: "string", maxLength: ARTICLE_SUMMARY_MAX_LENGTH },
      contentBlocks: CONTENT_BLOCKS,
      contentBlocksVersion: { type: "integer", enum: [0, 1] },
      createdAt: NULLABLE_TIMESTAMP,
      updatedAt: NULLABLE_TIMESTAMP,
      publishedAt: NULLABLE_TIMESTAMP,
      author: nullable(ref("AuthorProfile")),
      categories: { type: "array", items: ref("Taxonomy") },
      tags: { type: "array", items: ref("Taxonomy") },
    },
  },

  DeletedArticle: {
    description: "A tombstone in the author's recycle bin: the work plus when it was deleted and what its removal will sweep.",
    allOf: [ref("Article")],
    type: "object",
    properties: {
      deletedAt: TIMESTAMP,
      commentCount: { type: "integer", minimum: 0 },
    },
    required: ["deletedAt", "commentCount"],
  },

  ArticleDeletionReceipt: {
    type: "object",
    required: ["id", "deletedAt"],
    properties: { id: TEXT, deletedAt: TIMESTAMP },
  },

  ArticleLikeState: {
    type: "object",
    required: ["articleId", "slug", "likeCount", "likedByViewer"],
    properties: {
      articleId: TEXT,
      slug: TEXT,
      likeCount: { type: "integer", minimum: 0 },
      likedByViewer: { type: "boolean" },
    },
  },

  Comment: {
    type: "object",
    required: ["id", "articleId", "authorId", "content", "contentBlocks", "contentBlocksVersion", "createdAt", "editedAt", "locale", "replies"],
    properties: {
      id: TEXT,
      articleId: TEXT,
      authorId: TEXT,
      parentCommentId: nullable(TEXT),
      content: { type: "string", description: "Plain-text rendering that matches the versioned blocks." },
      contentBlocks: CONTENT_BLOCKS,
      contentBlocksVersion: { type: "integer", enum: [0, 1] },
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      editedAt: {
        ...NULLABLE_TIMESTAMP,
        description: "When the author last corrected the text, or `null` for a comment as written. Previous text is not retained (ADR 0031).",
      },
      locale: { type: "string", enum: LOCALES },
      author: nullable(ref("AuthorProfile")),
      replies: { type: "array", items: { $ref: "#/components/schemas/Comment" } },
    },
  },

  Taxonomy: {
    type: "object",
    required: ["id", "kind", "slug", "name", "locale"],
    properties: {
      id: TEXT,
      kind: { type: "string", enum: ["category", "tag"] },
      slug: TEXT,
      name: TEXT,
      description: TEXT,
      locale: { type: "string", enum: LOCALES },
      createdBy: nullable(TEXT),
      articleCount: { type: "integer", minimum: 0 },
    },
  },

  DeletionReceipt: {
    type: "object",
    required: ["deleted"],
    properties: { deleted: { type: "boolean", description: "False when the caller does not own the row; ownership failures are not distinguished from absence." } },
  },

  MediaAsset: {
    type: "object",
    required: ["id", "ownerId", "contentType", "byteSize", "width", "height", "createdAt"],
    description: "One uploaded, immutable image. The address a content body keeps is `src: /api/media/<id>`.",
    properties: {
      id: TEXT,
      ownerId: TEXT,
      storageKey: TEXT,
      contentType: { type: "string", enum: ["image/webp"] },
      byteSize: { type: "integer", minimum: 1 },
      width: { type: "integer", minimum: 1 },
      height: { type: "integer", minimum: 1 },
      sha256: TEXT,
      createdAt: TIMESTAMP,
      src: { type: "string", description: "Application-relative address: `/api/media/<id>`." },
    },
  },

  MediaLibraryPage: {
    type: "object",
    required: ["items", "nextCursor"],
    properties: {
      items: { type: "array", items: ref("MediaAsset") },
      nextCursor: nullable(TEXT),
    },
  },

  MediaDeletionReceipt: {
    type: "object",
    required: ["id"],
    properties: { id: TEXT },
  },

  Notification: {
    type: "object",
    required: ["id", "eventKey", "payload", "createdAt", "readAt"],
    description: "One inbox row. `userId` is the recipient and is never part of the response.",
    properties: {
      id: TEXT,
      eventKey: TEXT,
      payload: { type: "string", description: "The event payload, serialized as JSON text." },
      createdAt: TIMESTAMP,
      readAt: NULLABLE_TIMESTAMP,
    },
  },

  Message: {
    type: "object",
    required: ["id", "conversationId", "senderId", "body", "createdAt"],
    properties: {
      id: TEXT,
      conversationId: TEXT,
      senderId: TEXT,
      body: { type: "string", maxLength: 20000 },
      createdAt: TIMESTAMP,
      duplicate: { type: "boolean", description: "True when an idempotent replay returned the stored message instead of sending another." },
    },
  },

  Conversation: {
    type: "object",
    required: ["id", "participantIds", "createdAt", "lastActivityAt", "unreadCount"],
    properties: {
      id: TEXT,
      createdBy: nullable(TEXT),
      participantIds: { type: "array", items: TEXT },
      createdAt: TIMESTAMP,
      lastActivityAt: TIMESTAMP,
      unreadCount: { type: "integer", minimum: 0 },
      lastMessage: nullable(ref("Message")),
    },
  },

  /* ------------------------------------------------------------------ */
  /* Request bodies                                                      */
  /* ------------------------------------------------------------------ */

  CredentialsRequest: {
    type: "object",
    required: ["email", "password"],
    properties: {
      email: { type: "string", format: "email" },
      password: { type: "string", minLength: 12, maxLength: 128 },
    },
  },

  RefreshTokenRequest: {
    type: "object",
    required: ["refreshToken"],
    properties: { refreshToken: TEXT },
  },

  PasswordResetRequest: {
    type: "object",
    required: ["token", "password"],
    properties: {
      token: { type: "string", description: "Base64url single-use token from the recovery mail. Redeemed in the body, never in a path." },
      password: { type: "string", minLength: 12, maxLength: 128 },
    },
  },

  VerifyEmailRequest: {
    type: "object",
    required: ["token"],
    properties: { token: { type: "string", description: "Single-use token from the verification mail." } },
  },

  ArticleWrite: {
    type: "object",
    required: ["title"],
    description:
      "Create: `title` plus exactly one of `contentBlocks` / `editorState`. Update: `slug` and `publish` are mandatory, and an explicit `locale` replaces that translation of the work. Unknown fields are rejected.",
    properties: {
      slug: { type: "string", description: "Optional on create (derived from the title); mandatory on update." },
      title: TEXT,
      summary: { type: "string", maxLength: ARTICLE_SUMMARY_MAX_LENGTH, description: "Blank or absent means the server derives one from the body text." },
      locale: { type: "string", enum: LOCALES, description: "Absent keeps the historical `zh-CN` default; a client editing another edition must send its locale." },
      contentBlocks: { type: "array", items: { type: "object" }, description: "Version 0 blocks, or version 1 when `contentBlocksVersion` is 1." },
      editorState: { type: "object", description: "Write-only serialized Lexical state. Normalized to `contentBlocks` before storage; requires `contentBlocksVersion: 1`." },
      contentBlocksVersion: { type: "integer", enum: [0, 1] },
      publish: { type: "boolean" },
      workType: {
        type: "string",
        enum: [...CHOOSABLE_WORK_TYPES],
        description: "Types a new work may be created with. `serial` answers 400 on create; a stored `serial` work stays saveable and may be moved to an active type.",
      },
      categoryIds: { type: "array", items: TEXT },
      tagIds: { type: "array", items: TEXT },
    },
  },

  CommentWrite: {
    type: "object",
    description: "Exactly one of `content` (version 0 plain text) or `contentBlocks` / `editorState` (version 1 rich text).",
    properties: {
      content: { type: "string" },
      contentBlocks: { type: "array", items: { type: "object" } },
      editorState: { type: "object", description: "Write-only serialized Lexical state." },
      contentBlocksVersion: { type: "integer", enum: [0, 1] },
      parentCommentId: nullable(TEXT),
    },
  },

  /**
   * A correction, not a new comment: no `parentCommentId`, because an edit may not
   * move a reply out of the thread it answered.
   */
  CommentUpdate: {
    type: "object",
    description: "Exactly one of `content` (version 0 plain text) or `contentBlocks` / `editorState` (version 1 rich text). An edit replaces the text and stamps `editedAt`; it does not re-notify the thread.",
    properties: {
      content: { type: "string", maxLength: 5000 },
      contentBlocks: { type: "array", items: { type: "object" } },
      editorState: { type: "object", description: "Write-only serialized Lexical state." },
      contentBlocksVersion: { type: "integer", enum: [0, 1] },
    },
  },

  ProfileWrite: {
    type: "object",
    required: ["displayName"],
    description: "Unsupported fields are rejected. `locale` may only be `zh-CN` today.",
    properties: {
      displayName: TEXT,
      bio: TEXT,
      avatarUrl: nullable(TEXT),
      websiteUrl: nullable(TEXT),
      locale: { type: "string", enum: ["zh-CN"] },
    },
  },

  PasswordChange: {
    type: "object",
    required: ["currentPassword", "newPassword"],
    properties: {
      currentPassword: TEXT,
      newPassword: { type: "string", minLength: 12, maxLength: 128 },
    },
  },

  EmailChange: {
    type: "object",
    required: ["password", "email"],
    properties: {
      password: TEXT,
      email: { type: "string", format: "email" },
    },
  },

  RoleWrite: {
    type: "object",
    required: ["role"],
    properties: { role: { type: "string", enum: [...USER_ROLES] } },
  },

  FeaturedWrite: {
    type: "object",
    required: ["articleIds"],
    description: "The whole ordered shelf, not individual moves: two editors cannot interleave into a shelf neither asked for.",
    properties: { articleIds: { type: "array", items: TEXT } },
  },

  TagCreate: {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 120 },
      locale: { type: "string", enum: ["zh-CN"] },
    },
  },

  TaxonomyCreate: {
    type: "object",
    required: ["kind", "slug", "name"],
    description: "A category is editorial (editors only); a tag is the author's own words.",
    properties: {
      kind: { type: "string", enum: ["category", "tag"] },
      slug: TEXT,
      name: TEXT,
      description: { type: "string", maxLength: 2000 },
      locale: { type: "string", enum: ["zh-CN"] },
    },
  },

  ConversationCreate: {
    type: "object",
    required: ["participantIds"],
    properties: {
      participantIds: { type: "array", minItems: 1, maxItems: 20, items: TEXT },
    },
  },

  ConversationParticipantsWrite: {
    type: "object",
    properties: {
      addUserIds: { type: "array", maxItems: 20, items: TEXT },
      removeUserIds: { type: "array", maxItems: 20, items: TEXT },
    },
  },

  MessageWrite: {
    type: "object",
    required: ["body"],
    properties: { body: { type: "string", minLength: 1, maxLength: 20000, description: "Non-empty, trimmed text." } },
  },

  LikeWrite: {
    type: "object",
    required: ["liked"],
    description: "Explicit state, not a toggle, so a retried request cannot flip it back.",
    properties: { liked: { type: "boolean" } },
  },
});

/**
 * Media library page bounds.
 *
 * Written here rather than imported from `application/media-assets.ts` because
 * that module loads `sharp`, and the contract must be buildable — and servable —
 * without an image toolchain. `openapi.test.ts` asserts these numbers equal
 * `MEDIA_PAGE_SIZE` and `MEDIA_PAGE_SIZE_MAX`, so the duplication cannot rot.
 */
export const MEDIA_LIMIT_BOUNDS = Object.freeze({ default: 24, min: 1, max: 60 });
