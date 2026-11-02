import assert from "node:assert/strict";
import test from "node:test";

import { apiErrorCode, apiErrorMessage } from "./api-error.ts";

/**
 * What a form shows when the API refuses.
 *
 * The contract this pins is the seam between the two sides: the API answers
 * with a stable code and a generic English sentence, and the page turns a code
 * it recognises into a sentence in the reader's own language. The cases worth
 * proving are the ones a reader would notice — a taken address reads as "sign
 * in instead" in both languages, and anything unrecognised still reaches the
 * reader rather than being swallowed by the fallback.
 */

const TAKEN = { error: { code: "EMAIL_TAKEN", message: "The email address is already registered." } };

test("a taken address is named in the language of the page", () => {
  assert.equal(apiErrorMessage(TAKEN, "zh-CN"), "这个邮箱已经注册过了，直接登录即可。");
  assert.equal(apiErrorMessage(TAKEN, "en"), "That address already has an account. Sign in instead.");
});

test("a code the page does not know keeps the server's own words", () => {
  // A generic fallback here would hide the only clue the response carries.
  const payload = { error: { code: "CONFLICT", message: "The request conflicts with the current resource state." } };
  assert.equal(apiErrorMessage(payload, "zh-CN"), "The request conflicts with the current resource state.");
  assert.equal(apiErrorMessage(payload, "en"), "The request conflicts with the current resource state.");
});

test("a body with nothing usable in it falls back to the caller's sentence", () => {
  assert.equal(apiErrorMessage(null, "zh-CN", "请求失败，请稍后重试。"), "请求失败，请稍后重试。");
  assert.equal(apiErrorMessage({}, "zh-CN", "请求失败，请稍后重试。"), "请求失败，请稍后重试。");
  assert.equal(apiErrorMessage({ error: {} }, "zh-CN", "请求失败，请稍后重试。"), "请求失败，请稍后重试。");
  assert.equal(apiErrorMessage("<html>", "zh-CN", "请求失败，请稍后重试。"), "请求失败，请稍后重试。");
  // Without an explicit fallback the interface copy answers, per locale.
  assert.equal(apiErrorMessage(null, "zh-CN"), "请求失败，请稍后重试。");
  assert.equal(apiErrorMessage(null, "en"), "The request failed. Try again in a moment.");
});

test("the code survives a payload that is not an error body at all", () => {
  assert.equal(apiErrorCode(TAKEN), "EMAIL_TAKEN");
  assert.equal(apiErrorCode({ error: { code: 409 } }), "");
  assert.equal(apiErrorCode({ error: null }), "");
  assert.equal(apiErrorCode({ data: {} }), "");
  assert.equal(apiErrorCode(null), "");
});
