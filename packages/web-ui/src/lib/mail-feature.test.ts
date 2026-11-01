import assert from "node:assert/strict";
import test from "node:test";
import { MAIL_DISABLED_NOTICE } from "./mail-copy.ts";
import { isMailEnabled } from "./mail-feature.ts";

/**
 * The mail switch as the Web tier reads it.
 *
 * The API has the same rule in `apps/api/src/application/identity-mailer.ts`
 * with its own test; these assertions are what would fail if the two ever
 * disagreed about what `MAIL_ENABLED` means.
 */
test("mail is off unless the operator turns it on", () => {
  assert.equal(isMailEnabled({}), false, "unset means off: a site with no relay must not promise mail");
  // A typo, an empty value and a plain negation must all land on "off".
  for (const value of ["", "   ", "false", "0", "no", "off", "TRUEish", "yes please", "enabled"]) {
    assert.equal(isMailEnabled({ MAIL_ENABLED: value }), false, `MAIL_ENABLED=${JSON.stringify(value)} must leave mail off`);
  }
  // A trailing newline or tab is what a hand-edited `.env` file actually
  // contains, so surrounding space is trimmed rather than read as part of the
  // value.
  for (const value of ["true", "TRUE", "True", " true ", "1", "yes", "YES", "on", "ON", "true\n", "\tyes\t"]) {
    assert.equal(isMailEnabled({ MAIL_ENABLED: value }), true, `MAIL_ENABLED=${JSON.stringify(value)} must switch mail on`);
  }
  assert.equal(isMailEnabled({ MAIL_ENABLED: undefined }), false);
});

test("the disabled notice is one copy, not one per page", () => {
  // Every surface that hides a mail feature says the same thing, so the wording
  // lives here instead of being retyped — and re-translated — in three places.
  assert.match(MAIL_DISABLED_NOTICE.body, /未验证邮箱也可以登录/);
  assert.match(MAIL_DISABLED_NOTICE.bodyEn, /unverified address can sign in/);
  for (const [key, value] of Object.entries(MAIL_DISABLED_NOTICE)) {
    assert.equal(typeof value, "string", `${key} must be copy, not markup`);
    assert.ok(value.length > 0, `${key} must not be empty`);
  }
});
