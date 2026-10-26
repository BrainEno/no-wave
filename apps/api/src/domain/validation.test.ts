import test from "node:test";
import assert from "node:assert/strict";
import { isUuid, requiredText } from "./validation.ts";
import { normalizeParticipantIds } from "./conversation.ts";
import { validateProfileUrl } from "./profile.ts";

test("common validation helpers enforce text and ID formats", () => {
  assert.equal(isUuid("bdb4ec86-22d3-4eaf-96db-34b7b5a63bb8"), true);
  assert.equal(isUuid("nope"), false);
  assert.equal(requiredText("name", "name"), "name");
  assert.throws(() => requiredText("name", "  "), { code: "BAD_USER_INPUT" });
});

test("conversation participants reject duplicate IDs and malformed entries", () => {
  assert.deepEqual(normalizeParticipantIds("participantIds", ["user-1", "user-2"]), ["user-1", "user-2"]);
  assert.throws(() => normalizeParticipantIds("participantIds", ["user-1", "user-1"]), { code: "BAD_USER_INPUT" });
  assert.throws(() => normalizeParticipantIds("participantIds", [" "]), { code: "BAD_USER_INPUT" });
});

test("profile URLs allow safe relative avatar paths but disallow executable schemes", () => {
  assert.equal(validateProfileUrl("avatarUrl", "/avatars/me.webp", true), "/avatars/me.webp");
  assert.equal(validateProfileUrl("websiteUrl", "https://example.test/profile", false), "https://example.test/profile");
  assert.throws(() => validateProfileUrl("avatarUrl", "javascript:alert(1)", true), { code: "BAD_USER_INPUT" });
});
