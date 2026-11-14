import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { integrityOptions, integrityProviders, notificationIntegrityFixture } from "./test-support/notification-integrity-fixture.ts";

for (const provider of integrityProviders) {
  test(`${provider}: toggling and setting a like share one lifetime notification without resurrecting unread state`, integrityOptions(provider), async (t) => {
    const f = await notificationIntegrityFixture(t, provider);
    const article = await f.work();
    const input = { slug: article.slug, locale: "en", actorId: "reader:with:delimiters" };
    assert.equal((await f.store.toggleArticleLike(input))!.likedByViewer, true);
    const [original] = await f.store.listNotifications({ actorId: article.authorId, limit: 100 });
    assert.ok(original);
    assert.equal(original.eventKey, `engagement:v1:like:${article.id}:${input.actorId}`);
    await f.store.markNotificationRead({ actorId: article.authorId, notificationId: original.id });
    const [read] = await f.store.listNotifications({ actorId: article.authorId, limit: 100 });
    assert.ok(read.readAt);
    for (let cycle = 0; cycle < 5; cycle += 1) {
      assert.equal((await f.store.setArticleLike({ ...input, liked: false }))!.likedByViewer, false);
      assert.equal((await f.store.setArticleLike({ ...input, liked: true }))!.likeCount, 1);
      assert.equal((await f.store.setArticleLike({ ...input, liked: true }))!.likeCount, 1);
      assert.equal((await f.store.toggleArticleLike(input))!.likedByViewer, false);
      assert.equal((await f.store.toggleArticleLike(input))!.likedByViewer, true);
    }
    assert.deepEqual(await f.store.listNotifications({ actorId: article.authorId, limit: 100 }), [read]);
    assert.equal(await f.store.getUnreadNotificationCount({ actorId: article.authorId }), 0);
    assert.equal((await f.store.getArticleLikeInfo(input))!.likeCount, 1);
  });

  test(`${provider}: like deduplication separates actors, works and recipients but not editions`, integrityOptions(provider), async (t) => {
    const f = await notificationIntegrityFixture(t, provider);
    const first = await f.work(), second = await f.work(), other = await f.work("another-author");
    await f.store.updateArticle({
      articleId: first.id, actorId: first.authorId, slug: first.slug, publish: true, locale: "zh-CN", title: "同一作品的译文",
      contentBlocks: [{ id: "body-zh", type: "paragraph", text: "正文。" }],
    });
    const input = { slug: first.slug, locale: "en", actorId: "reader-a" };
    await f.store.setArticleLike({ ...input, liked: true });
    await f.store.setArticleLike({ ...input, liked: false });
    await f.store.setArticleLike({ ...input, locale: "zh-CN", liked: true });
    await f.store.setArticleLike({ ...input, actorId: "reader-b", liked: true });
    await f.store.setArticleLike({ ...input, slug: second.slug, liked: true });
    await f.store.setArticleLike({ ...input, slug: other.slug, liked: true });
    await f.store.setArticleLike({ ...input, actorId: first.authorId, liked: true });
    const notifications = await f.store.listNotifications({ actorId: first.authorId, limit: 100 });
    assert.equal(notifications.length, 3, "self-like is silent; another actor and another work are distinct");
    assert.equal(await f.store.getUnreadNotificationCount({ actorId: first.authorId }), 3);
    assert.equal((await f.store.listNotifications({ actorId: other.authorId, limit: 100 })).length, 1);
    const firstPayload = notifications.find(row => row.eventKey === `engagement:v1:like:${first.id}:reader-a`)!.payload;
    assert.deepEqual(firstPayload, { type: "article.liked", articleId: first.id, slug: first.slug, actorId: "reader-a", locale: "en" });
  });

  test(`${provider}: repeated follows preserve one read notification per follower and recipient`, integrityOptions(provider), async (t) => {
    const f = await notificationIntegrityFixture(t, provider);
    await f.profile("author-a");
    await f.profile("author-b");
    const input = { actorId: "reader:one", targetUserId: "author-a" };
    assert.equal(await f.store.followUser(input), true);
    assert.equal(await f.store.followUser(input), false);
    const [original] = await f.store.listNotifications({ actorId: "author-a", limit: 100 });
    assert.equal(original.eventKey, "engagement:v1:follow:reader:one");
    await f.store.markNotificationRead({ actorId: "author-a", notificationId: original.id });
    const [read] = await f.store.listNotifications({ actorId: "author-a", limit: 100 });
    for (let cycle = 0; cycle < 5; cycle += 1) {
      assert.equal(await f.store.unfollowUser(input), true);
      assert.equal(await f.store.unfollowUser(input), false);
      assert.equal(await f.store.followUser(input), true);
    }
    assert.deepEqual(await f.store.listNotifications({ actorId: "author-a", limit: 100 }), [read]);
    assert.equal(await f.store.getUnreadNotificationCount({ actorId: "author-a" }), 0);
    await f.store.followUser({ ...input, actorId: "reader:two" });
    await f.store.followUser({ ...input, targetUserId: "author-b" });
    assert.equal((await f.store.listNotifications({ actorId: "author-a", limit: 100 })).length, 2);
    assert.equal((await f.store.listNotifications({ actorId: "author-b", limit: 100 })).length, 1);
    assert.equal((await f.store.getAuthorProfile({ userId: "author-a", locale: "en" }))!.followerCount, 2);
  });

  test(`${provider}: legacy randomized like keys suppress future notifications without rewriting history`, integrityOptions(provider), async (t) => {
    const f = await notificationIntegrityFixture(t, provider);
    const article = await f.work();
    const actorId = "legacy-reader";
    const payload = { type: "article.liked", articleId: article.id, slug: article.slug, actorId, locale: "en" };
    for (const suffix of [randomUUID(), randomUUID()]) {
      await f.store.createNotification({ userId: article.authorId, eventKey: `article.liked:${article.id}:${actorId}:${suffix}`, payload });
    }
    await f.store.markAllNotificationsRead({ actorId: article.authorId });
    const history = await f.store.listNotifications({ actorId: article.authorId, limit: 100 });
    const input = { slug: article.slug, locale: "en", actorId };
    await f.store.toggleArticleLike(input);
    await f.store.toggleArticleLike(input);
    await f.store.setArticleLike({ ...input, liked: true });
    assert.deepEqual(await f.store.listNotifications({ actorId: article.authorId, limit: 100 }), history);
    assert.equal(await f.store.getUnreadNotificationCount({ actorId: article.authorId }), 0);
    await f.store.setArticleLike({ ...input, actorId: "a-new-reader", liked: true });
    assert.equal((await f.store.listNotifications({ actorId: article.authorId, limit: 100 })).length, 3);
    assert.equal(await f.store.getUnreadNotificationCount({ actorId: article.authorId }), 1);
  });

  test(`${provider}: legacy follow notifications are recognized by payload, never by splitting actor IDs`, integrityOptions(provider), async (t) => {
    const f = await notificationIntegrityFixture(t, provider);
    await f.profile("legacy-target");
    const actorId = `legacy:${randomUUID()}:actor`;
    await f.store.createNotification({
      userId: "legacy-target", eventKey: `user.followed:${actorId}:${randomUUID()}`,
      payload: { type: "user.followed", followerId: actorId },
    });
    await f.store.markAllNotificationsRead({ actorId: "legacy-target" });
    const history = await f.store.listNotifications({ actorId: "legacy-target", limit: 100 });
    await f.store.followUser({ actorId, targetUserId: "legacy-target" });
    await f.store.unfollowUser({ actorId, targetUserId: "legacy-target" });
    await f.store.followUser({ actorId, targetUserId: "legacy-target" });
    assert.deepEqual(await f.store.listNotifications({ actorId: "legacy-target", limit: 100 }), history);
    await f.store.followUser({ actorId: "different-actor", targetUserId: "legacy-target" });
    assert.equal(await f.store.getUnreadNotificationCount({ actorId: "legacy-target" }), 1);
  });

  test(`${provider}: a different opaque actor cannot collide with a legacy random-key suffix`, integrityOptions(provider), async (t) => {
    const f = await notificationIntegrityFixture(t, provider);
    const article = await f.work();
    await f.profile(article.authorId);
    const previousActor = "previous-reader", suffix = randomUUID();
    const currentActor = `${previousActor}:${suffix}`;
    await f.store.createNotification({ userId: article.authorId, eventKey: `article.liked:${article.id}:${previousActor}:${suffix}`,
      payload: { type: "article.liked", articleId: article.id, slug: article.slug, actorId: previousActor, locale: "en" } });
    await f.store.createNotification({ userId: article.authorId, eventKey: `user.followed:${previousActor}:${suffix}`,
      payload: { type: "user.followed", followerId: previousActor } });
    await f.store.markAllNotificationsRead({ actorId: article.authorId });
    await f.store.setArticleLike({ slug: article.slug, locale: "en", actorId: currentActor, liked: true });
    await f.store.followUser({ actorId: currentActor, targetUserId: article.authorId });
    const rows = await f.store.listNotifications({ actorId: article.authorId, limit: 100 });
    assert.equal(rows.length, 4, "a new business identity must not be silently discarded by a legacy event-key collision");
    assert.equal(await f.store.getUnreadNotificationCount({ actorId: article.authorId }), 2);
    assert.equal(rows.filter(row => row.readAt).length, 2, "old notices keep their read state");
  });

  test(`${provider}: simultaneous like setters and follow requests cannot race notification uniqueness`, integrityOptions(provider), async (t) => {
    const f = await notificationIntegrityFixture(t, provider);
    const article = await f.work();
    await f.profile(article.authorId);
    await Promise.all(Array.from({ length: 8 }, () => f.store.setArticleLike({ slug: article.slug, locale: "en", actorId: "racing-reader", liked: true })));
    await Promise.all(Array.from({ length: 8 }, () => f.store.followUser({ actorId: "racing-reader", targetUserId: article.authorId })));
    assert.equal((await f.store.getArticleLikeInfo({ slug: article.slug, locale: "en" }))!.likeCount, 1);
    const rows = await f.store.listNotifications({ actorId: article.authorId, limit: 100 });
    assert.deepEqual(rows.map(row => row.eventKey).sort(), [`engagement:v1:like:${article.id}:racing-reader`, "engagement:v1:follow:racing-reader"].sort());
    assert.equal(await f.store.getUnreadNotificationCount({ actorId: article.authorId }), 2);
  });
}
