import assert from "node:assert/strict";
import test from "node:test";
import {
  assertConversationParticipant,
  assertResourceOwner,
  AuthorizationError,
  requireAuthenticatedActor,
  resolveMessageSender,
} from "./authorization.mjs";

test("rejects missing or malformed authenticated identity", () => {
  for (const context of [undefined, null, {}, { user: {} }, { user: { id: "" } }, { user: { id: 42 } }, { user: { id: " user-a" } }]) {
    assert.throws(
      () => requireAuthenticatedActor(context),
      (error) => error instanceof AuthorizationError && error.code === "UNAUTHENTICATED",
    );
  }
});

test("uses server-authenticated identity rather than a client sender ID", () => {
  const context = { user: { id: "trusted-user" }, input: { senderId: "victim-user" } };
  assert.equal(resolveMessageSender(context), "trusted-user");
});

test("allows an owner and denies another user's resource mutation", () => {
  assert.equal(assertResourceOwner("user-a", "user-a"), undefined);
  assert.throws(
    () => assertResourceOwner("user-b", "user-a"),
    (error) => error instanceof AuthorizationError && error.code === "FORBIDDEN",
  );
});

test("denies missing or malformed owner identity rather than failing open", () => {
  for (const ownerId of [undefined, "", " user-a", 42]) {
    assert.throws(
      () => assertResourceOwner("user-a", ownerId),
      (error) => error instanceof AuthorizationError && error.code === "FORBIDDEN",
    );
  }
});

test("allows a conversation participant and denies a non-participant", () => {
  assert.equal(assertConversationParticipant("user-a", ["user-a", "user-b"]), undefined);
  assert.throws(
    () => assertConversationParticipant("outsider", ["user-a", "user-b"]),
    (error) => error instanceof AuthorizationError && error.code === "FORBIDDEN",
  );
});

test("denies malformed participant lists by default", () => {
  for (const participantIds of [undefined, [], ["user-a", 42], [" user-a"]]) {
    assert.throws(
      () => assertConversationParticipant("user-a", participantIds),
      (error) => error instanceof AuthorizationError && error.code === "FORBIDDEN",
    );
  }
});
