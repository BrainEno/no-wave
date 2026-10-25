import assert from "node:assert/strict";
import test from "node:test";
import { createSqliteClient, runSqliteMigrations } from "./sqlite.mjs";
import { createSqliteProfileStore } from "./sqlite-profile-store.mjs";
import { ArticleInputError, ProfileInputError, ProfileNotFoundError } from "../domain/errors.mjs";

async function fixture() {
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  await runSqliteMigrations(db);
  return { db, store: createSqliteProfileStore(db) };
}
function profile(store, userId, displayName, options = {}) {
  return store.upsertAuthorProfile({ userId, displayName, ...options });
}

test("SQLite profile store upserts localized profiles and preserves omitted URLs", async () => {
  const { db, store } = await fixture();
  try {
    const first = profile(store, "author-1", "Ferdy", {
      bio: "Writer", locale: "en", avatarUrl: "/avatars/ferdy.png",
      websiteUrl: "https://example.com",
    });
    assert.equal(first.displayName, "Ferdy");
    assert.equal(first.avatarUrl, "/avatars/ferdy.png");
    assert.equal(first.websiteUrl, "https://example.com/");
    assert.equal(first.followerCount, 0);
    assert.equal(first.isFollowing, false);

    profile(store, "author-1", "费迪", { bio: "写作者", locale: "zh-CN" });
    const updated = profile(store, "author-1", "Ferdy Duke", { bio: "Updated", locale: "en" });
    assert.equal(updated.displayName, "Ferdy Duke");
    assert.equal(updated.avatarUrl, "/avatars/ferdy.png");
    assert.equal(updated.websiteUrl, "https://example.com/");
    assert.equal(store.getAuthorProfile({ userId: "author-1", locale: "zh-CN" }).displayName, "费迪");
    assert.equal(store.getAuthorProfile({ userId: "missing", locale: "en" }), null);
    assert.throws(() => store.getAuthorProfile({ userId: "author-1", locale: "ja" }), ArticleInputError);
  } finally {
    db.close();
  }
});

test("SQLite profile lookup falls back to traditional Chinese then other available locale", async () => {
  const { db, store } = await fixture();
  try {
    profile(store, "author-tw", "作者", { locale: "zh-TW" });
    assert.equal(store.getAuthorProfile({ userId: "author-tw", locale: "en" }).locale, "zh-TW");
    profile(store, "author-en", "Author", { locale: "en" });
    assert.equal(store.getAuthorProfile({ userId: "author-en", locale: "zh-CN" }).locale, "en");
  } finally {
    db.close();
  }
});

test("SQLite profile search validates inputs and returns follower metadata", async () => {
  const { db, store } = await fixture();
  try {
    profile(store, "author-1", "Alpha Author", { locale: "en" });
    profile(store, "author-2", "Beta Author", { locale: "en" });
    assert.equal(store.searchUsers({ query: "alpha", locale: "en" })[0].userId, "author-1");
    assert.throws(() => store.searchUsers({ query: "  " }), ProfileInputError);
    assert.throws(() => store.searchUsers({ query: "a", limit: 101 }), ProfileInputError);
    assert.throws(() => store.getAuthorProfile({ userId: "author-1", locale: "fr" }), ArticleInputError);
    assert.throws(() => profile(store, "author-3", "Bad URL", { avatarUrl: "//example.com/a" }), ProfileInputError);
    assert.throws(() => profile(store, "author-3", "Bad URL", { websiteUrl: "javascript:alert(1)" }), ProfileInputError);
  } finally {
    db.close();
  }
});

test("SQLite follows are idempotent, ordered, and create one notification per new follow", async () => {
  const { db, store } = await fixture();
  try {
    profile(store, "alice", "Alice", { locale: "en" });
    profile(store, "bob", "Bob", { locale: "en" });
    profile(store, "carol", "Carol", { locale: "en" });

    assert.equal(store.followUser({ actorId: "alice", targetUserId: "bob" }), true);
    assert.equal(store.followUser({ actorId: "alice", targetUserId: "bob" }), false);
    assert.equal(store.followUser({ actorId: "carol", targetUserId: "bob" }), true);
    assert.equal(store.getAuthorProfile({ userId: "bob", locale: "en", viewerId: "alice" }).followerCount, 2);
    assert.equal(store.getAuthorProfile({ userId: "bob", locale: "en", viewerId: "alice" }).isFollowing, true);
    assert.equal(store.getAuthorProfile({ userId: "alice", locale: "en", viewerId: "bob" }).isFollowing, true);
    assert.deepEqual(store.listFollowing({ userId: "alice", locale: "en" }).map((item) => item.userId), ["bob"]);
    assert.deepEqual(store.listFollowers({ userId: "bob", locale: "en" }).map((item) => item.userId).sort(), ["alice", "carol"]);
    assert.equal(db.prepare("SELECT count(*) AS n FROM notifications WHERE user_id = ?").get("bob").n, 2);

    assert.equal(store.unfollowUser({ actorId: "alice", targetUserId: "bob" }), true);
    assert.equal(store.unfollowUser({ actorId: "alice", targetUserId: "bob" }), false);
    assert.equal(store.getAuthorProfile({ userId: "bob", locale: "en", viewerId: "alice" }).followerCount, 1);
  } finally {
    db.close();
  }
});

test("SQLite follow rejects self-follow and unknown targets without partial writes", async () => {
  const { db, store } = await fixture();
  try {
    profile(store, "alice", "Alice", { locale: "en" });
    assert.throws(() => store.followUser({ actorId: "alice", targetUserId: "alice" }), ProfileInputError);
    assert.throws(() => store.unfollowUser({ actorId: "alice", targetUserId: "alice" }), ProfileInputError);
    assert.throws(() => store.followUser({ actorId: "alice", targetUserId: "missing" }), ProfileNotFoundError);
    assert.equal(db.prepare("SELECT count(*) AS n FROM user_follows").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM notifications").get().n, 0);
  } finally {
    db.close();
  }
});
