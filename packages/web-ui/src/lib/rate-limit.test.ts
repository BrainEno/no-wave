import assert from "node:assert/strict";
import test from "node:test";

import { apiErrorMessage } from "./api-error.ts";
import { retryWaitLabel, signInFailureMessage } from "./rate-limit.ts";

/**
 * #184: a 429 must be answered in the language of the page, with a wait the
 * reader can act on when the proxy relays one, and with nothing that turns an
 * unknown address into a different answer from a wrong password.
 */
const LIMITED = { error: { code: "RATE_LIMITED", message: "Too many authentication attempts." } };
const UNKNOWN_EMAIL = { error: { code: "UNAUTHENTICATED", message: "The credentials are invalid." } };
const WRONG_PASSWORD = { error: { code: "UNAUTHENTICATED", message: "The credentials are invalid." } };

test("a throttled sign-in is named in the language of the page", () => {
  assert.equal(apiErrorMessage(LIMITED, "zh-CN"), "尝试次数过多，请稍后再试。");
  assert.equal(apiErrorMessage(LIMITED, "en"), "Too many attempts. Please try again later.");
});

test("a valid Retry-After becomes an actionable wait in both languages", () => {
  assert.equal(signInFailureMessage(LIMITED, "zh-CN", "12"), "尝试次数过多，请等待 12 秒后重试。");
  assert.equal(signInFailureMessage(LIMITED, "en", "12"), "Too many attempts. Try again in 12 seconds.");
  assert.equal(signInFailureMessage(LIMITED, "zh-CN", "90"), "尝试次数过多，请等待 2 分钟后重试。");
  assert.equal(signInFailureMessage(LIMITED, "en", "90"), "Too many attempts. Try again in about 2 minutes.");
});

test("a missing, invalid or spent Retry-After still gives a clear localized answer", () => {
  for (const header of [null, "", "soon", "0", "-5", "12\r\nx-evil: 1"]) {
    const zh = signInFailureMessage(LIMITED, "zh-CN", header);
    const en = signInFailureMessage(LIMITED, "en", header);
    assert.equal(zh, "尝试次数过多，请稍后再试。", JSON.stringify(header));
    assert.equal(en, "Too many attempts. Please try again later.", JSON.stringify(header));
    assert.equal(zh.includes("Too many authentication attempts."), false);
  }
});

test("a wait is readable, not a raw second count", () => {
  assert.equal(retryWaitLabel(59, "zh-CN"), "59 秒");
  assert.equal(retryWaitLabel(60, "zh-CN"), "1 分钟");
  assert.equal(retryWaitLabel(3600, "en"), "about 60 minutes");
});

test("unknown address and wrong password stay indistinguishable", () => {
  for (const header of [null, "30"]) {
    assert.equal(
      signInFailureMessage(UNKNOWN_EMAIL, "zh-CN", header),
      signInFailureMessage(WRONG_PASSWORD, "zh-CN", header),
    );
  }
  assert.equal(signInFailureMessage(UNKNOWN_EMAIL, "zh-CN", null), "The credentials are invalid.");
});

test("an unrecognised code keeps the server's own words", () => {
  const payload = { error: { code: "CONFLICT", message: "The request conflicts with the current resource state." } };
  assert.equal(signInFailureMessage(payload, "zh-CN", "30"), "The request conflicts with the current resource state.");
  assert.equal(signInFailureMessage(null, "en", null), "The request failed. Try again in a moment.");
});
