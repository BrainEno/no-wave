import assert from "node:assert/strict";
import test from "node:test";
import { matchRestPaths } from "./rest-route-match.ts";

test("route matcher recognizes authenticated and article route shapes without overlapping item routes", () => {
  const auth = matchRestPaths("/api/v1/auth/login");
  assert.equal(auth.identityRoute?.[1], "login");

  const collection = matchRestPaths("/api/v1/articles");
  assert.equal(collection.articleItemPath, false);
  assert.equal(collection.articleMatch, null);

  const item = matchRestPaths("/api/v1/articles/a-valid-slug");
  assert.equal(item.articleItemPath, true);
  assert.equal(item.articleMatch?.[1], "a-valid-slug");
  assert.equal(item.articleCommentsPathMatch, null);

  const comments = matchRestPaths("/api/v1/articles/a-valid-slug/comments");
  assert.equal(comments.articleCommentsPathMatch?.[1], "a-valid-slug");
  assert.equal(comments.articleItemPath, false);

  const related = matchRestPaths("/api/v1/articles/a-valid-slug/related");
  assert.equal(related.relatedArticlesMatch?.[1], "a-valid-slug");
  assert.equal(related.articleMatch, null);
});

test("route matcher keeps exact paths distinct and rejects near matches", () => {
  assert.equal(matchRestPaths("/api/v1/me").mePath, true);
  assert.equal(matchRestPaths("/api/v1/me/").mePath, false);
  assert.equal(matchRestPaths("/api/v1/me/profile").meProfilePath, true);
  assert.equal(matchRestPaths("/api/v1/me/profiles").meProfilePath, false);
  assert.equal(matchRestPaths("/api/v1/conversations").conversationsPath, true);
  assert.equal(matchRestPaths("/api/v1/conversations/one/messages").conversationMessagesMatch?.[1], "one");
  assert.equal(matchRestPaths("/api/v1/tags/one/articles").tagArticlesMatch?.[1], "one");
  assert.equal(matchRestPaths("/api/v1/not-a-route").identityRoute, null);
});
