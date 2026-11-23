import {
  MAX_ARTICLE_OFFSET,
  MAX_ARTICLE_OFFSET_POPULAR,
  MAX_FEATURED_ARTICLES,
  SUPPORTED_ARTICLE_LOCALES,
  supportedArticleWorkTypes,
} from "../../../domain/article.ts";
import { AUTHOR_OFFSET_MAX, USER_ROLES } from "../../../domain/profile.ts";
import { MAX_QUERY_LENGTH, MAX_TAXONOMY_OFFSET } from "../http.ts";
import { MEDIA_LIMIT_BOUNDS, type JsonSchema } from "./schemas.ts";

/**
 * One row of prose per REST operation, and the parameters that go with it.
 *
 * The document is generated from `../routes.ts` — paths, methods and path
 * parameters come from the route table itself — so this file only adds the things
 * the table cannot know: what an operation is for, whether it needs a session,
 * which query parameters and body it takes, and what comes back.
 *
 * Keys are `"<METHOD> <route id>"` because the route id is the name the
 * dispatcher, the handler module and the 405 allow-list already use; a summary
 * keyed by path would be a fourth name for the same endpoint.
 *
 * `assertOpenApiCoversOperations` at the bottom of this file runs on import, the
 * same way the write rate-limit check does in `routes.ts`: a route added to the
 * table without a documented operation fails the API at start-up and in CI,
 * instead of quietly leaving the published contract incomplete. That failure is
 * the point — the alternative is a document that is *almost* the API.
 */

export type OperationSecurity =
  /** No credential is read. */
  | "none"
  /** A verified bearer token is required; an unauthenticated request is `401`. */
  | "session"
  /** Public, but a valid token adds viewer-specific state (`likedByViewer`, `isFollowing`). */
  | "optional-session";

export type QueryParameter = {
  readonly name: string;
  readonly description: string;
  readonly schema: JsonSchema;
  /**
   * The parameter must be present.
   *
   * Absent means optional, which is what every query parameter was until an
   * endpoint existed that cannot answer without one (`slugs` on the Notion
   * export). Stating it in the contract matters: a generated client that believes
   * the parameter is optional cannot be blamed for sending none of it.
   */
  readonly required?: boolean;
};

export type ResponseSpec = {
  /** `200` when omitted. `201` for creations, `202` for accepted-but-asynchronous work. */
  readonly status?: number;
  readonly description: string;
  /** Component schema placed under `data`; omitted when the operation answers without a body. */
  readonly data?: string;
  /** `data` is an array of the named component. */
  readonly array?: boolean;
  /** `data` is a bare JSON scalar rather than an object. */
  readonly scalar?: "string" | "number" | "boolean";
  /** The response carries a `meta` object next to `data`. */
  readonly meta?: boolean;
  /** Overrides `application/json`, for the image read. */
  readonly contentType?: string;
};

export type RequestBodySpec = {
  readonly schema: string;
  readonly description: string;
  readonly required?: boolean;
  /** Defaults to `application/json`. */
  readonly contentType?: string;
};

export type OperationMetadata = {
  readonly summary: string;
  readonly security: OperationSecurity;
  readonly tags: readonly string[];
  readonly response: ResponseSpec;
  readonly query?: readonly QueryParameter[];
  readonly headers?: readonly QueryParameter[];
  readonly notModified?: boolean;
  readonly requestBody?: RequestBodySpec;
  /**
   * `Idempotency-Key` support, as implemented: create-article and create-comment
   * accept the header and replay the stored row for the same request, while
   * conversations and messages require it because a duplicate conversation or
   * message is not something a retry can be allowed to invent.
   */
  readonly idempotency?: "optional" | "required" | "notion-job" | "notion-job-lookup";
  /** Extra error statuses beyond the `400` / `401` every operation already documents. */
  readonly errors?: readonly number[];
  /** Overrides the generated description of a path parameter. */
  readonly pathParams?: Readonly<Record<string, string>>;
  readonly description?: string;
};

const LOCALES: readonly string[] = [...SUPPORTED_ARTICLE_LOCALES];

/* -------------------------------------------------------------------------- */
/* Query parameters                                                            */
/* -------------------------------------------------------------------------- */

const localeParameter = (description = "Language edition to read. Defaults to `zh-CN` when absent."): QueryParameter => ({
  name: "locale",
  description,
  schema: { type: "string", enum: LOCALES },
});

const queryParameter = (): QueryParameter => ({
  name: "query",
  description: "Text search across the title, the summary and the body of every published work, block by block.",
  schema: { type: "string", maxLength: MAX_QUERY_LENGTH },
});

const limitParameter = (fallback: number, max = 100): QueryParameter => ({
  name: "limit",
  description: `Page size, 1–${max}. Defaults to ${fallback}.`,
  schema: { type: "integer", minimum: 1, maximum: max, default: fallback },
});

const offsetParameter = (max: number, note?: string): QueryParameter => ({
  name: "offset",
  description: `Rows to skip, 0–${max}.${note === undefined ? "" : ` ${note}`}`,
  schema: { type: "integer", minimum: 0, maximum: max, default: 0 },
});

const cursorParameter = (): QueryParameter => ({
  name: "cursor",
  description:
    "Opaque `base64url(\"<publishedAt>|<id>\")` of the last work already seen. Cannot be combined with `offset`, and is only supported with `sort=latest`. An empty page is the end of the list.",
  schema: { type: "string" },
});

const sortParameter = (): QueryParameter => ({
  name: "sort",
  description:
    "`latest` orders by publication date; `popular` by like count over the work's whole life. Unknown values are `400 BAD_INPUT`.",
  schema: { type: "string", enum: ["latest", "popular"], default: "latest" },
});

const allLocalesParameter = (): QueryParameter => ({
  name: "allLocales",
  description:
    "Writing-desk opt-in: read all three editions of the actor's own work in one request. Returns `meta.locales`; cannot be combined with `locale`, and `limit` then applies per locale.",
  schema: { type: "boolean", default: false },
});

const beforeParameter = (): QueryParameter => ({
  name: "before",
  description: "Message id to page backwards from. Must belong to the same conversation.",
  schema: { type: "string" },
});

const articleViewParameter = (): QueryParameter => ({
  name: "view", description: "Absent or full returns complete bodies. Explicit card omits contentBlocks and includes contentProjection=card and reading metadata, without changing ordering, pagination, visibility or locale. Detail/authoring reads always remain full.",
  schema: { type: "string", enum: ["full", "card"], default: "full" },
});

