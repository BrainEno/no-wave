export class AuthorizationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AuthorizationError";
    this.code = code;
  }
}

function isValidIdentifier(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

/**
 * Resolve identity exclusively from server-verified authentication context.
 * Request-body sender IDs must never be passed as the source of identity.
 */
export function requireAuthenticatedActor(context) {
  const id = context?.user?.id;
  if (!isValidIdentifier(id)) {
    throw new AuthorizationError("UNAUTHENTICATED", "Authentication is required.");
  }
  return id;
}

export function assertResourceOwner(actorId, ownerId) {
  if (!isValidIdentifier(actorId)) {
    throw new AuthorizationError("UNAUTHENTICATED", "Authentication is required.");
  }
  if (!isValidIdentifier(ownerId) || actorId !== ownerId) {
    throw new AuthorizationError("FORBIDDEN", "You cannot modify this resource.");
  }
}

export function assertConversationParticipant(actorId, participantIds) {
  if (!isValidIdentifier(actorId)) {
    throw new AuthorizationError("UNAUTHENTICATED", "Authentication is required.");
  }
  if (!Array.isArray(participantIds) ||
      !participantIds.every(isValidIdentifier) ||
      !participantIds.includes(actorId)) {
    throw new AuthorizationError("FORBIDDEN", "You are not a participant in this conversation.");
  }
}

/** The authenticated actor is the sender; a client-provided sender ID is never authoritative. */
export function resolveMessageSender(context) {
  return requireAuthenticatedActor(context);
}
