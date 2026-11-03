import type { ApiProxyConfig } from "./api.ts";
import { readLimitedJson } from "./body.ts";
import { forwardAuthoringRequest } from "./forward.ts";
import { errorResponse } from "./http.ts";
import { isSameOriginMutation } from "./policy.ts";

/**
 * 收藏与关注：阅读页上唯二的两个「读者自己的动作」（issue #168）。
 *
 * 服务端早就有这两件事（`PUT /articles/:slug/like`、`POST|DELETE /users/:id/
 * follow`），缺的是浏览器这一侧：token 在 HttpOnly cookie 里，页面自己拼不出
 * `Authorization` 头。所以每个读者动作都要经过这个代理，和写作台、评论、通知
 * 走同一条路。
 *
 * 两个动作形状相似、语义不同，所以规则写在一起但分开处理：
 *
 * - 收藏是**幂等置位**（`liked: true|false`），不是切换。读者双击「收藏」不该
 *   收藏再取消；发两次 `true` 的结果必须和发一次一样。
 * - 关注是**有方向的一对端点**（`POST` 关注、`DELETE` 取消），因为取消关注不是
 *   「把关注设成 false」而是删掉那条关系。
 *
 * 剩下的一切都是共用的：先查方法，再查 Origin（跨站请求连 slug 是否合法都不该
 * 知道），然后才看路径参数，最后把 cookie 换成 Bearer 转发。
 *
 * 这个文件不引入任何框架。
 */

/** Article slugs are lowercase kebab-case; the shape is checked before proxying. */
export const ENGAGEMENT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Locales the like/follow endpoints are asked in. */
export const ENGAGEMENT_LOCALES: readonly string[] = Object.freeze(["zh-CN", "zh-TW", "en"]);

export const ENGAGEMENT_DEFAULT_LOCALE = "zh-CN";

/** A like body is `{ liked: boolean }`; 4 KiB is already far more than that. */
export const ENGAGEMENT_BODY_MAX_BYTES = 4096;

export function isEngagementLocale(locale: string): boolean {
  return ENGAGEMENT_LOCALES.includes(locale);
}

/** `api/v1/articles/:slug/like?locale=…` */
export function articleLikePath(slug: string, locale: string = ENGAGEMENT_DEFAULT_LOCALE): string {
  return `api/v1/articles/${encodeURIComponent(slug)}/like?locale=${encodeURIComponent(locale)}`;
}

/** `api/v1/users/:userId/follow?locale=…` */
export function userFollowPath(userId: string, locale: string = ENGAGEMENT_DEFAULT_LOCALE): string {
  return `api/v1/users/${encodeURIComponent(userId)}/follow?locale=${encodeURIComponent(locale)}`;
}

function rejectCrossOrigin(request: Request): boolean {
  return isSameOriginMutation(request.url, request.headers.get("origin"), request.headers.get("host")) === false;
}

/**
 * `GET`/`PUT /api/articles/:slug/like` — read the count, set the reader's choice.
 *
 * `GET` is public and answers `{ likeCount, likedByViewer }`; a signed-out reader
 * gets `likedByViewer: false`, which is why the button can render before anyone
 * signs in. `PUT` requires a session — the API answers 401 and the page turns
 * that into "sign in to save this".
 *
 * The body is parsed here rather than forwarded blindly so a caller cannot smuggle
 * a `userId` or anything else the API would refuse anyway: only `liked` goes on.
 */
export async function handleArticleLikeRequest(
  request: Request,
  params: { slug: string; locale?: string | null },
  config: ApiProxyConfig = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "PUT") {
    return errorResponse("METHOD_NOT_ALLOWED", "Only GET and PUT are supported for a like.", 405);
  }
  // Origin first on a write, exactly as the comment proxy does it: a cross-origin
  // caller must not be able to use the status code to probe which slug exists.
  if (method === "PUT" && rejectCrossOrigin(request)) {
    return errorResponse("ORIGIN_REJECTED", "The request origin was rejected.", 403);
  }
  const locale = params.locale?.trim() || ENGAGEMENT_DEFAULT_LOCALE;
  if (!isEngagementLocale(locale)) {
    return errorResponse("BAD_USER_INPUT", "Invalid locale.", 400);
  }
  if (!ENGAGEMENT_SLUG_PATTERN.test(params.slug)) {
    return errorResponse("BAD_USER_INPUT", "Invalid article slug.", 400);
  }
  const path = articleLikePath(params.slug, locale);
  if (method === "GET") return forwardAuthoringRequest(request, path, "GET", config);

  const body = await readLimitedJson(request, ENGAGEMENT_BODY_MAX_BYTES);
  if (!body.ok) return body.response;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return errorResponse("BAD_USER_INPUT", "The body must be a JSON object.", 400);
  }
  const liked = typeof parsed === "object" && parsed !== null ? (parsed as { liked?: unknown }).liked : undefined;
  if (typeof liked !== "boolean") {
    return errorResponse("BAD_USER_INPUT", "liked must be true or false.", 400);
  }
  return forwardAuthoringRequest(request, path, "PUT", config, JSON.stringify({ liked }));
}

/**
 * `POST`/`DELETE /api/users/:userId/follow` — follow, unfollow.
 *
 * Both are mutations and both need a session. `POST` is idempotent on the server
 * (following twice is not two follows), so a double-click is harmless; `DELETE`
 * answers with the same profile shape, which is what lets the button redraw
 * without a second request.
 */
export async function handleUserFollowRequest(
  request: Request,
  params: { userId: string; locale?: string | null },
  config: ApiProxyConfig = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== "POST" && method !== "DELETE") {
    return errorResponse("METHOD_NOT_ALLOWED", "Only POST and DELETE are supported for a follow.", 405);
  }
  // Both methods are writes, so the Origin check comes before the parameters.
  if (rejectCrossOrigin(request)) {
    return errorResponse("ORIGIN_REJECTED", "The request origin was rejected.", 403);
  }
  const locale = params.locale?.trim() || ENGAGEMENT_DEFAULT_LOCALE;
  if (!isEngagementLocale(locale)) {
    return errorResponse("BAD_USER_INPUT", "Invalid locale.", 400);
  }
  // User ids are the usernames the public author page is addressed by; they are
  // the same shape the API validates, checked here so a malformed one never
  // becomes an upstream round trip.
  const userId = params.userId.trim();
  if (userId.length === 0 || userId.length > 300) {
    return errorResponse("BAD_USER_INPUT", "Invalid user ID.", 400);
  }
  return forwardAuthoringRequest(request, userFollowPath(userId, locale), method as "POST" | "DELETE", config);
}
