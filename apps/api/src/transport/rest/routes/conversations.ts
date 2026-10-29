import type { RestRouteContext, RestRouteHandler } from "./context.ts";
import { authenticatedActorId, decodeUserId, parseInteger, readJsonObject, sendBadInput, sendJson, sendJsonBodyError, sendServiceError, sendUnauthenticated, sendUnavailable } from "../http.ts";
import { normalizeConversationCreateBody, normalizeConversationParticipantsBody, normalizeMessageWriteBody } from "../bodies.ts";

/** Direct-message conversations and their messages. */
const CONVERSATION_ROUTE_HANDLERS: Readonly<Record<string, RestRouteHandler>> = Object.freeze({
  "conversations": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, url, services, env } = ctx;
    if (!services) { sendUnavailable(response); return; }
    if (request.method === "POST") {
      const bodyResult = await readJsonObject(request);
      if (bodyResult.ok === false) { sendJsonBodyError(response, request, bodyResult); return; }
      const normalized = normalizeConversationCreateBody(bodyResult.value);
      if (!normalized.participantIds) { sendBadInput(response, normalized.error ?? "Invalid conversation input."); return; }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) { sendUnauthenticated(response); return; }
        const conversation = await services.createConversation({ actorId, participantIds: normalized.participantIds });
        sendJson(response, 201, { data: conversation });
      } catch (error: unknown) { sendServiceError(response, error); }
      return;
    }
    const limit = parseInteger(url.searchParams, "limit", 50, 1, 100);
    if (limit === null) { sendBadInput(response, "Invalid limit query parameter."); return; }
    try {
      const actorId = await authenticatedActorId(request, services, env);
      if (!actorId) { sendUnauthenticated(response); return; }
      const conversations = await services.listConversations({ actorId, limit });
      sendJson(response, 200, { data: conversations });
    } catch (error: unknown) { sendServiceError(response, error); }
  },
  "conversations.messages": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, url, services, env, routeParams } = ctx;
    if (!services) { sendUnavailable(response); return; }
    const conversationId = decodeUserId(routeParams.id);
    if (!conversationId) { sendBadInput(response, "Invalid conversation ID."); return; }
    if (request.method === "GET") {
      const limit = parseInteger(url.searchParams, "limit", 100, 1, 100);
      const beforeRaw = url.searchParams.get("before");
      const before = beforeRaw === null ? null : decodeUserId(beforeRaw);
      if (limit === null || (beforeRaw !== null && !before)) {
        sendBadInput(response, "Invalid limit or before cursor query parameter.");
        return;
      }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) { sendUnauthenticated(response); return; }
        const messages = await services.listConversationMessages({ conversationId, actorId, limit, before });
        sendJson(response, 200, { data: messages });
      } catch (error: unknown) { sendServiceError(response, error); }
      return;
    }
    const bodyResult = await readJsonObject(request);
    if (bodyResult.ok === false) { sendJsonBodyError(response, request, bodyResult); return; }
    const normalized = normalizeMessageWriteBody(bodyResult.value);
    if (normalized.body === null) { sendBadInput(response, normalized.error ?? "Invalid message input."); return; }
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0 ||
        idempotencyKey.length > 300 || idempotencyKey.trim() !== idempotencyKey) {
      sendBadInput(response, "A valid Idempotency-Key header is required.");
      return;
    }
    try {
      const senderId = await authenticatedActorId(request, services, env);
      if (!senderId) { sendUnauthenticated(response); return; }
      const message = await services.persistMessage({ conversationId, senderId, body: normalized.body, idempotencyKey });
      sendJson(response, 201, { data: message });
    } catch (error: unknown) { sendServiceError(response, error); }
  },
  "conversations.participants": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, services, env, routeParams } = ctx;
    if (!services) { sendUnavailable(response); return; }
    const conversationId = decodeUserId(routeParams.id);
    if (!conversationId) { sendBadInput(response, "Invalid conversation ID."); return; }
    const bodyResult = await readJsonObject(request);
    if (bodyResult.ok === false) { sendJsonBodyError(response, request, bodyResult); return; }
    const normalized = normalizeConversationParticipantsBody(bodyResult.value);
    if (!normalized.input) { sendBadInput(response, normalized.error ?? "Invalid participant update input."); return; }
    try {
      const actorId = await authenticatedActorId(request, services, env);
      if (!actorId) { sendUnauthenticated(response); return; }
      await services.updateConversationParticipants({ conversationId, actorId, ...normalized.input });
      const updated = await services.getConversation({ conversationId, actorId });
      if (!updated) sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The conversation was not found." } });
      else sendJson(response, 200, { data: updated });
    } catch (error: unknown) { sendServiceError(response, error); }
  },
  "conversations.read": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, services, env, routeParams } = ctx;
    if (!services) { sendUnavailable(response); return; }
    const conversationId = decodeUserId(routeParams.id);
    if (!conversationId) { sendBadInput(response, "Invalid conversation ID."); return; }
    try {
      const actorId = await authenticatedActorId(request, services, env);
      if (!actorId) { sendUnauthenticated(response); return; }
      const result = await services.markConversationAsRead({ conversationId, actorId });
      sendJson(response, 200, { data: result });
    } catch (error: unknown) { sendServiceError(response, error); }
  },
  "conversations.item": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, services, env, routeParams } = ctx;
    if (!services) { sendUnavailable(response); return; }
    const conversationId = decodeUserId(routeParams.id);
    if (!conversationId) { sendBadInput(response, "Invalid conversation ID."); return; }
    try {
      const actorId = await authenticatedActorId(request, services, env);
      if (!actorId) { sendUnauthenticated(response); return; }
      const deleted = await services.deleteConversation({ conversationId, actorId });
      sendJson(response, 200, { data: deleted });
    } catch (error: unknown) { sendServiceError(response, error); }
  },
});

export const CONVERSATION_ROUTE_IDS: readonly string[] = Object.freeze(Object.keys(CONVERSATION_ROUTE_HANDLERS));

export async function handleConversationRoutes(ctx: RestRouteContext): Promise<boolean> {
  const handler = CONVERSATION_ROUTE_HANDLERS[ctx.routeId ?? ""];
  if (!handler) return false;
  await handler(ctx);
  return true;
}
