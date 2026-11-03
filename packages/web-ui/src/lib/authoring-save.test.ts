import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTHORING_LOCALES,
  DEFAULT_AUTHORING_LOCALE,
  NO_CREATE_INTENT,
  beginCreateIntent,
  finishCreateIntent,
  isAuthoringLocale,
  resolveAuthoringLocale,
} from "./authoring-save.ts";

/**
 * 写作台保存的两个纯决策（issue #168）。
 *
 * 它们都曾以「看起来能用」的方式写死在组件里：`locale: "zh-CN"` 与不生成幂等键
 * 都不会报错，只会在真实使用中让英文作者写不出英文作品、让弱网重试多发一篇。
 */

test("新建作品用作者选的语言，没选就是简体中文", () => {
  assert.equal(resolveAuthoringLocale(null, "en"), "en");
  assert.equal(resolveAuthoringLocale(null, "zh-CN"), "zh-CN");
  assert.equal(resolveAuthoringLocale(null, null), DEFAULT_AUTHORING_LOCALE);
  assert.equal(resolveAuthoringLocale(undefined, "klingon"), DEFAULT_AUTHORING_LOCALE, "an unknown choice is not a locale");
});

test("编辑既有作品时保留作品自己的语言", () => {
  // The desk offers zh-CN and en. A work that is zh-TW must still open and save
  // as zh-TW: changing its locale would swap the work's translation for another
  // language while the original text stayed the same.
  assert.equal(resolveAuthoringLocale({ locale: "zh-TW" }, "en"), "zh-TW");
  assert.equal(resolveAuthoringLocale({ locale: "en" }, null), "en");
  // An existing work with no readable locale falls back to the choice, not to a guess.
  assert.equal(resolveAuthoringLocale({ locale: 42 }, "en"), "en");
});

test("写作台的语言集合与 API 一致，且不包含 zh-TW 作为可选项", () => {
  assert.deepEqual([...AUTHORING_LOCALES], ["zh-CN", "en"]);
  assert.equal(isAuthoringLocale("zh-CN"), true);
  assert.equal(isAuthoringLocale("en"), true);
  assert.equal(isAuthoringLocale("zh-TW"), false, "zh-TW works are read-only here, not creatable");
  assert.equal(isAuthoringLocale("EN"), false, "case matters: the API compares exact tags");
});

test("一次意图一个幂等键：重试复用，成功后换新", () => {
  let minted = 0;
  const mint = () => `key-${++minted}`;

  const first = beginCreateIntent(NO_CREATE_INTENT, mint);
  assert.equal(first.key, "key-1");
  assert.equal(minted, 1);

  // A failed save keeps the key: the author's next click is a retry, not a second work.
  const afterFailure = finishCreateIntent(first.intent, false);
  const retry = beginCreateIntent(afterFailure, mint);
  assert.equal(retry.key, "key-1", "the retry replays the same intent");
  assert.equal(minted, 1, "no new key was minted for a retry");

  // A successful save ends the intent; the next click is a new one.
  const afterSuccess = finishCreateIntent(retry.intent, true);
  assert.equal(afterSuccess, NO_CREATE_INTENT);
  const next = beginCreateIntent(afterSuccess, mint);
  assert.equal(next.key, "key-2");
  assert.equal(minted, 2);
});

test("失败但从未生成过键时不会凭空造一个", () => {
  // A save that failed before reaching the request has nothing to retry with;
  // `finishCreateIntent` must not invent a key that was never sent.
  assert.equal(finishCreateIntent(NO_CREATE_INTENT, false).key, null);
});
