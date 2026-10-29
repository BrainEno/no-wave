import type { RestRouteContext } from "./context.ts";
import { authenticatedActorId, decodeUserId, parseInteger, readJsonObject, sendBadInput, sendJson, sendJsonBodyError, sendServiceError, sendUnauthenticated, sendUnavailable } from "../http.ts";
import { normalizeConversationCreateBody, normalizeConversationParticipantsBody, normalizeMessageWriteBody } from "../bodies.ts";

/** Direct-message conversations and their messages. */
export async function handleConversationRoutes(ctx: RestRouteContext): Promise<boolean> {
  const { request, response, url, services, env, routeParams, routeId } = ctx;

    if (routeId === "conversations") {
      if (!services) { sendUnavailable(response); return true; }
      if (request.method === "POST") {
        const bodyResult = await readJsonObject(request);
        if (bodyResult.ok === false) { sendJsonBodyError(response, request, bodyResult); return true; }
        const normalized = normalizeConversationCreateBody(bodyResult.value);
        if (!normalized.participantIds) { sendBadInput(response, normalized.error ?? "Invalid conversation input."); return true; }
        try {
          const actorId = await authenticatedActorId(request, services, env);
          if (!actorId) { sendUnauthenticated(response); return true; }
          const conversation = await services.createConversation({ actorId, participantIds: normalized.participantIds });
          sendJson(response, 201, { data: conversation });
        } catch (error: unknown) { sendServiceError(response, error); }
        return true;
      }
      const limit = parseInteger(url.searchParams, "limit", 50, 1, 100);
      if (limit === null) { sendBadInput(response, "Invalid limit query parameter."); return true; }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) { sendUnauthenticated(response); return true; }
        const conversations = await services.listConversations({ actorId, limit });
        sendJson(response, 200, { data: conversations });
      } catch (error: unknown) { sendServiceError(response, error); }
      return true;
    }

    if (routeId === "conversations.messages") {
      if (!services) { sendUnavailable(response); return true; }
      const conversationId = decodeUserId(routeParams.id);
      if (!conversationId) { sendBadInput(response, "Invalid conversation ID."); return true; }
      if (request.method === "GET") {
        const limit = parseInteger(url.searchParams, "limit", 100, 1, 100);
        const beforeRaw = url.searchParams.get("before");
        const before = beforeRaw === null ? null : decodeUserId(beforeRaw);
        if (limit === null || (beforeRaw !== null && !before)) {
          sendBadInput(response, "Invalid limit or before cursor query parameter.");
          return true;
        }
        try {
          const actorId = await authenticatedActorId(request, services, env);
          if (!actorId) { sendUnauthenticated(response); return true; }
          const messages = await services.listConversationMessages({ conversationId, actorId, limit, before });
          sendJson(response, 200, { data: messages });
        } catch (error: unknown) { sendServiceError(response, error); }
        return true;
      }
      const bodyResult = await readJsonObject(request);
      if (bodyResult.ok === false) { sendJsonBodyError(response, request, bodyResult); return true; }
      const normalized = normalizeMessageWriteBody(bodyResult.value);
      if (normalized.body === null) { sendBadInput(response, normalized.error ?? "Invalid message input."); return true; }
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0 ||
          idempotencyKey.length > 300 || idempotencyKey.trim() !== idempotencyKey) {
        sendBadInput(response, "A valid Idempotency-Key header is required.");
        return true;
      }
      try {
        const senderId = await authenticatedActorId(request, services, env);
        if (!senderId) { sendUnauthenticated(response); return true; }
        const message = await services.persistMessage({ conversationId, senderId, body: normalized.body, idempotencyKey });
        sendJson(response, 201, { data: message });
      } catch (error: unknown) { sendServiceError(response, error); }
      return true;
    }

    if (routeId === "conversations.participants") {
      if (!services) { sendUnavailable(response); return true; }
      const conversationId = decodeUserId(routeParams.id);
      if (!conversationId) { sendBadInput(response, "Invalid conversation ID."); return true; }
      const bodyResult = await readJsonObject(request);
      if (bodyResult.ok === false) { sendJsonBodyError(response, request, bodyResult); return true; }
      const normalized = normalizeConversationParticipantsBody(bodyResult.value);
      if (!normalized.input) { sendBadInput(response, normalized.error ?? "Invalid participant update input."); return true; }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) { sendUnauthenticated(response); return true; }
        await services.updateConversationParticipants({ conversationId, actorId, ...normalized.input });
        const updated = await services.getConversation({ conversationId, actorId });
        if (!updated) sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The conversation was not found." } });
        else sendJson(response, 200, { data: updated });
      } catch (error: unknown) { sendServiceError(response, error); }
      return true;
    }

    if (routeId === "conversations.read") {
      if (!services) { sendUnavailable(response); return true; }
      const conversationId = decodeUserId(routeParams.id);
      if (!conversationId) { sendBadInput(response, "Invalid conversation ID."); return true; }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) { sendUnauthenticated(response); return true; }
        const result = await services.markConversationAsRead({ conversationId, actorId });
        sendJson(response, 200, { data: result });
      } catch (error: unknown) { sendServiceError(response, error); }
      return true;
    }

    if (routeId === "conversations.item") {
      if (!services) { sendUnavailable(response); return true; }
      const conversationId = decodeUserId(routeParams.id);
      if (!conversationId) { sendBadInput(response, "Invalid conversation ID."); return true; }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) { sendUnauthenticated(response); return true; }
        const deleted = await services.deleteConversation({ conversationId, actorId });
        sendJson(response, 200, { data: deleted });
      } catch (error: unknown) { sendServiceError(response, error); }
      return true;
    }

  return false;
}
