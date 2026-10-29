import type { IncomingMessage, ServerResponse } from "node:http";
import { createIdentityService } from "../../application/identity.ts";
import { createRateLimitService, resolveWriteRateLimitPolicy, type RateLimitBucket, type RateLimitStore } from "../../application/rate-limit.ts";
import type { IdentityStore } from "../../application/identity.ts";
import {
  sendJson,
  sendBadInput,
  parseInteger,
  hasDuplicateQueryParameters,
  parseLocale,
  parseQuery,
  parsePagination,
  decodeSlug,
  decodeUserId,
  sendServiceError,
  sendUnavailable,
  readJsonObject,
  normalizeArticleWriteBody,
  normalizeProfileWriteBody,
  normalizeLikeWriteBody,
  normalizeCommentWriteBody,
  normalizeCreateTagBody,
  normalizeCreateTaxonomyBody,
  normalizeConversationCreateBody,
  normalizeConversationParticipantsBody,
  normalizeMessageWriteBody,
  serializeRestNotification,
  authenticatedUser,
  authenticatedActorId,
  optionalViewerId,
  sendUnauthenticated,
  sendJsonBodyError,
  serializeRestArticle,
  serializeRestArticles,
  serializeRestComment,
  serializeRestComments,
  MAX_QUERY_LENGTH,
  MAX_ARTICLE_OFFSET,
  MAX_TAXONOMY_OFFSET,
  type RestServices
} from "./rest-helpers.ts";
import { matchRestPaths } from "./rest-route-match.ts";

/**
 * REST transport adapter. It calls application services directly; it never
 * makes an HTTP round-trip to GraphQL or reaches into persistence adapters.
 */
