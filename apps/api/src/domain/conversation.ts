import { ConversationInputError } from "./errors.ts";

export function normalizeParticipantIds(name: string, ids: unknown, max = 20): string[] {
  if (!Array.isArray(ids) || ids.length > max) {
    throw new ConversationInputError(`${name} must be an array containing at most ${max} user IDs.`);
  }
  const normalized = ids.map((id: unknown, index: number) => {
    if (typeof id !== "string" || id.trim().length === 0 || id !== id.trim() || id.length > 300) {
      throw new ConversationInputError(`${name}[${index}] must be a non-empty, trimmed user ID.`);
    }
    return id;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new ConversationInputError(`${name} cannot contain duplicate user IDs.`);
  }
  return normalized;
}
