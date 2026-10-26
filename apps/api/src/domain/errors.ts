export class DomainError extends Error {
  constructor(name, code, message) {
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

