import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

/**
 * Regression for #198 (私信, read side).
 *
 * The states that matter are the ones that look alike on screen:
 *
 *   - `401` (signed out) versus `[]` (no conversations) — different statements
 *     about the reader, and an empty list is a claim about their inbox.
 *   - `404`/`403` (not yours to read) versus a failed read — one is an answer,
 *     the other invites a retry. A retry button on an answer tells the reader
 *     to keep trying something that will never work.
 *
 * Every assertion that claims "this branch does X" slices that branch. Two
 * previous parts shipped guards that searched the whole file and passed while
 * the branch was broken; the whole point is to not do that a third time.
 */

const inboxPath = new URL("../components/public/messages-view.tsx", import.meta.url);
const threadPath = new URL("../components/public/thread-view.tsx", import.meta.url);
const tablePath = new URL("../../../../apps/web-rr/app/routes.ts", import.meta.url);

/** The body of `if (<predicate>) { ... }`, up to its first `return;`. */
function branchBody(source: string, predicate: string): string {
  const start = source.indexOf(predicate);
  assert.ok(start > 0, `branch not found: ${predicate}`);
  const end = source.indexOf("return;", start);
  assert.ok(end > start, `branch has no early return: ${predicate}`);
  return source.slice(start, end);
}

test("the inbox is wired and fetched by the browser", async () => {
  const source = await readFile(inboxPath, "utf8");
  assert.match(source, /fetch\(`\/api\/inbox\?limit=/);
  assert.match(source, /credentials: "same-origin"/, "the cookie is the identity");
  assert.ok(!/useLoaderData/.test(source), "the list must not arrive pre-rendered");
});

test("the inbox separates signed-out from empty", async () => {
  const source = await readFile(inboxPath, "utf8");
  const unauthorised = branchBody(source, "if (response.status === 401)");
  assert.match(unauthorised, /kind: "signed-out"/);
  assert.ok(!/rows: \[\]/.test(unauthorised), "a 401 must never become an empty inbox");

  const failed = branchBody(source, "if (!response.ok)");
  assert.match(failed, /kind: "failed"/);
  assert.ok(!/rows: \[\]/.test(failed), "a broken read must not become an empty inbox");

  assert.match(source, /state\.rows\.length === 0/, "the empty case is its own branch");
});

test("an unread count is shown only when it is positive", async () => {
  const source = await readFile(inboxPath, "utf8");
  // "0 unread" on every row is noise, and it also hides the rows that matter.
  assert.match(source, /row\.unreadCount > 0 \?/);
  assert.match(source, /ui\.unread\(row\.unreadCount\)/);
});

test("the inbox shows the other participant, not yourself", async () => {
  const source = await readFile(inboxPath, "utf8");
  assert.match(source, /participantIds\.filter\(\(id\) => id !== viewerId\)/);
  assert.match(source, /ui\.you/, "an empty other side falls back to 'you' rather than a blank");
});

test("a conversation you cannot read is an answer, not a failure", async () => {
  const source = await readFile(threadPath, "utf8");
  // 404 and 403 both mean "not yours to read". Neither is transient, so neither
  // may render the retry button — that would tell the reader to keep trying
  // something that will never succeed.
  const notFound = branchBody(source, "if (response.status === 404 || response.status === 403)");
  assert.match(notFound, /kind: "missing"/);
  assert.ok(!/kind: "failed"/.test(notFound));

  const missingStart = source.indexOf('if (state.kind === "missing")');
  assert.ok(missingStart > 0, "missing has its own render branch");
  const missingBlock = source.slice(missingStart, source.indexOf('if (state.kind === "failed")'));
  assert.ok(!/nw-thread-btn/.test(missingBlock), "no retry button on an answer");
  assert.ok(!/ui\.threadFailed/.test(missingBlock), "and it does not claim a failure");

  // The failed branch, by contrast, does offer a retry.
  const failedStart = source.indexOf('if (state.kind === "failed")');
  const failedBlock = source.slice(failedStart, source.indexOf('if (state.messages.length === 0)'));
  assert.match(failedBlock, /nw-thread-btn/);
  assert.match(failedBlock, /ui\.threadFailed/);
});

test("the thread separates signed-out from missing from failed", async () => {
  const source = await readFile(threadPath, "utf8");
  const unauthorised = branchBody(source, "if (response.status === 401)");
  assert.match(unauthorised, /kind: "signed-out"/);
  for (const kind of ['kind: "loading"', 'kind: "signed-out"', 'kind: "missing"', 'kind: "ready"', 'kind: "failed"']) {
    assert.ok(source.includes(kind), `${kind} must exist as a distinct state`);
  }
});

test("paging walks backwards with the cursor the API gave", async () => {
  const source = await readFile(threadPath, "utf8");
  // The API returns the newest page and takes `before` for older ones, so
  // "older" prepends and the cursor is the first message of the page just read.
  assert.match(source, /load\(state\.cursor, true\)/);
  assert.match(source, /\[\.\.\.page, \.\.\.previous\.messages\]/, "older messages go on top");
  assert.match(source, /cursor: page\[0\]\?\.id/, "the cursor is the oldest message in hand");
  assert.match(source, /more: page\.length === PAGE_SIZE/, "a short page is the start of the conversation");
});

test("an absent cursor is not sent as an empty one", async () => {
  const source = await readFile(threadPath, "utf8");
  // `before=` would ask the API to decode an empty string and answer 400, which
  // looks like a client bug rather than the absent cursor it is.
  assert.match(source, /before === null \? "" : `&before=/);
});

test("a malformed page is a failed read, not an empty conversation", async () => {
  const source = await readFile(threadPath, "utf8");
  assert.match(source, /if \(data\.length > 0 && messages\.length === 0\) return null;/);
  const branch = branchBody(source, "if (page === null)");
  assert.match(branch, /kind: "failed"/);
});

test("the inbox and thread routes are wired, and so are the resource routes", async () => {
  const table = await readFile(tablePath, "utf8");
  for (const entry of [
    'route("api/inbox", "routes/api.inbox.ts")',
    'route("api/inbox/:id", "routes/api.inbox.$id.ts")',
    'route("api/inbox/:id/messages", "routes/api.inbox.$id.messages.ts")',
    'route("messages", "routes/messages.tsx")',
    'route("en/messages", "routes/messages.tsx", { id: "en-messages" })',
    'route("messages/:id", "routes/messages.$id.tsx")',
  ]) {
    assert.ok(table.includes(entry), `missing route table entry: ${entry}`);
  }
});

test("the UI language covers 私信 in both locales", async () => {
  const copy = await readFile(new URL("./ui-copy.ts", import.meta.url), "utf8");
  for (const key of ["eyebrow:", "empty:", "signIn:", "failed:", "conversationMissing:", "threadEmpty:", "older:", "oldest:"]) {
    const occurrences = copy.split(key).length - 1;
    assert.ok(occurrences >= 2, `${key} needs a zh and an en form, saw ${occurrences}`);
  }
});
