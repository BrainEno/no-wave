import type { Locale } from "./content.ts";

/**
 * 阅读页上的读者动作（issue #168）：收藏这篇作品、关注这位作者。
 *
 * 服务的形状决定按钮的形状，所以这三条规则在这里写一次、有测试，而不是散落在
 * 三个组件的状态里：
 *
 * 1. **收藏是置位，不是切换。** `PUT …/like` 带 `{ liked: boolean }`，所以双击
 *    不会「收藏又取消」——第一次点击把按钮变成「已收藏」，第二次点击发的是同一个
 *    `true`。想取消就再点一次「已收藏」，发的是 `false`。
 * 2. **关注是方向，不是布尔值。** 关注 `POST`，取消关注 `DELETE`；两者都返回同一个
 *    作者档案，所以按钮刷新不需要第二次请求。
 * 3. **未登录不是错误。** 读者没登录时按钮显示「收藏」，点击后变成「登录后收藏」
 *    的提示，而不是一个 401 弹窗；`likedByViewer` 本来对匿名读者就是 `false`。
 */

export type LikeState = { likeCount: number; likedByViewer: boolean };

const EMPTY_LIKE: LikeState = Object.freeze({ likeCount: 0, likedByViewer: false });

/** 从 API 的响应体里读一个收藏状态；读不懂就当作零收藏、未收藏。 */
export function parseLikeState(value: unknown): LikeState {
  if (typeof value !== "object" || value === null) return EMPTY_LIKE;
  const item = value as { likeCount?: unknown; likedByViewer?: unknown };
  const likeCount = typeof item.likeCount === "number" && Number.isFinite(item.likeCount) && item.likeCount >= 0
    ? Math.floor(item.likeCount)
    : 0;
  return { likeCount, likedByViewer: item.likedByViewer === true };
}

/**
 * 点一下「收藏」之后该发什么。
 *
 * 返回 `null` 表示这次点击不该发请求（按钮已经在请求中）。否则返回要发到服务端的
 * 目标状态：**当前状态的否定**。用「否定」而不是「翻转本地布尔值」，是因为本地值
 * 可能在请求进行期间过期；服务端是唯一的真相，而置位的写入是幂等的，重复一次不会
 * 出错。
 */
export function nextLikeIntent(state: LikeState, pending: boolean): { liked: boolean } | null {
  if (pending) return null;
  return { liked: !state.likedByViewer };
}

/**
 * 服务端确认之后按钮显示什么。
 *
 * 收藏数由服务端给，本地不自己加减：另一个人同时收藏时，本地加减会和服务端对不上，
 * 而按钮旁边的数字是读者唯一能看到的计数。
 */
export function likeStateAfterWrite(fallback: LikeState, response: unknown): LikeState {
  const parsed = parseLikeState(response);
  // A response that says nothing about the count keeps the previous one rather
  // than showing zero: a missing field is not a count of nothing.
  if (!hasOwn(response, "likeCount")) return { likeCount: fallback.likeCount, likedByViewer: parsed.likedByViewer };
  return parsed;
}

function hasOwn(value: unknown, key: string): boolean {
  return typeof value === "object" && value !== null && Object.hasOwn(value, key);
}

/** 收藏按钮的文案。`pending` 时说明正在发生什么，而不是让按钮看起来没反应。 */
export function likeButtonLabel(state: LikeState, pending: boolean, locale: Locale): string {
  const en = locale === "en";
  if (pending) return en ? "Saving…" : "处理中…";
  if (state.likedByViewer) return en ? `Saved · ${state.likeCount}` : `已收藏 · ${state.likeCount}`;
  return en ? `Save · ${state.likeCount}` : `收藏 · ${state.likeCount}`;
}

/** 关注按钮的文案。`known` 为 false 时还不知道读者是否已关注，按钮先读作「关注」。 */
export function followButtonLabel(following: boolean, pending: boolean, locale: Locale): string {
  const en = locale === "en";
  if (pending) return en ? "Saving…" : "处理中…";
  if (following) return en ? "Following" : "已关注";
  return en ? "Follow" : "关注";
}

/** 未登录时点击这两个按钮看到的提示；不是一个错误，也不需要重试。 */
export function signInToEngageMessage(locale: Locale): string {
  return locale === "en" ? "Sign in to save work and follow authors." : "登录后可以收藏作品、关注作者。";
}
