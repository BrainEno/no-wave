export class DomainError extends Error {
  readonly code: string;

  constructor(name: string, code: string, message: string) {
    super(message);
    this.name = name;
    this.code = code;
  }
}

export class IdempotencyConflictError extends DomainError {
  constructor(message = "The idempotency key was already used for a different request.") {
    super("IdempotencyConflictError", "IDEMPOTENCY_CONFLICT", message);
  }
}

export class IdentityInputError extends DomainError {
  constructor() { super("IdentityInputError", "BAD_USER_INPUT", "The identity request is invalid."); }
}
/**
 * One address cannot belong to two accounts: registering an address somebody
 * already holds, or moving an account onto an address somebody else holds.
 *
 * The code is `EMAIL_TAKEN` and not the generic `CONFLICT` on purpose. Both
 * reach the client as a 409, but only the specific code lets a client say what
 * happened — "that address is already registered" is actionable, "the request
 * conflicts with the current resource state" is not. Registration already
 * reveals whether an address has an account by refusing it, so naming the
 * reason leaks nothing that the status code did not leak already.
 */
export class IdentityConflictError extends DomainError {
  constructor() { super("IdentityConflictError", "EMAIL_TAKEN", "The email address is already registered."); }
}
export class IdentityAuthenticationError extends DomainError {
  constructor() { super("IdentityAuthenticationError", "UNAUTHENTICATED", "The credentials are invalid."); }
}
export class RateLimitError extends DomainError {
  readonly retryAfterSeconds: number;
  constructor(name: string, message: string, retryAfterSeconds: number) {
    super(name, "RATE_LIMITED", message);
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  }
}
export class IdentityRateLimitError extends RateLimitError {
  constructor(retryAfterSeconds: number) {
    super("IdentityRateLimitError", "Too many authentication attempts.", retryAfterSeconds);
  }
}
export class WriteRateLimitError extends RateLimitError {
  constructor(retryAfterSeconds: number) {
    super("WriteRateLimitError", "Too many requests. Try again later.", retryAfterSeconds);
  }
}
/**
 * A session that is not one of the account's live devices.
 *
 * Deliberately the same answer for "never existed", "already ended" and
 * "belongs to somebody else": telling them apart would let a caller use the
 * endpoint to find out which session ids exist.
 */
export class IdentitySessionNotFoundError extends DomainError {
  constructor() { super("IdentitySessionNotFoundError", "NOT_FOUND", "The session was not found."); }
}
export class IdentityUnavailableError extends DomainError {
  constructor() { super("IdentityUnavailableError", "SERVICE_UNAVAILABLE", "Identity is not configured."); }
}

/**
 * A feature that would deliver mail was asked for while mail is switched off.
 *
 * Not the same as "the relay is broken": this instance has deliberately not
 * enabled account mail at all, so there is nothing to retry and nothing to wait
 * for. It answers 409 — not 503, which would promise that trying again later
 * helps — so a client can say "this site cannot do that" instead of "your
 * request succeeded", which is what a swallowed failure would look like.
 */
export class MailDisabledError extends DomainError {
  constructor() { super("MailDisabledError", "MAIL_DISABLED", "Account mail is not enabled on this instance."); }
}

/**
 * Media deletion is switched off on this deployment (#156).
 *
 * The delete route scans every work's body to decide whether an image is still
 * referenced, and on PostgreSQL that scan and the delete are not serialised
 * against a concurrent save — so an image can be deleted in the window between
 * a work referencing it and that save committing. Until the reference table
 * (#163) makes that race impossible, the operation is off unless an operator
 * deliberately turns it on.
 *
 * It answers 409 like `MAIL_DISABLED`, and for the same reason: this is not an
 * outage, so a 503 would promise that retrying later helps. A client can say
 * "this site cannot do that yet" instead of retrying forever.
 */
export class MediaDeleteDisabledError extends DomainError {
  constructor() { super("MediaDeleteDisabledError", "MEDIA_DELETE_DISABLED", "Deleting images is not enabled on this instance."); }
}

export class ConversationAccessError extends DomainError {
  constructor(message = "The sender is not a participant in this conversation.") {
    super("ConversationAccessError", "FORBIDDEN", message);
  }
}
export class ConversationInputError extends DomainError {
  constructor(message = "The conversation input is invalid.") {
    super("ConversationInputError", "BAD_USER_INPUT", message);
  }
}
export class ConversationNotFoundError extends DomainError {
  constructor(message = "The conversation was not found.") {
    super("ConversationNotFoundError", "NOT_FOUND", message);
  }
}
export class InvalidMessageCursorError extends DomainError {
  constructor(message = "The message cursor does not belong to this conversation.") {
    super("InvalidMessageCursorError", "BAD_USER_INPUT", message);
  }
}
export class ArticleInputError extends DomainError {
  constructor(message = "The article input is invalid.") {
    super("ArticleInputError", "BAD_USER_INPUT", message);
  }
}
/** A conditional write must never replace a version the caller did not read. */
export class ArticleVersionConflictError extends DomainError {
  constructor() { super("ArticleVersionConflictError", "ARTICLE_VERSION_CONFLICT", "The work changed. Reload it before saving again."); }
}
export class ImportPlanInvalidError extends DomainError {
  constructor() { super("ImportPlanInvalidError", "IMPORT_PLAN_INVALID", "The import preview is missing, invalid or expired. Preview again before applying."); }
}
export class ImportConflictError extends DomainError {
  readonly reason: "stale" | "ownership" | "provenance";
  constructor(reason: "stale" | "ownership" | "provenance" = "stale") {
    const detail = reason === "ownership" ? "This Notion page is already owned by another account." :
      reason === "provenance" ? "The Notion page is already linked to another work or account." :
      "The work or its import provenance changed.";
    super("ImportConflictError", "IMPORT_CONFLICT", `${detail} Nothing in this work was written; preview again.`);
    this.reason = reason;
  }
}
export class ArticleSlugConflictError extends DomainError {
  constructor(message = "An article with this slug already exists.") {
    super("ArticleSlugConflictError", "CONFLICT", message);
  }
}
export class ArticleAuthorizationError extends DomainError {
  constructor(message = "You cannot edit this article.") {
    super("ArticleAuthorizationError", "FORBIDDEN", message);
  }
}
export class ArticleNotFoundError extends DomainError {
  constructor(message = "The article was not found.") {
    super("ArticleNotFoundError", "NOT_FOUND", message);
  }
}
export class ProfileInputError extends DomainError {
  constructor(message = "The profile input is invalid.") {
    super("ProfileInputError", "BAD_USER_INPUT", message);
  }
}
/**
 * ADR 0016: the caller is authenticated but is not allowed to curate. Maps to 403
 * through the shared FORBIDDEN response, like every other authorization refusal.
 */
export class ProfileAuthorizationError extends DomainError {
  constructor(message = "Only an editor can change account roles.") {
    super("ProfileAuthorizationError", "FORBIDDEN", message);
  }
}
export class ProfileNotFoundError extends DomainError {
  constructor(message = "The user profile was not found.") {
    super("ProfileNotFoundError", "NOT_FOUND", message);
  }
}
export class TaxonomyConflictError extends DomainError {
  constructor(message = "The taxonomy slug is already in use.") {
    super("TaxonomyConflictError", "CONFLICT", message);
  }
}
export class TaxonomyNotFoundError extends DomainError {
  constructor(message = "The taxonomy was not found.") {
    super("TaxonomyNotFoundError", "NOT_FOUND", message);
  }
}

