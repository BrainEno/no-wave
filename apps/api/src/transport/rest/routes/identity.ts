import type { RestRouteContext, RestRouteHandler } from "./context.ts";
import { MAX_QUERY_LENGTH, authenticatedActorId, authenticatedUser, decodeUserId, optionalViewerId, parseInteger, parseLocale, readJsonObject, sendBadInput, sendJson, sendJsonBodyError, sendServiceError, sendUnauthenticated, sendUnavailable } from "../http.ts";
import { normalizeProfileWriteBody } from "../bodies.ts";

/** Current-user, profile, session and follow-graph endpoints
 * (`me`, `me.profile`, `me.session`, `users*`). */
const IDENTITY_ROUTE_HANDLERS: Readonly<Record<string, RestRouteHandler>> = Object.freeze({
  "me": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, services, env, identity } = ctx;
    if (!services) {
      sendUnavailable(response);
      return;
    }
    try {
      const actorId = await authenticatedActorId(request, services, env);
      if (!actorId) {
        sendUnauthenticated(response);
        return;
      }
      const data = identity
        ? await identity.describeAccount(actorId)
        : { id: actorId, email: null, emailVerifiedAt: null };
      sendJson(response, 200, { data });
    } catch (error: unknown) {
      sendServiceError(response, error);
    }
  },
  /**
   * Ask for the verification mail to be sent (or sent again).
   *
   * Authenticated and addressed to the account's own address: an unauthenticated
   * version would let anyone aim mail at any address in the database.
   */
  "me.email-verification": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, services, env, identity } = ctx;
    if (!services || !identity) {
      sendUnavailable(response);
      return;
    }
    try {
      const actorId = await authenticatedActorId(request, services, env);
      if (!actorId) {
        sendUnauthenticated(response);
        return;
      }
      const ip = request.socket.remoteAddress ?? "unknown";
      const data = await identity.requestEmailVerification(actorId, ip);
      sendJson(response, 202, { data });
    } catch (error: unknown) {
      sendServiceError(response, error);
    }
  },
  "me.profile": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, url, services, env } = ctx;
    if (request.method === "GET") {
      if (!services) {
        sendUnavailable(response);
        return;
      }
      const locale = parseLocale(url);
      if (!locale) {
        sendBadInput(response, "Invalid locale.");
        return;
      }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) {
          sendUnauthenticated(response);
          return;
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
      return;
    }
    if (!services) {
      sendUnavailable(response);
      return;
    }
    const bodyResult = await readJsonObject(request);
    if (bodyResult.ok === false) {
      sendJsonBodyError(response, request, bodyResult);
      return;
    }
    const normalized = normalizeProfileWriteBody(bodyResult.value);
    if (!normalized.input) {
      sendBadInput(response, normalized.error ?? "Invalid profile input.");
      return;
    }
    try {
      const userId = await authenticatedActorId(request, services, env);
      if (!userId) {
        sendUnauthenticated(response);
        return;
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
  },
  "me.session": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, services, env } = ctx;
    if (!services) {
      sendUnavailable(response);
      return;
    }
    try {
      const user = await authenticatedUser(request, services, env);
      if (!user) {
        sendUnauthenticated(response);
        return;
      }
      await services.revokeSession({
        sessionId: user.sessionId,
        expiresAt: new Date(user.sessionExpiresAt * 1000),
      });
      sendJson(response, 200, { data: true });
    } catch (error: unknown) {
      sendServiceError(response, error);
    }
  },
  /**
   * `PUT /api/v1/me/password` — change the password of the signed-in account.
   *
   * Two credentials travel in the body and only one of them is new: the
   * current password is the proof that the session changing it is the owner's,
   * so a stolen session alone cannot take the account over or lock the owner
   * out. The session that made the request survives (the identity service
   * spares it); every other session of the account is signed out.
   *
   * The body ceiling is the identity one rather than the general JSON limit:
   * two passwords are a few hundred bytes, and there is no reason to accept
   * more before authentication has been established.
   */
  "me.password": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, services, env, identity } = ctx;
    if (!services || !identity) {
      sendUnavailable(response);
      return;
    }
    const bodyResult = await readJsonObject(request, 4096);
    if (bodyResult.ok === false) {
      sendJsonBodyError(response, request, bodyResult);
      return;
    }
    try {
      const user = await authenticatedUser(request, services, env);
      if (!user) {
        sendUnauthenticated(response);
        return;
      }
      const ip = request.socket.remoteAddress ?? "unknown";
      const data = await identity.changePassword({
        userId: user.id,
        sessionId: user.sessionId,
        body: bodyResult.value,
        ip,
      });
      sendJson(response, 200, { data });
    } catch (error: unknown) {
      sendServiceError(response, error);
    }
  },
  /**
   * `PUT /api/v1/me/email` — move the signed-in account to another address.
   *
   * The current password travels with it: whoever controls the address controls
   * the account's recovery, so this must not be possible with a session alone.
   * The address is then unverified, because what is on file is proof of the old
   * one — but nothing is gated on verification and no mail is sent, so this
   * works on an instance where mail is switched off.
   */
  "me.email": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, services, env, identity } = ctx;
    if (!services || !identity) {
      sendUnavailable(response);
      return;
    }
    const bodyResult = await readJsonObject(request, 4096);
    if (bodyResult.ok === false) {
      sendJsonBodyError(response, request, bodyResult);
      return;
    }
    try {
      const actorId = await authenticatedActorId(request, services, env);
      if (!actorId) {
        sendUnauthenticated(response);
        return;
      }
      const ip = request.socket.remoteAddress ?? "unknown";
      const data = await identity.changeEmail({ userId: actorId, body: bodyResult.value, ip });
      sendJson(response, 200, { data });
    } catch (error: unknown) {
      sendServiceError(response, error);
    }
  },
  "users": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, url, services, env } = ctx;
    if (!services) {
      sendUnavailable(response);
      return;
    }
    const query = url.searchParams.get("query");
    const locale = parseLocale(url);
    const limit = parseInteger(url.searchParams, "limit", 20, 1, 100);
    if (query === null || query.length > MAX_QUERY_LENGTH || !locale || limit === null) {
      sendBadInput(response, "Invalid query, locale, or limit query parameter.");
      return;
    }
    try {
      const viewerId = await optionalViewerId(request, services, env);
      const users = await services.searchUsers({ query, locale, limit, viewerId });
      sendJson(response, 200, { data: users });
    } catch (error: unknown) {
      sendServiceError(response, error);
    }
  },
  "users.relationships": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, url, services, env, routeParams } = ctx;
    if (!services) {
      sendUnavailable(response);
      return;
    }
    const userId = decodeUserId(routeParams.userId);
    const relation = routeParams.relation;
    const locale = parseLocale(url);
    const limit = parseInteger(url.searchParams, "limit", 50, 1, 100);
    if (!userId || !locale || limit === null) {
      sendBadInput(response, "Invalid user ID, locale, or limit query parameter.");
      return;
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
  },
  "users.follow": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, url, services, env, routeParams } = ctx;
    if (!services) {
      sendUnavailable(response);
      return;
    }
    const targetUserId = decodeUserId(routeParams.userId);
    const locale = parseLocale(url);
    if (!targetUserId || !locale) {
      sendBadInput(response, "Invalid target user ID or locale.");
      return;
    }
    try {
      const actorId = await authenticatedActorId(request, services, env);
      if (!actorId) {
        sendUnauthenticated(response);
        return;
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
  },
});

export const IDENTITY_ROUTE_IDS: readonly string[] = Object.freeze(Object.keys(IDENTITY_ROUTE_HANDLERS));

export async function handleIdentityRoutes(ctx: RestRouteContext): Promise<boolean> {
  const handler = IDENTITY_ROUTE_HANDLERS[ctx.routeId ?? ""];
  if (!handler) return false;
  await handler(ctx);
  return true;
}
