export class AuthorizationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AuthorizationError";
    this.code = code;
  }
}

function isValidIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

/**
 * Resolve identity exclusively from server-verified authentication context.
 * Request-body sender IDs must never be passed as the source of identity.
 */
export function requireAuthenticatedActor(context: { user?: { id?: unknown } | null } | null | undefined): string {
  const id = context?.user?.id;
  if (!isValidIdentifier(id)) {
    throw new AuthorizationError("UNAUTHENTICATED", "Authentication is required.");
  }
  return id;
}

export function assertResourceOwner(actorId: unknown, ownerId: unknown): void {
  if (!isValidIdentifier(actorId)) {
    throw new AuthorizationError("UNAUTHENTICATED", "Authentication is required.");
  }
  if (!isValidIdentifier(ownerId) || actorId !== ownerId) {
    throw new AuthorizationError("FORBIDDEN", "You cannot modify this resource.");
  }
}

export function assertConversationParticipant(actorId: unknown, participantIds: unknown): void {
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
export function resolveMessageSender(context: { user?: { id?: unknown } | null } | null | undefined): string {
  return requireAuthenticatedActor(context);
}
