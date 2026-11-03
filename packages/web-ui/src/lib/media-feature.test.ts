import assert from "node:assert/strict";
import test from "node:test";
import { isMediaDeleteEnabled } from "./media-feature.ts";

/**
 * The media-deletion switch as the Web tier reads it.
 *
 * The API has the same rule in `apps/api/src/application/media-assets.ts`
 * (`isMediaDeleteEnabled`) with its own test; these assertions are what would
 * fail if the two ever disagreed about what `MEDIA_DELETE_ENABLED` means.
 */
test("media deletion is off unless the operator turns it on", () => {
  assert.equal(isMediaDeleteEnabled({}), false, "unset means off: configuring storage must not permit destroying bytes");
  for (const value of ["", "   ", "false", "0", "no", "off", "TRUEish", "yes please", "enabled", "ture"]) {
    assert.equal(isMediaDeleteEnabled({ MEDIA_DELETE_ENABLED: value }), false, `MEDIA_DELETE_ENABLED=${JSON.stringify(value)} must leave deletion off`);
  }
  // A hand-edited .env file carries stray whitespace; it is trimmed, not read as
  // part of the value.
  for (const value of ["true", "TRUE", "True", " true ", "1", "yes", "YES", "on", "ON", "true\n", "\tyes\t"]) {
    assert.equal(isMediaDeleteEnabled({ MEDIA_DELETE_ENABLED: value }), true, `MEDIA_DELETE_ENABLED=${JSON.stringify(value)} must switch deletion on`);
  }
  assert.equal(isMediaDeleteEnabled({ MEDIA_DELETE_ENABLED: undefined }), false);
});
