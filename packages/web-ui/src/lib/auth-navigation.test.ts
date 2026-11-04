import assert from "node:assert/strict";
import test from "node:test";

import { destinationLabel, signInSuccessMessage } from "./auth-navigation.ts";

/**
 * #185: the sentence a reader sees while the router replaces the page must name
 * the page they are actually going to. The loader defaults to `/account`; the
 * form used to promise the writing desk on every success.
 *
 * These are pure decisions, so they are pinned without rendering React.
 */
test("the default destination is named for both sign-in and registration, in both languages", () => {
  assert.equal(signInSuccessMessage("/account", "login", "zh-CN"), "登录成功，正在打开账户页……");
  assert.equal(signInSuccessMessage("/account", "register", "zh-CN"), "账户已创建，正在打开账户页……");
  assert.equal(signInSuccessMessage("/account", "login", "en"), "Signed in. Opening your account…");
  assert.equal(signInSuccessMessage("/account", "register", "en"), "Account created. Opening your account…");
  for (const message of [
    signInSuccessMessage("/account", "login", "zh-CN"),
    signInSuccessMessage("/account", "register", "zh-CN"),
  ]) {
    assert.equal(message.includes("写作台"), false, "the default landing page is /account, not /write");
  }
});

test("a legal next destination keeps its own name, including query and hash", () => {
  assert.equal(signInSuccessMessage("/write", "login", "zh-CN"), "登录成功，正在打开写作台……");
  assert.equal(signInSuccessMessage("/write?draft=1#top", "login", "zh-CN"), "登录成功，正在打开写作台……");
  assert.equal(signInSuccessMessage("/", "login", "zh-CN"), "登录成功，正在打开首页……");
  assert.equal(signInSuccessMessage("/en/account", "login", "en"), "Signed in. Opening your account…");
  assert.equal(signInSuccessMessage("/account?tab=profile#top", "login", "en"), "Signed in. Opening your account…");
});

test("an unfamiliar or unsafe destination gets a generic, still truthful label", () => {
  assert.equal(destinationLabel("/articles/some-slug", "zh-CN"), "目标页面");
  assert.equal(signInSuccessMessage("/articles/some-slug", "register", "zh-CN"), "账户已创建，正在打开目标页面……");
  assert.equal(destinationLabel("https://attacker.test/account", "en"), "your destination");
  assert.equal(destinationLabel("//attacker.test", "en"), "your destination");
  assert.equal(destinationLabel("not-a-path", "en"), "your destination");
  assert.equal(signInSuccessMessage("/articles/some-slug", "login", "en"), "Signed in. Opening your destination…");
});
