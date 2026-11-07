import assert from "node:assert/strict";
import test from "node:test";
import { getUi } from "./ui-copy.ts";

/**
 * Copy is code, and it can be wrong in a way tests usually miss.
 *
 * The sign-in page used to carry two sentences saying authentication was "not
 * implemented at this stage", long after `/api/auth/*`, email verification,
 * recovery and the follow graph shipped. Nothing read them — they were dead
 * strings — but dead strings are what the next screen imports when somebody needs
 * a heading, and then the product tells a reader that a working feature does not
 * exist. This file guards the two properties that would have caught it: the
 * languages stay structurally identical, and the copy does not claim the backend
 * is missing.
 */

function keyPaths(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object") return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    keyPaths(child, prefix === "" ? key : `${prefix}.${key}`),
  );
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  return Object.values(value as Record<string, unknown>).flatMap(strings);
}

test("both locales expose exactly the same copy, key for key", () => {
  const zh = keyPaths(getUi("zh-CN")).sort();
  const en = keyPaths(getUi("en")).sort();
  // Set difference rather than deepEqual so a failure names the missing key
  // instead of printing 283 lines in two columns.
  assert.deepEqual(zh.filter((key) => !en.includes(key)), [], "keys present in zh-CN but missing in en");
  assert.deepEqual(en.filter((key) => !zh.includes(key)), [], "keys present in en but missing in zh-CN");
});

test("no copy claims that authentication or the social features are unimplemented", () => {
  // The features these sentences denied exist: `/api/auth/*` serves sign-in,
  // sign-out, refresh, verification and recovery; follows, notifications and
  // messages have their own routes. A page may still say a *feature is coming*,
  // but it must not tell a reader that the platform has no accounts at all.
  const denials = [/not implemented/i, /尚未[^，。]*实现/, /will be connected once the backend is ready/i, /后端就绪后再?接入/];
  for (const locale of ["zh-CN", "en"] as const) {
    for (const sentence of strings(getUi(locale))) {
      for (const denial of denials) {
        assert.doesNotMatch(
          sentence,
          denial,
          `${locale} copy still claims a shipped feature is missing: ${sentence}`,
        );
      }
    }
  }
});