const ARTICLE_PAGE = [articleViewParameter(), queryParameter(), sortParameter(), limitParameter(20), offsetParameter(MAX_ARTICLE_OFFSET, "`sort=popular` stops at 10,000 because its ranking changes while it is read."), cursorParameter(), localeParameter()];

const TAXONOMY_PAGE = [queryParameter(), limitParameter(100), offsetParameter(MAX_TAXONOMY_OFFSET), localeParameter()];

const TAXONOMY_ARTICLES_PAGE = [articleViewParameter(), limitParameter(20), offsetParameter(MAX_TAXONOMY_OFFSET), localeParameter()];

/* -------------------------------------------------------------------------- */
/* Operations                                                                  */
/* -------------------------------------------------------------------------- */

const ok: ResponseSpec = { description: "The action succeeded." };

export const OPERATIONS: Readonly<Record<string, OperationMetadata>> = Object.freeze({
  /* ----- health and contract ------------------------------------------- */

  "GET health": {
    summary: "Liveness probe",
    description: "Answers without touching persistence, so it stays a liveness check rather than a database health check.",
    security: "none",
    tags: ["health"],
    response: { description: "The service is up.", data: "Health" },
  },

  "GET openapi": {
    summary: "This document",
    description: "The OpenAPI 3.1 contract for `/api/v1`, generated from the same route table the dispatcher uses. Regenerated into `docs/api/openapi.json` by `pnpm openapi:write`; `pnpm openapi:check` fails when the checked-in copy has drifted.",
    security: "none",
    tags: ["health"],
    response: { description: "The OpenAPI document for this API.", contentType: "application/json" },
  },

  /* ----- identity ------------------------------------------------------ */

  "POST auth": {
    summary: "Register, sign in, refresh, sign out, or spend a mailed token",
    description:
      "One path, seven actions, chosen by the `action` path parameter. Bodies are action-specific: `register` and `login` take `{email, password}`; `refresh` and `logout` take `{refreshToken}`; `forgot-password` takes `{email}`; `reset-password` takes `{token, password}`; `verify-email` takes `{token}`. `register` answers `201`, a recovery request answers `202` whether or not the address has an account (an account-enumeration oracle is not an error message), and `forgot-password` / `verify-email` answer `409 MAIL_DISABLED` while mail is switched off.",
    security: "none",
    tags: ["identity"],
    requestBody: { schema: "CredentialsRequest", description: "Action-specific body; see the description.", required: true },
    errors: [409],
    response: { status: 201, description: "A new session (`register`) or a rotated one.", data: "AuthSession" },
  },

  "GET me": {
    summary: "The signed-in account",
    security: "session",
    tags: ["identity"],
    response: { description: "The authenticated identity.", data: "CurrentUser" },
  },

  "GET me.profile": {
    summary: "Read the signed-in author's profile",
    security: "session",
    tags: ["identity"],
    query: [localeParameter()],
    errors: [404],
    response: { description: "The caller's own profile.", data: "AuthorProfile" },
  },

  "PUT me.profile": {
    summary: "Create or update the signed-in author's profile",
    description: "Answers with the stored profile read back in `zh-CN`, the only locale this write accepts.",
    security: "session",
    tags: ["identity"],
    requestBody: { schema: "ProfileWrite", description: "The complete profile. Unknown fields are rejected.", required: true },
    response: { description: "The stored profile.", data: "AuthorProfile" },
  },

  "DELETE me.session": {
    summary: "Sign out this session",
    description: "Ends the credential that was presented and leaves the account's other devices signed in.",
    security: "session",
    tags: ["identity"],
    response: { description: "True once the session is revoked.", scalar: "boolean" },
  },

  "GET me.sessions": {
    summary: "List this account's signed-in devices",
    security: "session",
    tags: ["identity"],
    response: { description: "The account's live sessions, marked with the one that asked.", data: "SessionList" },
  },

  "DELETE me.sessions": {
    summary: "Sign out every other device",
    description: "The lost-phone answer that does not require changing the password: every session except the one making the request is revoked.",
    security: "session",
    tags: ["identity"],
    response: { description: "How many sessions were ended.", data: "SessionRevocationReceipt" },
  },

  "DELETE me.sessions.item": {
    summary: "Sign out one device by id",
    description: "A session that is not one of this account's live ones answers `404` — the same answer as \"belongs to somebody else\", so the endpoint cannot be used to discover which ids exist.",
    security: "session",
    tags: ["identity"],
    pathParams: { sessionId: "The `sessionId` returned by `GET /me/sessions`." },
    errors: [404],
    response: { description: "The session was ended.", data: "SessionRevocationReceipt" },
  },

  "PUT me.password": {
    summary: "Change the password",
    description:
      "The current password proves the session belongs to the owner, so a stolen session alone can neither take the account over nor lock the owner out. Every other session is revoked and the one asking is spared.",
    security: "session",
    tags: ["identity"],
    requestBody: { schema: "PasswordChange", description: "The current password and the new one.", required: true },
    errors: [400],
    response: { description: "The password changed and the other sessions were signed out.", data: "SessionRevocationReceipt" },
  },

  "PUT me.email": {
    summary: "Move the account to another address",
    description:
      "The current password travels with it, because whoever controls the address controls recovery. The new address starts unverified; nothing is gated on verification and no mail is sent, so this works where mail is switched off. Asking for the address already on file is not a change and rewrites nothing.",
    security: "session",
    tags: ["identity"],
    requestBody: { schema: "EmailChange", description: "The current password and the new address.", required: true },
    errors: [409],
    response: { description: "The stored address and its verification state.", data: "EmailChangeReceipt" },
  },

  "POST me.email-verification": {
    summary: "Send (or re-send) the verification link for the signed-in address",
    security: "session",
    tags: ["identity"],
    errors: [409],
    response: { status: 202, description: "The request was accepted; an already verified address is not mailed again.", data: "EmailVerificationReceipt" },
  },

  "PUT users.role": {
    summary: "Assign a role to another account",
    description: "Editor only. Nobody may edit their own role: a single-editor instance whose editor demotes itself has no way back in.",
    security: "session",
    tags: ["identity"],
    query: [localeParameter()],
    requestBody: { schema: "RoleWrite", description: `The role to assign: ${USER_ROLES.join(" or ")}.`, required: true },
    errors: [403, 404],
    response: { description: "The target account's profile after the change.", data: "AuthorProfile" },
  },

  "GET users": {
    summary: "Search members",
    security: "optional-session",
    tags: ["identity"],
    query: [queryParameter(), localeParameter(), limitParameter(20)],
    response: { description: "Matching profiles, with follow state when a token was presented.", data: "AuthorProfile", array: true },
  },

  "GET users.relationships": {
    summary: "List an account's followers or the accounts it follows",
    security: "optional-session",
    tags: ["identity"],
    pathParams: { userId: "The account's stable user id.", relation: "`followers` or `following`." },
    query: [localeParameter(), limitParameter(50)],
    response: { description: "Complete profiles in the requested relation.", data: "AuthorProfile", array: true },
  },

  "POST users.follow": {
    summary: "Follow an account",
    security: "session",
    tags: ["identity"],
    pathParams: { userId: "The account to follow." },
    query: [localeParameter()],
    errors: [404],
    response: { description: "The followed account's profile as the viewer now sees it.", data: "AuthorProfile" },
  },

  "DELETE users.follow": {
    summary: "Unfollow an account",
    security: "session",
    tags: ["identity"],
    pathParams: { userId: "The account to unfollow." },
    query: [localeParameter()],
    errors: [404],
    response: { description: "The account's profile as the viewer now sees it.", data: "AuthorProfile" },
  },

  /* ----- articles and comments ----------------------------------------- */

  "GET articles": {
    summary: "Search and page the published corpus",
    description:
      "Accepts **either** `offset` **or** `cursor`, never both: they are two answers to \"where does this page start\". Sending both, an undecodable cursor, or a cursor with `sort=popular` is `400 BAD_INPUT`.",
    security: "optional-session",
    tags: ["articles"],
    query: ARTICLE_PAGE,
    response: { description: "Published works, newest or most-saved first.", data: "ArticleListEntry", array: true },
  },

  "POST articles": {
    summary: "Publish or draft a work",
    description:
      "The author is the token subject; a client-supplied author id is not read. An optional `Idempotency-Key` makes a retry with the same request return the work the first attempt stored instead of a second copy under a uniquified slug.",
    security: "session",
    tags: ["articles"],
    idempotency: "optional",
    requestBody: { schema: "ArticleWrite", description: "Exactly one of `contentBlocks` or `editorState`.", required: true },
    errors: [409],
    response: { status: 201, description: "The stored work.", data: "Article" },
  },

  "GET articles.item": {
    summary: "Read one published work by slug",
    description: "The path slot carries the slug on `GET` and the article id on `PUT` / `DELETE`.",
    security: "optional-session",
    tags: ["articles"],
    pathParams: { article: "The work's slug (`[a-z0-9]+(-[a-z0-9]+)*`)." },
    query: [localeParameter()],
    errors: [404],
    response: { description: "The work, in the requested edition.", data: "Article" },
  },

  "PUT articles.item": {
    summary: "Update a work or save one of its translations",
    description:
      "Saving with a different explicit `locale` inserts or replaces that translation; it does not rename or delete the original. Slug, work type, publication status and deletion belong to the whole work.",
    security: "session",
    tags: ["articles"],
    pathParams: { article: "The work's id." },
    query: [localeParameter("Edition to write. Defaults to `zh-CN`; a client editing another edition must send its locale.")],
    requestBody: { schema: "ArticleWrite", description: "The complete write: `slug` and `publish` are mandatory, `title` and exactly one content field are required.", required: true },
    errors: [403, 404],
    response: { description: "The stored work.", data: "Article" },
  },

  "DELETE articles.item": {
    summary: "Withdraw a work",
    description:
      "A soft delete: the row becomes a tombstone that leaves every list it was in. Deleting one edition withdraws all of them; restoring any tombstone restores the whole work as a draft.",
    security: "session",
    tags: ["articles"],
    pathParams: { article: "The work's id." },
    errors: [403, 404],
    response: { description: "The tombstone's id and deletion timestamp.", data: "ArticleDeletionReceipt" },
  },

  "POST articles.restore": {
    summary: "Restore a withdrawn work from the recycle bin",
    security: "session",
    tags: ["articles"],
    pathParams: { id: "The withdrawn work's id." },
    query: [localeParameter("Edition to read back after the restore.")],
    errors: [403, 404],
    response: { description: "The restored work, as a draft.", data: "Article" },
  },

  "GET articles.like": {
    summary: "Read a work's like count",
    security: "optional-session",
    tags: ["articles"],
    pathParams: { slug: "The work's slug." },
    query: [localeParameter()],
    errors: [404],
    response: { description: "The count and the viewer's own state.", data: "ArticleLikeState" },
  },

  "POST articles.views": {
    summary: "Record that a reader opened a published work",
    description:
      "A beacon the page sends after it has actually rendered the work — never part of the cached `GET`. Counting is `(work, reader, UTC day)`: one account or one address contributes at most one view per work per day, the author's own reads never count, and a repeat answers `200 {counted: false}` rather than an error. Public: an anonymous reader is counted, keyed by a digest of their address, and no address or account id is stored. A slug that is not a published work answers `404`.",
    security: "optional-session",
    tags: ["articles"],
    pathParams: { slug: "The work's slug." },
    query: [localeParameter()],
    errors: [404],
    response: { status: 200, description: "Whether this read counted, and the total afterwards.", data: "ArticleView" },
  },

  "POST imports.notion": {
    summary: "Import a Notion database bundle into your own works",
    description:
      "The bundle is a Notion export of one database: its pages, their properties and their blocks. Each work becomes an article owned by the caller; a work's other language versions become article translations of the same article.\n\n" +
      "**A dry run is the default.** Without `apply: true` nothing is written — no works, no tags, no provenance rows — and `pages` describes exactly what a real run would do. Send `apply: true` with the preview response’s `planToken` and the exact same bundle to perform those writes. The authenticated plan binds actor, source links, create-key recovery, work revision and database generation for 15 minutes. Missing, altered, expired or mismatched plans return `409 IMPORT_PLAN_INVALID`.\n\n" +
      "**Re-importing is idempotent.** The server records which page each edition came from, together with a digest of the content it produced, so importing the same bundle twice reports `skip` and writes nothing; changed pages update the work they already belong to and keep the address it already has. A page that disappeared from Notion is reported, never deleted here, and a work the author deleted is refused rather than recreated.\n\n" +
      "Pages that cannot become a work (`empty-body`, `empty-title`, and the other `issues` codes) are reported per page instead of failing the request: an import of forty pages does not fail because one of them is empty. Each work’s article, editions, tags, provenance and migration-journal changes commit atomically after a locked version comparison. A changed work is `refused` with a request to preview again; unrelated works may succeed. A failed work rolls back. Media preparation precedes the transaction: a late conflict may leave unused images visible/removable in the media library. Preview again after an interrupted request; provenance and create keys prevent duplicate works.",
    security: "session",
    tags: ["imports"],
    requestBody: { schema: "NotionImportRequest", description: "The bundle, and whether to apply it.", required: true },
    errors: [409, 413, 415],
    response: { status: 200, description: "The per-page report (and, with `apply: true`, what was written).", data: "NotionImportReport" },
  },

  "POST imports.notion.fetch": {
    summary: "Pull your own Notion database with a pasted Notion token, one bounded slice at a time",
    description:
      "A read of the caller's Notion, not a write here. The token is used for this request only and is never stored, logged or returned (ADR 0052); Notion's own error text is never forwarded either.\n\n" +
      "`mode: \"rows\"` resolves `source` (a database link or id, or a data source id) and lists rows with their properties, up to 1000 per request; a non-null `cursor` in the answer continues the listing. `mode: \"pages\"` reads the bodies of at most 200 named pages, in order, until the request's time (about 45 s to start a page, 75 s hard) or byte budget (6 MiB) runs out; `done` lists every id the slice finished, carried or reported in `issues` (`too-many-blocks` over 2000 blocks, `page-too-large`, `fetch-timeout`, `page-unavailable`, `fetch-failed`) — a page is never truncated. Send the remaining ids for the next slice; nothing about the continuation is kept on the server. When Notion's rate limit ends a slice early, `retryAfterSeconds` says how long to wait.\n\n" +
      "The result is the raw material of a bundle for `POST imports.notion`, whose dry run and explicit apply are unchanged. Errors: `NOTION_TOKEN_INVALID` / `NOTION_NOT_SHARED` (422), `NOTION_RATE_LIMITED` (429 with Retry-After), `NOTION_UNAVAILABLE` (502), `NOTION_FETCH_DISABLED` (409) when `NOTION_FETCH_ENABLED=false`, `NOTION_FETCH_BUSY` (503 with Retry-After) when too many pulls are in flight on this instance (8 in total, 2 per author).",
    security: "session",
    tags: ["imports"],
    requestBody: { schema: "NotionFetchRequest", description: "The token, the mode and its continuation.", required: true },
    errors: [409, 413, 415, 422, 429, 502, 503],
    response: { status: 200, description: "Rows (with a cursor) or page bodies (with `done` and `issues`).", data: "NotionFetchResult" },
  },

  "GET imports.notion.oauth": {
    summary: "Whether one-shot Notion OAuth is configured on this instance",
    description: "Answers a boolean only (ADR 0053). Off unless all three `NOTION_OAUTH_*` variables are set, the redirect URI is an https URL whose path is `/write/notion/oauth/callback`, and pulling is enabled.",
    security: "session",
    tags: ["imports"],
    response: { status: 200, description: "Whether to offer 「用 Notion 授权」.", data: "NotionOAuthStatus" },
  },

  "POST imports.notion.oauth.start": {
    summary: "Start a one-shot Notion authorization",
    description: "Returns Notion's authorize URL and a `state` signed for this session and valid once for 10 minutes (ADR 0053). Nothing is stored. `NOTION_OAUTH_DISABLED` (409) when OAuth is not configured. Rate limited to 10 per author and 20 per IP per 10 minutes.",
    security: "session",
    tags: ["imports"],
    errors: [409, 429],
    response: { status: 200, description: "Where to send the author, and the state that comes back.", data: "NotionOAuthStart" },
  },

  "POST imports.notion.oauth.exchange": {
    summary: "Redeem a Notion authorization code for a one-time access token",
    description:
      "Checks that `state` was issued to this session, has not expired and has not been used, spends it, and redeems `code` at Notion's token endpoint with the client credentials (ADR 0053). Only the access token and the workspace name are returned; the refresh token is discarded and nothing is stored or logged. " +
      "Errors: `NOTION_OAUTH_DISABLED` (409), `NOTION_OAUTH_STATE_INVALID` / `NOTION_OAUTH_CODE_INVALID` (422), `NOTION_OAUTH_MISCONFIGURED` (502, Notion refused the client credentials), `NOTION_UNAVAILABLE` (502). Rate limited to 10 per author and 20 per IP per 10 minutes.",
    security: "session",
    tags: ["imports"],
    requestBody: { schema: "NotionOAuthExchangeRequest", description: "The code and state from the callback URL.", required: true },
    errors: [409, 413, 415, 422, 429, 502],
    response: { status: 200, description: "The access token, once.", data: "NotionOAuthGrant" },
  },

  "POST imports.notion.jobs": {
    summary: "Queue one approved Notion import without holding the HTTP connection",
    description: "Opt-in; disabled by default (409 IMPORT_JOBS_DISABLED). Requires the unchanged bundle and its authentic, unexpired preview plan. The separate finite drain command performs the existing importer; the API never executes or schedules queued import work. Idempotency is owner-scoped while the plan is valid; after expiry use list/status, never blindly submit a new key. Signed URLs and plan are encrypted with a separately provisioned key. The original 8 MiB/200-page/eight-image bounds and per-work revision/ownership checks remain. Capacity refusal is 429 IMPORT_QUEUE_FULL. A running job whose lease expires becomes interrupted, never automatically retried. This is not live sync or image checkpoint resume.",
    security: "session", tags: ["imports"], idempotency: "notion-job",
    requestBody: { schema: "NotionJobRequest", required: true, description: "Only bundle and planToken; no actor, credentials or lease." },
    errors: [409, 413, 415, 429, 503],
    response: { status: 202, description: "The durable status; Location names the owner-scoped resource. Retry-After: 2 while active.", data: "NotionJobStatus" },
  },
  "GET imports.notion.jobs": {
    summary: "List your own retained Notion import jobs",
    description: "Newest first, at most 20. Contains only bounded status facts and sanitized report ordinals, not source page ids, titles, content, error details, signed URLs or leases. Still available when admission is disabled. Status expires 24 hours after the input deadline. To recover a lost submission response after preview expiry or admission shutdown, supply the original Idempotency-Key header instead of a query: the array then contains only that owner/key match (zero or one). A key selector cannot be mixed with limit.",
    security: "session", tags: ["imports"], query: [limitParameter(20, 20)], idempotency: "notion-job-lookup",
    response: { description: "Your jobs only.", data: "NotionJobStatus", array: true },
  },
  "GET imports.notion.jobs.item": {
    summary: "Read one of your Notion import jobs",
    description: "A missing job and another owner's job are indistinguishable 404s. No query parameters. Retry-After: 2 while active. completed is the last acknowledged report checkpoint, NOT proof that later works were not committed if the process crashed. Preview again and inspect your works/media after interruption. A strong ETag enables conditional reads: matching If-None-Match returns bodyless 304. Prefer: wait=0..5 optionally waits for change (only if the ETag matches); maximum five seconds, no SSE or scheduler. All responses stay no-store. At most 16 owner/job wait groups, four subscribers per group and two physical status reads are admitted; abandoned reads retain their slot until physical completion. A stuck/full status path returns 503 with Retry-After and must not trigger import replay.",
    security: "session", tags: ["imports"], pathParams: { jobId: "The server-issued UUID of your job." }, errors: [404, 503], notModified: true,
    headers: [
      { name: "If-None-Match", description: "One strong ETag from your previous status response. No wildcard, weak ETag or list.", schema: { type: "string", pattern: '^"[A-Za-z0-9_-]{43}"$' } },
      { name: "Prefer", description: "Optional bounded conditional wait. Status remains owner-scoped and private.", schema: { type: "string", pattern: "^wait=[0-5]$" } },
    ],
    response: { description: "Sanitized durable progress.", data: "NotionJobStatus" },
  },
  "DELETE imports.notion.jobs.item": {
    summary: "Cancel a queued or running Notion import job",
    description: "Idempotent. Deletes encrypted input and fences subsequent work transactions; waits for an already admitted transaction to settle. Does not undo earlier works or silently delete prepared media. Terminal jobs keep their state. Status remains readable when admission is disabled.",
    security: "session", tags: ["imports"], pathParams: { jobId: "The server-issued UUID of your job." }, errors: [404, 429],
    response: { description: "The resulting status, with explicit recovery instructions.", data: "NotionJobStatus" },
  },

  "GET imports.notion.export": {
    summary: "Export your own works as a Notion database bundle",
    description:
      "The inverse of `POST imports.notion`, and it produces a bundle that endpoint accepts: an export can be handed to Notion, or imported back as a copy. Nothing is written — exporting twice returns the same bundle.\n\n" +
      "**`slugs` is a comma-separated list** of your own works (at most 50 per request). A slug that is not one of your live works is listed in `report.missing` rather than failing the request, so a stale desk list still exports everything else.\n\n" +
      "**A work is one address and up to three editions.** The primary page is the edition in the site's own preference (`zh-CN`, `zh-TW`, `en`); the `en` edition travels as a second page linked by the `English` relation, exactly as the author's own database pairs them. A `zh-TW` edition of a `zh-CN` work is reported (`translation-locale-not-carried`) instead of being written into the wrong language.\n\n" +
      "**Page ids are provenance.** An edition that was imported from Notion carries the page id it came from, so pushing the bundle back updates that page instead of creating a duplicate. A work written here has no Notion page, and carries a stable `site:<articleId>:<locale>` id — repeat exports are byte-identical, and the client decides what to do with a page Notion has never seen.\n\n" +
      "**What Notion cannot hold is reported, not dropped.** A work type that its own tags do not imply would import back as a different type (`work-type-not-carried`); an image whose URL expires is reported per page. Properties Notion has no column for — categories, hierarchy, reading order — are not carried and are not invented.",
    security: "session",
    tags: ["imports"],
    query: [
      {
        name: "slugs",
        description: "Comma-separated work addresses, at most 50. Duplicates are ignored.",
        required: true,
        schema: { type: "string" },
      },
    ],
    response: {
      description: "The bundle, and what it could not say (missing works, provenance, losses).",
      data: "NotionExport",
    },
  },

  "PUT articles.like": {
    summary: "Set an explicit like state",
    description: "State-setting rather than a toggle: a retried request cannot flip the value back.",
    security: "session",
    tags: ["articles"],
    pathParams: { slug: "The work's slug." },
    query: [localeParameter()],
    requestBody: { schema: "LikeWrite", description: "`liked: true` or `liked: false`.", required: true },
    errors: [404],
    response: { description: "The count after the write.", data: "ArticleLikeState" },
  },

  "GET articles.comments": {
    summary: "Read the comment tree of a published work",
    description:
      "`limit` counts **top-level** comments, not replies: each top-level comment arrives with its whole reply tree, so a page boundary never cuts a conversation in half. The order is oldest first, by `(createdAt, id)`. To read further down a long thread, send `cursor` built from the **last top-level comment** of the page already received: `base64url(\"<createdAt>|<id>\")`, using the `createdAt` exactly as returned. Each page is a plain array with no `nextCursor`; keep requesting while a page is non-empty and stop at the first empty one. A reply posted mid-read is newer than the cursor, so it never shifts the roots the reader has not reached yet: it appears under its own root, or not at all on this pass.",
    security: "optional-session",
    tags: ["comments"],
    pathParams: { slug: "The work's slug." },
    query: [
      localeParameter(),
      limitParameter(50),
      {
        name: "cursor",
        description:
          "`base64url(\"<createdAt>|<id>\")` of the last top-level comment already received. An empty page is the end of the thread.",
        schema: { type: "string" },
      },
    ],
    errors: [400],
    response: {
      description: "A page of top-level comments, each with its replies.",
      data: "Comment",
      array: true,
    },
  },

  "POST articles.comments": {
    summary: "Comment on, or reply to a comment on, a published work",
    description:
      "Only a SHA-256 digest of the `Idempotency-Key` is stored, not the header. A replay with the same normalized request returns the same comment and does not send a second notification. A reply that would sit deeper than a thread is shown answers `400 COMMENT_DEPTH_EXCEEDED` — reply higher up the thread instead; every comment that was accepted is returned by the read (ADR 0032).",
    security: "session",
    tags: ["comments"],
    pathParams: { slug: "The work's slug." },
    query: [localeParameter()],
    idempotency: "optional",
    requestBody: { schema: "CommentWrite", description: "Exactly one of `content` or `contentBlocks` / `editorState`.", required: true },
    errors: [404, 409],
    response: { status: 201, description: "The stored comment.", data: "Comment" },
  },

  "PATCH comments.item": {
    summary: "Correct your own comment",
    description:
      "Only the author may edit; somebody else's comment answers `403 FORBIDDEN` and a comment that does not exist answers `404 NOT_FOUND`, the same pair the delete answers. The edit replaces the text, stamps `editedAt` and leaves `createdAt`, the parent link and the idempotency record alone, so the thread keeps its order. No notification is emitted: re-notifying on every edit would let an author page the whole thread at will. Previous text is not retained — there is no revision history in v1 (ADR 0031).",
    security: "session",
    tags: ["comments"],
    pathParams: { id: "The comment's id." },
    query: [localeParameter("Edition to answer in. Defaults to `zh-CN`.")],
    requestBody: { schema: "CommentUpdate", description: "Exactly one of `content` or `contentBlocks` / `editorState`.", required: true },
    errors: [403, 404],
    response: { description: "The corrected comment, with `editedAt` set.", data: "Comment" },
  },

  "DELETE comments.item": {
    summary: "Delete your own comment",
    security: "session",
    tags: ["comments"],
    pathParams: { id: "The comment's id." },
    errors: [403, 404],
    response: { description: "Whether the comment was deleted.", data: "DeletionReceipt" },
  },

  "GET articles.related": {
    summary: "Related published work",
    security: "optional-session",
    tags: ["articles"],
    pathParams: { slug: "The work's slug." },
    query: [articleViewParameter(), localeParameter(), limitParameter(6, 50)],
    errors: [404],
    response: { description: "Related published works.", data: "ArticleListEntry", array: true },
  },

  "GET me.article-catalogue": {
    summary: "Search and page the signed-in author's complete lightweight catalogue",
    description: "Closed query vocabulary; repeated or unknown fields are rejected. Case-sensitive literal title/summary search. Updated sort uses work deletion time for trash and the selected translation row update time for active work; created sort uses that translation row creation time, oldest first. UTC day boundaries are inclusive. The cursor is actor/filter-bound, not authorization. Concurrent edits may move rows; restart to refresh.",
    security: "session", tags: ["articles"],
    query: [
      { name: "scope", description: "Active work or recycle bin.", schema: { type: "string", enum: ["active", "trash"], default: "active" } },
      { name: "q", description: "Literal, case-sensitive title/summary substring.", schema: { type: "string", maxLength: 120 } },
      { name: "locale", description: "One language or all editions.", schema: { type: "string", enum: ["all", ...LOCALES], default: "all" } },
      { name: "status", description: "Publication state.", schema: { type: "string", enum: ["all", "draft", "published"], default: "all" } },
      { name: "workType", description: "小说 / 诗歌 / 其他文体; all by default.", schema: { type: "string", enum: ["all", ...supportedArticleWorkTypes], default: "all" } },
      { name: "sort", description: "Recent activity or oldest creation, with id and locale tie breakers.", schema: { type: "string", enum: ["updated", "created"], default: "updated" } },
      { name: "from", description: "First UTC activity/creation day, YYYY-MM-DD.", schema: { type: "string", format: "date" } },
      { name: "until", description: "Last UTC activity/creation day, YYYY-MM-DD.", schema: { type: "string", format: "date" } },
      limitParameter(20, 50),
      { name: "cursor", description: "Opaque seek witness; do not reuse after changing account or filters.", schema: { type: "string", maxLength: 1024 } },
    ],
    response: { description: "A metadata page, matching counts and pre-filter facets.", data: "ArticleCataloguePage" },
  },
  "GET me.article-catalogue-editions": {
    summary: "All existing lightweight language editions of one owned work",
    description: "At most three entries, independent of catalogue search filters. Publication/type are work-wide; title/summary and timestamps belong to each edition. Another account, wrong active/trash scope, or missing work answers the same 404.",
    security: "session", tags: ["articles"], pathParams: { id: "Own article UUID." }, errors: [404],
    query: [{ name: "scope", description: "Active or deleted work.", schema: { type: "string", enum: ["active", "trash"], default: "active" } }],
    response: { description: "Complete metadata-only language coverage for this work.", data: "ArticleCatalogueEntry", array: true },
  },
  "GET me.article-catalogue-item": {
    summary: "Open one explicitly requested own editable language edition",
    description: "Other authors' IDs, missing editions, tombstones and nonexistent IDs all answer 404. No implicit language fallback.",
    security: "session", tags: ["articles"], pathParams: { id: "Own article UUID." },
    query: [{ ...localeParameter(), required: true }], errors: [404],
    response: { description: "The requested own work, including its body and revision for editing.", data: "Article" },
  },

  "GET me.articles": {
    summary: "The signed-in author's own work, drafts included",
    description:
      "No query selects `zh-CN`; `?locale=` selects exactly that edition; `?allLocales=true` returns all three with `meta.locales`. The three reads are not a cross-locale snapshot: concurrent edits can race a refresh.",
    security: "session",
    tags: ["articles"],
    query: [localeParameter(), allLocalesParameter(), limitParameter(50)],
    response: { description: "The caller's own editions, newest first.", data: "Article", array: true, meta: true },
  },

  "GET me.deleted-articles": {
    summary: "The signed-in author's recycle bin",
    security: "session",
    tags: ["articles"],
    query: [localeParameter(), allLocalesParameter(), limitParameter(50)],
    response: { description: "Tombstones the caller may still restore.", data: "DeletedArticle", array: true, meta: true },
  },

  "GET me.liked-articles": {
    summary: "What the signed-in reader has liked",
    security: "session",
    tags: ["articles"],
    query: [localeParameter(), limitParameter(50)],
    response: { description: "Liked published works.", data: "Article", array: true },
  },

  "GET me.feed": {
    summary: "The following feed",
    description: "Published work by the accounts the actor follows, newest first across all of them. Following nobody returns an empty list, not the public feed.",
    security: "session",
    tags: ["articles"],
    query: [localeParameter(), limitParameter(20), offsetParameter(MAX_ARTICLE_OFFSET)],
    response: { description: "Published work from followed authors.", data: "Article", array: true },
  },

  "GET featured": {
    summary: "The editorial shelf",
    security: "optional-session",
    tags: ["articles"],
    query: [articleViewParameter(), localeParameter(), limitParameter(20, MAX_FEATURED_ARTICLES), offsetParameter(MAX_ARTICLE_OFFSET)],
    response: { description: "The shelf in editorial order.", data: "ArticleListEntry", array: true },
  },

  "PUT featured": {
    summary: "Arrange the editorial shelf",
    description: "Editor only, and the whole ordered list arrives in one write: two editors cannot interleave into a shelf neither asked for.",
    security: "session",
    tags: ["articles"],
    query: [localeParameter()],
    requestBody: { schema: "FeaturedWrite", description: "The complete ordered shelf.", required: true },
    errors: [403],
    response: { description: "The shelf as stored.", data: "Article", array: true },
  },

  /* ----- taxonomy ------------------------------------------------------ */

  "GET tags": {
    summary: "Discover hashtags",
    security: "none",
    tags: ["taxonomy"],
    query: TAXONOMY_PAGE,
    response: { description: "Tags matching the query.", data: "Taxonomy", array: true },
  },

  "POST tags": {
    summary: "Create or reuse a hashtag",
    description: "The actor is the token subject; a normalized tag that already exists is returned rather than duplicated.",
    security: "session",
    tags: ["taxonomy"],
    requestBody: { schema: "TagCreate", description: "The tag name in `zh-CN`.", required: true },
    errors: [409],
    response: { status: 201, description: "The stored tag.", data: "Taxonomy" },
  },

  "GET tags.item": {
    summary: "One tag",
    security: "none",
    tags: ["taxonomy"],
    pathParams: { slug: "The tag's slug." },
    query: [localeParameter()],
    errors: [404],
    response: { description: "The tag.", data: "Taxonomy" },
  },

  "GET tags.articles": {
    summary: "Published work carrying a hashtag",
    security: "optional-session",
    tags: ["taxonomy"],
    pathParams: { slug: "The tag's slug." },
    query: TAXONOMY_ARTICLES_PAGE,
    errors: [404],
    response: { description: "Published works with this tag.", data: "ArticleListEntry", array: true },
  },

  "GET categories": {
    summary: "Discover categories",
    security: "none",
    tags: ["taxonomy"],
    query: TAXONOMY_PAGE,
    response: { description: "Categories matching the query.", data: "Taxonomy", array: true },
  },

  "GET categories.item": {
    summary: "One category",
    security: "none",
    tags: ["taxonomy"],
    pathParams: { slug: "The category's slug." },
    query: [localeParameter()],
    errors: [404],
    response: { description: "The category.", data: "Taxonomy" },
  },

  "GET categories.articles": {
    summary: "Published work in a category",
    security: "optional-session",
    tags: ["taxonomy"],
    pathParams: { slug: "The category's slug." },
    query: TAXONOMY_ARTICLES_PAGE,
    errors: [404],
    response: { description: "Published works in this category.", data: "ArticleListEntry", array: true },
  },

  "POST taxonomies": {
    summary: "Create a category or a tag",
    description:
      "Categories are editorial (ADR 0016): only an editor may create, translate or delete one, and any editor may do so to a category somebody else created, because the public taxonomy is maintained as a group. A tag is the author's own words.",
    security: "session",
    tags: ["taxonomy"],
    requestBody: { schema: "TaxonomyCreate", description: "`kind` chooses a category or a tag.", required: true },
    errors: [403, 409],
    response: { status: 201, description: "The stored taxonomy row.", data: "Taxonomy" },
  },

  "DELETE taxonomies.item": {
    summary: "Delete a category or tag",
    security: "session",
    tags: ["taxonomy"],
    pathParams: { id: "The taxonomy row's id." },
    errors: [403, 404],
    response: { description: "Whether the row was deleted.", data: "DeletionReceipt" },
  },

  /* ----- authors and media --------------------------------------------- */

  "GET authors": {
    summary: "The public author directory",
    description: "A reader-facing list of people with published work, not a member list.",
    security: "none",
    tags: ["authors"],
    query: [localeParameter(), queryParameter(), limitParameter(20), offsetParameter(AUTHOR_OFFSET_MAX)],
    response: { description: "Authors with reach and published-work counts.", data: "AuthorDirectoryEntry", array: true },
  },

  "GET authors.item": {
    summary: "One public author profile",
    security: "optional-session",
    tags: ["authors"],
    pathParams: { userId: "The author's stable user id." },
    query: [localeParameter()],
    errors: [404],
    response: { description: "The author's profile.", data: "AuthorProfile" },
  },

  "GET authors.articles": {
    summary: "Published work by one author",
    security: "optional-session",
    tags: ["authors"],
    pathParams: { userId: "The author's stable user id." },
    query: ARTICLE_PAGE,
    response: { description: "That author's published work.", data: "ArticleListEntry", array: true },
  },

  "GET media.item": {
    summary: "Read an uploaded image",
    description:
      "Answered as the immutable bytes with a one-year immutable cache policy. `/api/media/<id>` is an alias of this path: the request is rewritten to `/api/v1/media/<id>` before route resolution, so both addresses share one handler and one `405` allow-list.",
    security: "none",
    tags: ["media"],
    pathParams: { id: "The media asset's id." },
    errors: [404, 503],
    response: { description: "The stored image bytes.", contentType: "image/webp" },
  },

  "GET me.media": {
    summary: "The signed-in author's media library",
    security: "session",
    tags: ["media"],
    query: [
      { name: "limit", description: `Page size, 1–${MEDIA_LIMIT_BOUNDS.max}. Defaults to ${MEDIA_LIMIT_BOUNDS.default}.`, schema: { type: "integer", minimum: MEDIA_LIMIT_BOUNDS.min, maximum: MEDIA_LIMIT_BOUNDS.max, default: MEDIA_LIMIT_BOUNDS.default } },
      { name: "cursor", description: "Opaque cursor from the previous page's `nextCursor`.", schema: { type: "string" } },
    ],
    errors: [503],
    response: { description: "One page of the caller's uploads.", data: "MediaLibraryPage" },
  },

  "POST me.media": {
    summary: "Upload an image",
    description:
      "The body is the image bytes, not JSON, and the content type must be an accepted image type. Each upload is a new id and an asset is immutable: there is no replace endpoint. The response's `src` is the application-relative address a content body keeps.",
    security: "session",
    tags: ["media"],
    requestBody: { schema: "MediaAsset", description: "Placeholder schema name for the binary body; send `Content-Type: image/webp` with the image bytes.", contentType: "image/webp" },
    errors: [400, 503],
    response: { status: 201, description: "The stored asset.", data: "MediaAsset" },
  },

  "DELETE me.media.item": {
    summary: "Delete an unused image",
    description:
      "Refused while a work, a profile or another body still references the asset; the refusal names the works that use it. Answers `409 MEDIA_DELETE_DISABLED` when this instance has image deletion switched off — that is a decision, not an outage, and retrying will not help.",
    security: "session",
    tags: ["media"],
    pathParams: { id: "The media asset's id." },
    errors: [404, 409, 503],
    response: { description: "The deleted asset's id.", data: "MediaDeletionReceipt" },
  },

  /* ----- notifications -------------------------------------------------- */

  "GET me.notifications": {
    summary: "The notification inbox",
    description:
      "Newest first, ordered by `(createdAt, id)`. To read older notices, send `cursor` built from the **last** notification of the page already received: `base64url(\"<createdAt>|<id>\")`, using the `createdAt` exactly as returned. Each page is a plain array with no `nextCursor`; keep requesting while a page is non-empty and stop at the first empty one. A notification that arrives while the reader is paging is newer than the cursor and therefore does not shift the older pages; marking notices read does not change their position. The recipient comes from the token — there is no parameter that selects someone else's inbox.",
    security: "session",
    tags: ["notifications"],
    query: [
      limitParameter(50),
      { name: "cursor", description: "`base64url(\"<createdAt>|<id>\")` of the last notification already received. An empty page is the end of the inbox.", schema: { type: "string" } },
    ],
    response: { description: "One page of the caller's notifications, newest first.", data: "Notification", array: true },
  },

  "GET me.notifications.unread-count": {
    summary: "Unread notifications",
    security: "session",
    tags: ["notifications"],
    response: { description: "The number of unread notifications.", scalar: "number" },
  },

  "PUT me.notifications.read": {
    summary: "Mark one notification read",
    security: "session",
    tags: ["notifications"],
    pathParams: { id: "The notification's id." },
    errors: [404],
    response: { description: "The notification after the update.", data: "Notification" },
  },

  "POST me.notifications.read-all": {
    summary: "Mark every notification read",
    security: "session",
    tags: ["notifications"],
    response: { description: "How many rows changed.", scalar: "number" },
  },

  /* ----- conversations -------------------------------------------------- */

  "GET conversations": {
    summary: "The caller's conversations",
    security: "session",
    tags: ["conversations"],
    query: [limitParameter(50)],
    response: { description: "Participant-scoped conversations with last activity and unread counts.", data: "Conversation", array: true },
  },

  "POST conversations": {
    summary: "Start a conversation",
    description: "The `Idempotency-Key` header is required: a retry reopens the conversation the first attempt created instead of leaving a second one that quietly stops being answered.",
    security: "session",
    tags: ["conversations"],
    idempotency: "required",
    requestBody: { schema: "ConversationCreate", description: "The other participants; the actor is added from the token.", required: true },
    errors: [409],
    response: { status: 201, description: "The conversation.", data: "Conversation" },
  },

  "GET conversations.item": {
    summary: "One conversation as one of its members sees it",
    description: "A conversation the caller is not an active member of answers `404`, because membership is the only way to learn that it exists.",
    security: "session",
    tags: ["conversations"],
    pathParams: { id: "The conversation's id." },
    errors: [404],
    response: { description: "The conversation, its participants and its last message.", data: "Conversation" },
  },

  "DELETE conversations.item": {
    summary: "Delete a conversation",
    security: "session",
    tags: ["conversations"],
    pathParams: { id: "The conversation's id." },
    errors: [403, 404],
    response: { description: "Whether the conversation was deleted.", data: "DeletionReceipt" },
  },

  "GET conversations.messages": {
    summary: "Read a conversation's message history",
    description: "Preserves the latest-window, oldest-first ordering; a cursor from another conversation is rejected rather than trusted.",
    security: "session",
    tags: ["conversations"],
    pathParams: { id: "The conversation's id." },
    query: [limitParameter(100), beforeParameter()],
    errors: [400, 404],
    response: { description: "One window of messages, oldest first.", data: "Message", array: true },
  },

  "POST conversations.messages": {
    summary: "Send a message",
    description: "The `Idempotency-Key` header is required. The message and its notification outbox intent commit together, so a notification cannot be lost or invented by a crash between them.",
    security: "session",
    tags: ["conversations"],
    pathParams: { id: "The conversation's id." },
    idempotency: "required",
    requestBody: { schema: "MessageWrite", description: "The message body.", required: true },
    errors: [409, 404],
    response: { status: 201, description: "The stored message (`duplicate: true` for a replay).", data: "Message" },
  },

  "PATCH conversations.participants": {
    summary: "Add or remove participants",
    security: "session",
    tags: ["conversations"],
    pathParams: { id: "The conversation's id." },
    requestBody: { schema: "ConversationParticipantsWrite", description: "`addUserIds` and `removeUserIds`; either may be omitted.", required: true },
    errors: [403, 404],
    response: { description: "The complete conversation after the change.", data: "Conversation" },
  },

  "PUT conversations.read": {
    summary: "Mark a conversation read for the caller",
    security: "session",
    tags: ["conversations"],
    pathParams: { id: "The conversation's id." },
    errors: [404],
    response: { description: "True once the caller's read state is stored.", scalar: "boolean" },
  },
});

