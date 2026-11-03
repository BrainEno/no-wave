import assert from "node:assert/strict";
import test from "node:test";
import {
  likeButtonLabel,
  likeStateAfterWrite,
  nextLikeIntent,
  parseLikeState,
  followButtonLabel,
  signInToEngageMessage,
} from "./engagement.ts";

/**
 * 读者动作的文案与意图（issue #168）。
 *
 * 收藏与关注的按钮看起来是三行 JSX，实际藏着两个容易做错的决定：写进去的是
 * 「目标状态」还是「切换」，以及计数由谁负责。两条都在这里钉住。
 */

test("收藏状态读不懂时是零收藏、未收藏，而不是崩溃或 NaN", () => {
  assert.deepEqual(parseLikeState({ likeCount: 3, likedByViewer: true }), { likeCount: 3, likedByViewer: true });
  assert.deepEqual(parseLikeState({ likeCount: "3", likedByViewer: "true" }), { likeCount: 0, likedByViewer: false });
  assert.deepEqual(parseLikeState({ likeCount: -1 }), { likeCount: 0, likedByViewer: false });
  assert.deepEqual(parseLikeState({ likeCount: 2.7 }), { likeCount: 2, likedByViewer: false });
  assert.deepEqual(parseLikeState(null), { likeCount: 0, likedByViewer: false });
  assert.deepEqual(parseLikeState("nope"), { likeCount: 0, likedByViewer: false });
});

test("点击收藏写的是目标状态，不是切换", () => {
  // Double-clicking is the bug this prevents: "toggle" would save and unsave.
  assert.deepEqual(nextLikeIntent({ likeCount: 3, likedByViewer: false }, false), { liked: true });
  assert.deepEqual(nextLikeIntent({ likeCount: 4, likedByViewer: true }, false), { liked: false });
  // While a write is in flight the button is not a second intent.
  assert.equal(nextLikeIntent({ likeCount: 3, likedByViewer: false }, true), null);
});

test("收藏数由服务端给，本地不自己加一减一", () => {
  const current = { likeCount: 3, likedByViewer: false };
  assert.deepEqual(likeStateAfterWrite(current, { likeCount: 9, likedByViewer: true }), { likeCount: 9, likedByViewer: true },
    "somebody else saved it too; the server's count wins");
  // A response without a count field keeps the number that was on screen instead
  // of replacing it with zero.
  assert.deepEqual(likeStateAfterWrite(current, { likedByViewer: true }), { likeCount: 3, likedByViewer: true });
});

test("按钮文案跟着状态走，且不是只有颜色变化", () => {
  assert.equal(likeButtonLabel({ likeCount: 0, likedByViewer: false }, false, "zh-CN"), "收藏 · 0");
  assert.equal(likeButtonLabel({ likeCount: 7, likedByViewer: true }, false, "zh-CN"), "已收藏 · 7");
  assert.equal(likeButtonLabel({ likeCount: 7, likedByViewer: true }, true, "zh-CN"), "处理中…");
  assert.equal(likeButtonLabel({ likeCount: 7, likedByViewer: true }, false, "en"), "Saved · 7");
  assert.equal(followButtonLabel(false, false, "zh-CN"), "关注");
  assert.equal(followButtonLabel(true, false, "zh-CN"), "已关注");
  assert.equal(followButtonLabel(true, false, "en"), "Following");
  assert.equal(followButtonLabel(false, true, "en"), "Saving…");
});

test("未登录的提示是一句话，不是一个错误码", () => {
  assert.match(signInToEngageMessage("zh-CN"), /登录后可以收藏作品、关注作者/);
  assert.match(signInToEngageMessage("en"), /Sign in to save work and follow authors/);
});
