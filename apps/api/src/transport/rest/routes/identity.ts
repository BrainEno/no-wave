import type { RestRouteContext } from "./context.ts";
import { MAX_QUERY_LENGTH, authenticatedActorId, authenticatedUser, decodeUserId, optionalViewerId, parseInteger, parseLocale, readJsonObject, sendBadInput, sendJson, sendJsonBodyError, sendServiceError, sendUnauthenticated, sendUnavailable } from "../http.ts";
import { normalizeProfileWriteBody } from "../bodies.ts";

/** Current-user, profile, session and follow-graph endpoints
 * (`me`, `me.profile`, `me.session`, `users*`). */
export async function handleIdentityRoutes(ctx: RestRouteContext): Promise<boolean> {
  const { request, response, url, services, env, routeParams, routeId } = ctx;

    if (routeId === "me") {
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

    if (routeId === "me.profile" && request.method === "GET") {
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

    if (routeId === "me.session") {
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

    if (routeId === "users") {
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

    if (routeId === "users.relationships") {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const userId = decodeUserId(routeParams.username);
      const relation = routeParams.relation;
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

    if (routeId === "me.profile") {
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

    if (routeId === "users.follow") {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const targetUserId = decodeUserId(routeParams.username);
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

  return false;
}