/* -------------------------------------------------------------------------- */
/* Error responses                                                             */
/* -------------------------------------------------------------------------- */

/** Descriptions of the statuses that can appear on any operation. */
export const ERROR_DESCRIPTIONS: Readonly<Record<number, string>> = Object.freeze({
  400: "Bad request: `BAD_USER_INPUT` for a query or body the contract does not allow, `BAD_INPUT` for discovery paging misuse.",
  401: "No valid, unrevoked bearer token was presented (`UNAUTHENTICATED`).",
  403: "The caller is authenticated but not allowed to do this (`FORBIDDEN`); categories and the featured shelf are editorial.",
  404: "The addressed row does not exist, or is not visible to this caller (`NOT_FOUND`).",
  409: "Conflict: `ARTICLE_VERSION_CONFLICT`, `IMPORT_PLAN_INVALID`, `IDEMPOTENCY_CONFLICT`, `MAIL_DISABLED`, `MEDIA_DELETE_DISABLED`, or a duplicate unique value.",
  413: "The request body is larger than this route accepts (`PAYLOAD_TOO_LARGE`).",
  415: "The request body is not `application/json` (`UNSUPPORTED_MEDIA_TYPE`).",
  422: "A third party refused the request on the caller's behalf (`NOTION_TOKEN_INVALID`, `NOTION_NOT_SHARED`).",
  429: "Rate or import queue capacity limit reached (`RATE_LIMITED`, `IMPORT_QUEUE_FULL`); observe Retry-After.",
  502: "A third-party API this route reads could not be read (`NOTION_UNAVAILABLE`).",
  503: "A dependency this route needs is unavailable (`SERVICE_UNAVAILABLE`, `MEDIA_STORAGE_UNAVAILABLE`).",
});

/** The key used by `OPERATIONS` and by the generator's coverage check. */
export function operationKey(method: string, routeId: string): string {
  return `${method} ${routeId}`;
}

/**
 * Fail fast when the route table and this table disagree.
 *
 * Both directions matter: a route with no metadata would be missing from the
 * published contract, and a metadata row naming no route would describe an
 * endpoint that no longer exists.
 */
export function assertOperationsMatchRoutes(
  routes: readonly { readonly id: string; readonly methods: readonly string[] }[],
): void {
  const expected = new Set<string>();
  for (const route of routes) {
    for (const method of route.methods) expected.add(operationKey(method, route.id));
  }
  const documented = new Set(Object.keys(OPERATIONS));

  const missing = [...expected].filter((key) => !documented.has(key)).sort();
  const extra = [...documented].filter((key) => !expected.has(key)).sort();
  if (missing.length === 0 && extra.length === 0) return;

  const problems: string[] = [];
  if (missing.length > 0) problems.push(`undocumented: ${missing.join(", ")}`);
  if (extra.length > 0) problems.push(`documented but not routed: ${extra.join(", ")}`);
  throw new Error(`OpenAPI operations do not match the REST route table — ${problems.join("; ")}`);
}