export function createRestHandler({ services, env = process.env }: { services: RestServices | null; env?: NodeJS.ProcessEnv }) {
  // The facade is assembled dynamically from the validated persistence ports.
  const identity = services ? createIdentityService({ store: services as unknown as IdentityStore, env }) : null;
  const rateLimitStore: RateLimitStore | null = services && typeof services.consumeRateLimit === "function"
    ? {
        consumeRateLimit: (input: RateLimitBucket) => services.consumeRateLimit!(input),
        pruneExpiredIdentityState: typeof services.pruneExpiredIdentityState === "function"
          ? () => services.pruneExpiredIdentityState!()
          : undefined,
      }
    : null;
  const writeRateLimiter = rateLimitStore ? createRateLimitService({ store: rateLimitStore, env }) : null;
  return async function handleRest(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/v1" && !url.pathname.startsWith("/api/v1/")) return false;
    const {
      identityRoute,
      mePath,
      meProfilePath,
      meSessionPath,
      meLikedArticlesPath,
      usersSearchPath,
      userRelationshipsMatch,
      followPathMatch,
      articleLikePathMatch,
      relatedArticlesMatch,
      articleCommentsPathMatch,
      commentItemPathMatch,
      tagsCollectionPath,
      taxonomyCollectionPath,
      taxonomyItemMatch,
      conversationsPath,
      conversationMessagesMatch,
      conversationParticipantsMatch,
      conversationReadMatch,
      conversationItemMatch,
      notificationsPath,
      unreadNotificationCountPath,
      notificationReadMatch,
      readAllNotificationsPath,
      articleItemPath,
      authorArticlesMatch,
      authorMatch,
      articleMatch,
      categoryArticlesMatch,
      categoryMatch,
      tagArticlesMatch,
      tagMatch
    } = matchRestPaths(url.pathname);

    // Every current REST query parameter is scalar. Reject duplicates rather
    // than silently accepting URLSearchParams' first-value interpretation.
    // Close the connection because a rejected write request may still have an unread body.
    if (hasDuplicateQueryParameters(url.searchParams)) {
      request.pause();
      response.shouldKeepAlive = false;
      response.setHeader("connection", "close");
      sendBadInput(response, "Query parameters must not be repeated.");
      return true;
    }

    if (identityRoute) {
      if (request.method !== "POST") {
        response.setHeader("allow", "POST");
        sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "The HTTP method is not supported for this endpoint." } });
        return true;
      }
      if (!identity) { sendUnavailable(response); return true; }
      const bodyResult = await readJsonObject(request, 4096);
      if (bodyResult.ok === false) { sendJsonBodyError(response, request, bodyResult); return true; }
      try {
        // Never trust X-Forwarded-For supplied by the client. An operator must
        // enforce additional trusted-proxy/edge throttling when behind a proxy.
        const ip = request.socket.remoteAddress ?? "unknown";
        const action = identityRoute[1] as "register" | "login" | "refresh" | "logout";
        const data = await identity[action](bodyResult.value, ip);
        sendJson(response, action === "register" ? 201 : 200, { data });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    const isCreateArticle = request.method === "POST" && url.pathname === "/api/v1/articles";
    const isUpdateArticle = request.method === "PUT" && articleItemPath;
    const isUpdateMyProfile = request.method === "PUT" && meProfilePath;
    const isRevokeSession = request.method === "DELETE" && meSessionPath;
    const isFollowUser = request.method === "POST" && followPathMatch !== null;
    const isUnfollowUser = request.method === "DELETE" && followPathMatch !== null;
    const isSetArticleLike = request.method === "PUT" && articleLikePathMatch !== null;
    const isCreateArticleComment = request.method === "POST" && articleCommentsPathMatch !== null;
    const isDeleteArticleComment = request.method === "DELETE" && commentItemPathMatch !== null;
    const isCreateTag = request.method === "POST" && tagsCollectionPath;
    const isCreateTaxonomy = request.method === "POST" && taxonomyCollectionPath;
    const isDeleteTaxonomy = request.method === "DELETE" && taxonomyItemMatch !== null;
    const isCreateConversation = request.method === "POST" && conversationsPath;
    const isSendMessage = request.method === "POST" && conversationMessagesMatch !== null;
    const isUpdateConversationParticipants = request.method === "PATCH" && conversationParticipantsMatch !== null;
    const isDeleteConversation = request.method === "DELETE" && conversationItemMatch !== null;
    const isMarkConversationRead = request.method === "PUT" && conversationReadMatch !== null;
    const isMarkNotificationRead = request.method === "PUT" && notificationReadMatch !== null;
    const isMarkAllNotificationsRead = request.method === "POST" && readAllNotificationsPath;

    const rejectMethod = (allow: string) => {
      response.setHeader("allow", allow);
      sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "The HTTP method is not supported for this endpoint." } });
    };
    if (mePath && request.method !== "GET") {
      rejectMethod("GET");
      return true;
    }
    if (meProfilePath && request.method !== "GET" && request.method !== "PUT") {
      rejectMethod("GET, PUT");
      return true;
    }
    if (meSessionPath && request.method !== "DELETE") {
      rejectMethod("DELETE");
      return true;
    }
    if (meLikedArticlesPath && request.method !== "GET") {
      rejectMethod("GET");
      return true;
    }
    if (usersSearchPath && request.method !== "GET") {
      rejectMethod("GET");
      return true;
    }
    if (userRelationshipsMatch && request.method !== "GET") {
      rejectMethod("GET");
      return true;
    }
    if (followPathMatch && request.method !== "POST" && request.method !== "DELETE") {
      rejectMethod("POST, DELETE");
      return true;
    }
    if (articleLikePathMatch && request.method !== "GET" && request.method !== "PUT") {
      rejectMethod("GET, PUT");
      return true;
    }
    if (articleCommentsPathMatch && request.method !== "GET" && request.method !== "POST") {
      rejectMethod("GET, POST");
      return true;
    }
    if (relatedArticlesMatch && request.method !== "GET") {
      rejectMethod("GET");
      return true;
    }
    if (commentItemPathMatch && request.method !== "DELETE") {
      rejectMethod("DELETE");
      return true;
    }
    if (tagsCollectionPath && request.method !== "GET" && request.method !== "POST") {
      rejectMethod("GET, POST");
      return true;
    }
    if (taxonomyCollectionPath && request.method !== "POST") {
      rejectMethod("POST");
      return true;
    }
    if (taxonomyItemMatch && request.method !== "DELETE") {
      rejectMethod("DELETE");
      return true;
    }
    if (conversationsPath && request.method !== "GET" && request.method !== "POST") {
      rejectMethod("GET, POST");
      return true;
    }
    if (conversationMessagesMatch && request.method !== "GET" && request.method !== "POST") {
      rejectMethod("GET, POST");
      return true;
    }
    if (conversationParticipantsMatch && request.method !== "PATCH") {
      rejectMethod("PATCH");
      return true;
    }
    if (conversationReadMatch && request.method !== "PUT") {
      rejectMethod("PUT");
      return true;
    }
    if (conversationItemMatch && request.method !== "DELETE") {
      rejectMethod("DELETE");
      return true;
    }
    if (notificationsPath && request.method !== "GET") {
      rejectMethod("GET");
      return true;
    }
    if (unreadNotificationCountPath && request.method !== "GET") {
      rejectMethod("GET");
      return true;
    }
    if (notificationReadMatch && request.method !== "PUT") {
      rejectMethod("PUT");
      return true;
    }
    if (readAllNotificationsPath && request.method !== "POST") {
      rejectMethod("POST");
      return true;
    }
    if (request.method !== "GET" && !isCreateArticle && !isUpdateArticle && !isUpdateMyProfile && !isRevokeSession &&
        !isFollowUser && !isUnfollowUser && !isSetArticleLike && !isCreateArticleComment && !isDeleteArticleComment &&
        !isCreateTag && !isCreateTaxonomy && !isDeleteTaxonomy && !isCreateConversation && !isSendMessage &&
        !isUpdateConversationParticipants && !isDeleteConversation && !isMarkConversationRead &&
        !isMarkNotificationRead && !isMarkAllNotificationsRead) {
      response.setHeader("allow", url.pathname === "/api/v1/articles" ? "GET, POST" : articleItemPath ? "GET, PUT" : "GET");
      sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "The HTTP method is not supported for this endpoint." } });
      return true;
    }

    const writePolicy = resolveWriteRateLimitPolicy(request.method ?? "GET", url.pathname);
    if (writePolicy && writeRateLimiter && services) {
      try {
        const actorId = await optionalViewerId(request, services, env);
        // Use only the TCP peer address. X-Forwarded-For is untrusted unless a
        // separately configured trusted proxy has already enforced this policy.
        await writeRateLimiter.checkWrite({
          method: request.method ?? "GET",
          pathname: url.pathname,
          ip: request.socket.remoteAddress ?? "unknown",
          actorId,
        });
      } catch (error: unknown) {
        sendServiceError(response, error);
        return true;
      }
    }

    if (url.pathname === "/api/v1/health") {
      sendJson(response, 200, { status: "ok", service: "api", version: "0.1.0" });
      return true;
    }

    if (mePath) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) {
          sendUnauthenticated(response);
          return true;
        }
        sendJson(response, 200, { data: { id: actorId } });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    if (meProfilePath && request.method === "GET") {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const locale = parseLocale(url);
      if (!locale) {
        sendBadInput(response, "Invalid locale.");
        return true;
      }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) {
          sendUnauthenticated(response);
          return true;
        }
        const profile = await services.getAuthorProfile({ userId: actorId, locale, viewerId: actorId });
        if (!profile) {
          sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The author profile was not found." } });
        } else {
          sendJson(response, 200, { data: profile });
        }
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    if (meSessionPath) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      try {
        const user = await authenticatedUser(request, services, env);
        if (!user) {
          sendUnauthenticated(response);
          return true;
        }
        await services.revokeSession({
          sessionId: user.sessionId,
          expiresAt: new Date(user.sessionExpiresAt * 1000),
        });
        sendJson(response, 200, { data: true });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }


    if (tagsCollectionPath && request.method === "POST") {
      if (!services) { sendUnavailable(response); return true; }
      const bodyResult = await readJsonObject(request);
      if (bodyResult.ok === false) { sendJsonBodyError(response, request, bodyResult); return true; }
      const normalized = normalizeCreateTagBody(bodyResult.value);
      if (!normalized.input) { sendBadInput(response, normalized.error ?? "Invalid tag input."); return true; }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) { sendUnauthenticated(response); return true; }
        const tag = await services.createTag({ ...normalized.input, actorId });
        sendJson(response, 201, { data: tag });
      } catch (error: unknown) { sendServiceError(response, error); }
      return true;
    }

    if (taxonomyCollectionPath && request.method === "POST") {
      if (!services) { sendUnavailable(response); return true; }
      const bodyResult = await readJsonObject(request);
      if (bodyResult.ok === false) { sendJsonBodyError(response, request, bodyResult); return true; }
      const normalized = normalizeCreateTaxonomyBody(bodyResult.value);
      if (!normalized.input) { sendBadInput(response, normalized.error ?? "Invalid taxonomy input."); return true; }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) { sendUnauthenticated(response); return true; }
        const taxonomy = await services.createTaxonomy({ ...normalized.input, actorId });
        sendJson(response, 201, { data: taxonomy });
      } catch (error: unknown) { sendServiceError(response, error); }
      return true;
    }

    if (taxonomyItemMatch && request.method === "DELETE") {
      if (!services) { sendUnavailable(response); return true; }
      const taxonomyId = decodeUserId(taxonomyItemMatch[1]);
      if (!taxonomyId) { sendBadInput(response, "Invalid taxonomy ID."); return true; }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) { sendUnauthenticated(response); return true; }
        const deleted = await services.deleteTaxonomy({ taxonomyId, actorId });
        sendJson(response, 200, { data: deleted });
      } catch (error: unknown) { sendServiceError(response, error); }
      return true;
    }

    if (conversationsPath) {
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

    if (conversationMessagesMatch) {
      if (!services) { sendUnavailable(response); return true; }
      const conversationId = decodeUserId(conversationMessagesMatch[1]);
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

    if (conversationParticipantsMatch && request.method === "PATCH") {
      if (!services) { sendUnavailable(response); return true; }
      const conversationId = decodeUserId(conversationParticipantsMatch[1]);
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

    if (conversationReadMatch && request.method === "PUT") {
      if (!services) { sendUnavailable(response); return true; }
      const conversationId = decodeUserId(conversationReadMatch[1]);
      if (!conversationId) { sendBadInput(response, "Invalid conversation ID."); return true; }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) { sendUnauthenticated(response); return true; }
        const result = await services.markConversationAsRead({ conversationId, actorId });
        sendJson(response, 200, { data: result });
      } catch (error: unknown) { sendServiceError(response, error); }
      return true;
    }

    if (conversationItemMatch && request.method === "DELETE") {
      if (!services) { sendUnavailable(response); return true; }
      const conversationId = decodeUserId(conversationItemMatch[1]);
      if (!conversationId) { sendBadInput(response, "Invalid conversation ID."); return true; }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) { sendUnauthenticated(response); return true; }
        const deleted = await services.deleteConversation({ conversationId, actorId });
        sendJson(response, 200, { data: deleted });
      } catch (error: unknown) { sendServiceError(response, error); }
      return true;
    }

    if (notificationsPath) {
      if (!services) { sendUnavailable(response); return true; }
      const limit = parseInteger(url.searchParams, "limit", 50, 1, 100);
      if (limit === null) { sendBadInput(response, "Invalid limit query parameter."); return true; }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) { sendUnauthenticated(response); return true; }
        const notifications = await services.listNotifications({ actorId, limit });
        sendJson(response, 200, { data: Array.isArray(notifications) ? notifications.map(serializeRestNotification) : [] });
      } catch (error: unknown) { sendServiceError(response, error); }
      return true;
    }

    if (unreadNotificationCountPath) {
      if (!services) { sendUnavailable(response); return true; }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) { sendUnauthenticated(response); return true; }
        const count = await services.getUnreadNotificationCount({ actorId });
        sendJson(response, 200, { data: count });
      } catch (error: unknown) { sendServiceError(response, error); }
      return true;
    }

    if (notificationReadMatch && request.method === "PUT") {
      if (!services) { sendUnavailable(response); return true; }
      const notificationId = decodeUserId(notificationReadMatch[1]);
      if (!notificationId) { sendBadInput(response, "Invalid notification ID."); return true; }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) { sendUnauthenticated(response); return true; }
        const notification = await services.markNotificationRead({ notificationId, actorId });
        sendJson(response, 200, { data: serializeRestNotification(notification) });
      } catch (error: unknown) { sendServiceError(response, error); }
      return true;
    }

    if (readAllNotificationsPath && request.method === "POST") {
      if (!services) { sendUnavailable(response); return true; }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) { sendUnauthenticated(response); return true; }
        const count = await services.markAllNotificationsRead({ actorId });
        sendJson(response, 200, { data: count });
      } catch (error: unknown) { sendServiceError(response, error); }
      return true;
    }

    if (usersSearchPath) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const query = url.searchParams.get("query");
      const locale = parseLocale(url);
      const limit = parseInteger(url.searchParams, "limit", 20, 1, 100);
      if (query === null || query.length > MAX_QUERY_LENGTH || !locale || limit === null) {
        sendBadInput(response, "Invalid query, locale, or limit query parameter.");
        return true;
      }
      try {
        const viewerId = await optionalViewerId(request, services, env);
        const users = await services.searchUsers({ query, locale, limit, viewerId });
        sendJson(response, 200, { data: users });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    if (userRelationshipsMatch) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const userId = decodeUserId(userRelationshipsMatch[1]);
      const relation = userRelationshipsMatch[2];
      const locale = parseLocale(url);
      const limit = parseInteger(url.searchParams, "limit", 50, 1, 100);
      if (!userId || !locale || limit === null) {
        sendBadInput(response, "Invalid user ID, locale, or limit query parameter.");
        return true;
      }
      try {
        const viewerId = await optionalViewerId(request, services, env);
        const users = relation === "followers"
          ? await services.listFollowers({ userId, locale, limit, viewerId })
          : await services.listFollowing({ userId, locale, limit, viewerId });
        sendJson(response, 200, { data: users });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    if (meLikedArticlesPath) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const locale = parseLocale(url);
      const limit = parseInteger(url.searchParams, "limit", 50, 1, 100);
      if (!locale || limit === null) {
        sendBadInput(response, "Invalid locale or limit query parameter.");
        return true;
      }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) {
          sendUnauthenticated(response);
          return true;
        }
        const articles = await services.listLikedArticles({ actorId, locale, limit });
        sendJson(response, 200, { data: await serializeRestArticles(services, articles, actorId) });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    if (url.pathname === "/api/v1/me/articles") {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const locale = parseLocale(url);
      const limit = parseInteger(url.searchParams, "limit", 50, 1, 100);
      if (!locale || limit === null) {
        sendBadInput(response, "Invalid locale or limit query parameter.");
        return true;
      }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) {
          sendUnauthenticated(response);
          return true;
        }
        const articles = await services.listMyArticles({ actorId, locale, limit });
        sendJson(response, 200, { data: await serializeRestArticles(services, articles, actorId) });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    if (meProfilePath) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const bodyResult = await readJsonObject(request);
      if (bodyResult.ok === false) {
        sendJsonBodyError(response, request, bodyResult);
        return true;
      }
      const normalized = normalizeProfileWriteBody(bodyResult.value);
      if (!normalized.input) {
        sendBadInput(response, normalized.error ?? "Invalid profile input.");
        return true;
      }
      try {
        const userId = await authenticatedActorId(request, services, env);
        if (!userId) {
          sendUnauthenticated(response);
          return true;
        }
        await services.upsertAuthorProfile({ ...normalized.input, userId });
        const profile = await services.getAuthorProfile({ userId, locale: "zh-CN", viewerId: userId });
        if (!profile) {
          sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The author profile was not found." } });
        } else {
          sendJson(response, 200, { data: profile });
        }
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    if (followPathMatch) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const targetUserId = decodeUserId(followPathMatch[1]);
      const locale = parseLocale(url);
      if (!targetUserId || !locale) {
        sendBadInput(response, "Invalid target user ID or locale.");
        return true;
      }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) {
          sendUnauthenticated(response);
          return true;
        }
        if (request.method === "POST") {
          await services.followUser({ actorId, targetUserId });
        } else {
          await services.unfollowUser({ actorId, targetUserId });
        }
        const profile = await services.getAuthorProfile({ userId: targetUserId, locale, viewerId: actorId });
        if (!profile) {
          sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The author was not found." } });
        } else {
          sendJson(response, 200, { data: profile });
        }
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    if (authorArticlesMatch) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const userId = decodeUserId(authorArticlesMatch[1]);
      const locale = parseLocale(url);
      const query = parseQuery(url);
      const pagination = parsePagination(url, 20, MAX_ARTICLE_OFFSET);
      if (!userId || !locale || query === null || !pagination) {
        sendBadInput(response, "Invalid author user ID, locale, query, limit, or offset query parameter.");
        return true;
      }
      try {
        const viewerId = await optionalViewerId(request, services, env);
        const author = await services.getAuthorProfile({ userId, locale, viewerId });
        if (!author) {
          sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The author was not found." } });
          return true;
        }
        const articles = await services.listPublishedArticles({ authorId: userId, locale, query, ...pagination });
        sendJson(response, 200, { data: await serializeRestArticles(services, articles, viewerId) });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    if (authorMatch) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const userId = decodeUserId(authorMatch[1]);
      const locale = parseLocale(url);
      if (!userId || !locale) {
        sendBadInput(response, "Invalid author user ID or locale.");
        return true;
      }
      try {
        const viewerId = await optionalViewerId(request, services, env);
        const author = await services.getAuthorProfile({ userId, locale, viewerId });
        if (!author) {
          sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The author was not found." } });
        } else {
          sendJson(response, 200, { data: author });
        }
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    if (url.pathname === "/api/v1/articles") {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      if (request.method === "POST") {
        const bodyResult = await readJsonObject(request);
        if (bodyResult.ok === false) {
          sendJsonBodyError(response, request, bodyResult);
          return true;
        }
        const normalized = normalizeArticleWriteBody(bodyResult.value, false);
        if (!normalized.input) {
          sendBadInput(response, normalized.error ?? "Invalid article input.");
          return true;
        }
        try {
          const authorId = await authenticatedActorId(request, services, env);
          if (!authorId) {
            sendUnauthenticated(response);
            return true;
          }
          const article = await services.createArticle({ ...normalized.input, authorId });
          sendJson(response, 201, { data: await serializeRestArticle(services, article, authorId) });
        } catch (error: unknown) {
          sendServiceError(response, error);
        }
        return true;
      }
      const locale = parseLocale(url);
      const query = parseQuery(url);
      const pagination = parsePagination(url, 20, MAX_ARTICLE_OFFSET);
      if (!locale || query === null || !pagination) {
        sendBadInput(response, "Invalid locale, query, limit, or offset query parameter.");
        return true;
      }
      try {
        const viewerId = await optionalViewerId(request, services, env);
        const articles = await services.listPublishedArticles({ locale, query, ...pagination });
        sendJson(response, 200, { data: await serializeRestArticles(services, articles, viewerId) });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    if (relatedArticlesMatch) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const slug = decodeSlug(relatedArticlesMatch[1]);
      const locale = parseLocale(url);
      const limit = parseInteger(url.searchParams, "limit", 6, 1, 50);
      if (!slug || !locale || limit === null) {
        sendBadInput(response, "Invalid article slug, locale, or limit query parameter.");
        return true;
      }
      try {
        const viewerId = await optionalViewerId(request, services, env);
        const articles = await services.listRelatedArticles({ slug, locale, limit });
        sendJson(response, 200, { data: await serializeRestArticles(services, articles, viewerId) });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    if (articleLikePathMatch) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const slug = decodeSlug(articleLikePathMatch[1]);
      const locale = parseLocale(url);
      if (!slug || !locale) {
        sendBadInput(response, "Invalid article slug or locale.");
        return true;
      }
      if (request.method === "GET") {
        try {
          const actorId = await optionalViewerId(request, services, env);
          const result = await services.getArticleLikeInfo({ slug, locale, actorId });
          sendJson(response, 200, { data: result });
        } catch (error: unknown) {
          sendServiceError(response, error);
        }
        return true;
      }
      const bodyResult = await readJsonObject(request);
      if (bodyResult.ok === false) {
        sendJsonBodyError(response, request, bodyResult);
        return true;
      }
      const normalized = normalizeLikeWriteBody(bodyResult.value);
      if (normalized.liked === null) {
        sendBadInput(response, normalized.error ?? "Invalid like input.");
        return true;
      }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) {
          sendUnauthenticated(response);
          return true;
        }
        const result = await services.setArticleLike({ slug, locale, actorId, liked: normalized.liked });
        sendJson(response, 200, { data: result });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    if (articleCommentsPathMatch) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const slug = decodeSlug(articleCommentsPathMatch[1]);
      const locale = parseLocale(url);
      if (!slug || !locale) {
        sendBadInput(response, "Invalid article slug or locale.");
        return true;
      }
      if (request.method === "GET") {
        const limit = parseInteger(url.searchParams, "limit", 50, 1, 100);
        if (limit === null) {
          sendBadInput(response, "Invalid comment limit.");
          return true;
        }
        try {
          const viewerId = await optionalViewerId(request, services, env);
          const comments = await services.listArticleComments({ slug, locale, limit });
          sendJson(response, 200, { data: await serializeRestComments(services, comments, viewerId) });
        } catch (error: unknown) {
          sendServiceError(response, error);
        }
        return true;
      }
      const bodyResult = await readJsonObject(request);
      if (bodyResult.ok === false) {
        sendJsonBodyError(response, request, bodyResult);
        return true;
      }
      const normalized = normalizeCommentWriteBody(bodyResult.value);
      if (!normalized.input) {
        sendBadInput(response, normalized.error ?? "Invalid comment input.");
        return true;
      }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) {
          sendUnauthenticated(response);
          return true;
        }
        const comment = await services.createArticleComment({
          slug, locale, actorId, ...normalized.input,
        });
        sendJson(response, 201, { data: await serializeRestComment(services, comment, actorId) });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    if (commentItemPathMatch) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const commentId = decodeUserId(commentItemPathMatch[1]);
      if (!commentId) {
        sendBadInput(response, "Invalid comment ID.");
        return true;
      }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) {
          sendUnauthenticated(response);
          return true;
        }
        const deleted = await services.deleteArticleComment({ commentId, actorId });
        sendJson(response, 200, { data: { deleted } });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    if (articleMatch && request.method === "PUT") {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const bodyResult = await readJsonObject(request);
      if (bodyResult.ok === false) {
        sendJsonBodyError(response, request, bodyResult);
        return true;
      }
      const normalized = normalizeArticleWriteBody(bodyResult.value, true);
      if (!normalized.input) {
        sendBadInput(response, normalized.error ?? "Invalid article input.");
        return true;
      }
      const articleId = decodeUserId(articleMatch[1]);
      if (!articleId) {
        sendBadInput(response, "Invalid article ID.");
        return true;
      }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) {
          sendUnauthenticated(response);
          return true;
        }
        const article = await services.updateArticle({ ...normalized.input, articleId, actorId });
        sendJson(response, 200, { data: await serializeRestArticle(services, article, actorId) });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }
    if (articleMatch) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const slug = decodeSlug(articleMatch[1]);
      const locale = parseLocale(url);
      if (!slug || !locale) {
        sendBadInput(response, "Invalid article slug or locale.");
        return true;
      }
      try {
        const viewerId = await optionalViewerId(request, services, env);
        const article = await services.getPublishedArticle({ slug, locale });
        if (!article) {
          sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The article was not found." } });
        } else {
          sendJson(response, 200, { data: await serializeRestArticle(services, article, viewerId) });
        }
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    if (url.pathname === "/api/v1/categories") {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const locale = parseLocale(url);
      const query = parseQuery(url);
      const pagination = parsePagination(url, 100, MAX_TAXONOMY_OFFSET);
      if (!locale || query === null || !pagination) {
        sendBadInput(response, "Invalid locale, query, limit, or offset query parameter.");
        return true;
      }
      try {
        const categories = await services.listTaxonomies({ kind: "category", locale, query, ...pagination });
        sendJson(response, 200, { data: categories });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    if (categoryArticlesMatch) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const slug = decodeSlug(categoryArticlesMatch[1]);
      const locale = parseLocale(url);
      const pagination = parsePagination(url, 20, MAX_TAXONOMY_OFFSET);
      if (!slug || !locale || !pagination) {
        sendBadInput(response, "Invalid category slug, locale, limit, or offset query parameter.");
        return true;
      }
      try {
        const category = await services.getTaxonomyBySlug({ kind: "category", slug, locale });
        if (!category) {
          sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The category was not found." } });
          return true;
        }
        const viewerId = await optionalViewerId(request, services, env);
        const articles = await services.listTaxonomyArticles({ kind: "category", slug, locale, ...pagination });
        sendJson(response, 200, { data: await serializeRestArticles(services, articles, viewerId) });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    if (categoryMatch) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const slug = decodeSlug(categoryMatch[1]);
      const locale = parseLocale(url);
      if (!slug || !locale) {
        sendBadInput(response, "Invalid category slug or locale.");
        return true;
      }
      try {
        const category = await services.getTaxonomyBySlug({ kind: "category", slug, locale });
        if (!category) {
          sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The category was not found." } });
        } else {
          sendJson(response, 200, { data: category });
        }
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    if (url.pathname === "/api/v1/tags") {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const locale = parseLocale(url);
      const query = parseQuery(url);
      const pagination = parsePagination(url, 100, MAX_TAXONOMY_OFFSET);
      if (!locale || query === null || !pagination) {
        sendBadInput(response, "Invalid locale, query, limit, or offset query parameter.");
        return true;
      }
      try {
        const tags = await services.listTaxonomies({ kind: "tag", locale, query, ...pagination });
        sendJson(response, 200, { data: tags });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    if (tagArticlesMatch) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const slug = decodeSlug(tagArticlesMatch[1]);
      const locale = parseLocale(url);
      const pagination = parsePagination(url, 20, MAX_TAXONOMY_OFFSET);
      if (!slug || !locale || !pagination) {
        sendBadInput(response, "Invalid tag slug, locale, limit, or offset query parameter.");
        return true;
      }
      try {
        const tag = await services.getTaxonomyBySlug({ kind: "tag", slug, locale });
        if (!tag) {
          sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The tag was not found." } });
          return true;
        }
        const viewerId = await optionalViewerId(request, services, env);
        const articles = await services.listTaxonomyArticles({ kind: "tag", slug, locale, ...pagination });
        sendJson(response, 200, { data: await serializeRestArticles(services, articles, viewerId) });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    if (tagMatch) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const slug = decodeSlug(tagMatch[1]);
      const locale = parseLocale(url);
      if (!slug || !locale) {
        sendBadInput(response, "Invalid tag slug or locale.");
        return true;
      }
      try {
        const tag = await services.getTaxonomyBySlug({ kind: "tag", slug, locale });
        if (!tag) {
          sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The tag was not found." } });
        } else {
          sendJson(response, 200, { data: tag });
        }
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The API route was not found." } });
    return true;
  };
}
