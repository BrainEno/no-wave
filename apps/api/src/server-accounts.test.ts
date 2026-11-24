/** Profiles, follows, the following feed, roles, the featured shelf, devices, password change and session revocation. Split from server.test.ts (#357). */
import assert from "node:assert/strict";
import test from "node:test";
import { ArticleAuthorizationError, ProfileInputError, ProfileNotFoundError } from "./domain/errors.ts";
import { hashPassword, verifyPassword } from "./security/passwords.ts";
import { authEnv, signedToken, withServer } from "./test-support/rest-server-harness.ts";





test("REST current user and profile reads require JWT and preserve all AuthorProfile fields", async () => {
  const profile = {
    userId: "me-user", displayName: "作者", bio: "个人简介",
    avatarUrl: "/media/avatar.png", websiteUrl: "https://example.test/",
    locale: "zh-CN", createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-02-01T00:00:00.000Z", followerCount: 7,
    followingCount: 4, isFollowing: true,
  };
  await withServer(async (baseUrl) => {
    const me = await fetch(baseUrl + "/api/v1/me", {
      headers: { authorization: "Bearer " + signedToken("me-user") },
    });
    assert.equal(me.status, 200);
    // `isEditor` is the assembled fact: the role column for a plain account, and
    // the bootstrap list for the account that has to mint the first editor.
    assert.deepEqual(await me.json(), {
      data: { id: "me-user", email: "me-user@example.test", emailVerifiedAt: null, isEditor: false },
    });
    const curator = await fetch(baseUrl + "/api/v1/me", {
      headers: { authorization: "Bearer " + signedToken("curator-user") },
    });
    assert.deepEqual(await curator.json(), {
      data: { id: "curator-user", email: "curator-user@example.test", emailVerifiedAt: null, isEditor: true },
    });

    const profileResponse = await fetch(baseUrl + "/api/v1/me/profile?locale=zh-CN", {
      headers: { authorization: "Bearer " + signedToken("me-user") },
    });
    assert.equal(profileResponse.status, 200);
    assert.deepEqual(await profileResponse.json(), { data: profile });
  }, {
    env: { ...authEnv, EDITOR_USER_IDS: "curator-user" },
    store: {
      async isSessionRevoked() { return false; },
      async findIdentityAccountByUserId({ userId }) {
        return { userId, email: `${userId}@example.test`, emailVerifiedAt: null };
      },
      async getUserRole() { return "member"; },
      async getAuthorProfile(args) {
        assert.deepEqual(args, { userId: "me-user", locale: "zh-CN", viewerId: "me-user" });
        return profile;
      },
    },
  });
});

test("REST user search and relationship lists preserve complete author fields", async () => {
  const calls = [];
  const profile = {
    userId: "target-user", displayName: "作者甲", bio: "简介",
    avatarUrl: null, websiteUrl: null, locale: "zh-CN",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
    followerCount: 5, followingCount: 2, isFollowing: false,
  };
  await withServer(async (baseUrl) => {
    const search = await fetch(baseUrl + "/api/v1/users?query=%E4%BD%9C%E8%80%85&limit=7&locale=zh-CN", {
      headers: { authorization: "Bearer " + signedToken("viewer-user") },
    });
    assert.equal(search.status, 200);
    assert.deepEqual(await search.json(), { data: [profile] });
    assert.deepEqual(calls[0], ["search", { query: "作者", locale: "zh-CN", limit: 7, viewerId: "viewer-user" }]);

    for (const relation of ["followers", "following"]) {
      const response = await fetch(baseUrl + "/api/v1/users/target-user/" + relation + "?limit=9", {
        headers: { authorization: "Bearer " + signedToken("viewer-user") },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { data: [profile] });
    }
    assert.deepEqual(calls[1], ["followers", { userId: "target-user", locale: "zh-CN", limit: 9, viewerId: "viewer-user" }]);
    assert.deepEqual(calls[2], ["following", { userId: "target-user", locale: "zh-CN", limit: 9, viewerId: "viewer-user" }]);
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async searchUsers(args) { calls.push(["search", args]); return [profile]; },
      async listFollowers(args) { calls.push(["followers", args]); return [profile]; },
      async listFollowing(args) { calls.push(["following", args]); return [profile]; },
    },
  });
});

test("REST liked articles, related articles, and article like info are available", async () => {
  const calls = [];
  const writerProfile = {
    userId: "writer-user", displayName: "作者", bio: "简介", avatarUrl: "/avatar.png",
    websiteUrl: "https://writer.example/", locale: "zh-CN",
    createdAt: "2025-12-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    followerCount: 4, followingCount: 3, isFollowing: true,
  };
  const category = { id: "category-1", kind: "category", slug: "poetry", name: "诗歌", description: "", locale: "zh-CN", createdBy: "admin-user", articleCount: 2 };
  const tag = { id: "tag-1", kind: "tag", slug: "modern-poetry", name: "现代诗", description: "", locale: "zh-CN", createdBy: "writer-user", articleCount: 7 };
  const article = {
    id: "article-1", authorId: "writer-user", slug: "poetry-work", workType: "poetry",
    status: "published", locale: "zh-CN", title: "诗", summary: "摘要",
    contentBlocks: [{ id: "p1", type: "paragraph", text: "正文" }],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
    publishedAt: "2026-01-02T00:00:00.000Z", author: writerProfile, categories: [category], tags: [tag],
  };
  const likeInfo = { articleId: "article-1", slug: "poetry-work", likeCount: 12, likedByViewer: true };
  await withServer(async (baseUrl) => {
    const liked = await fetch(baseUrl + "/api/v1/me/liked-articles?limit=8", {
      headers: { authorization: "Bearer " + signedToken("reader-user") },
    });
    assert.equal(liked.status, 200);
    assert.deepEqual(await liked.json(), { data: [article] });
    assert.deepEqual(calls[0], ["liked", { actorId: "reader-user", locale: "zh-CN", limit: 8 }]);

    const related = await fetch(baseUrl + "/api/v1/articles/poetry-work/related?limit=4", {
      headers: { authorization: "Bearer " + signedToken("reader-user") },
    });
    assert.equal(related.status, 200);
    assert.deepEqual(await related.json(), { data: [article] });
    assert.deepEqual(calls[1], ["related", { slug: "poetry-work", locale: "zh-CN", limit: 4 }]);

    const like = await fetch(baseUrl + "/api/v1/articles/poetry-work/like", {
      headers: { authorization: "Bearer " + signedToken("reader-user") },
    });
    assert.equal(like.status, 200);
    assert.deepEqual(await like.json(), { data: likeInfo });
    assert.deepEqual(calls[2], ["like", { slug: "poetry-work", locale: "zh-CN", actorId: "reader-user" }]);
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async listLikedArticles(args) { calls.push(["liked", args]); return [article]; },
      async listRelatedArticles(args) { calls.push(["related", args]); return [article]; },
      async getAuthorProfile(args) { return { ...writerProfile, isFollowing: args.viewerId === "reader-user" }; },
      async getAuthorProfilesByIds({ userIds, locale, viewerId }) {
        return Object.fromEntries(userIds.map((userId) => [userId, { ...writerProfile, locale, isFollowing: viewerId === "reader-user" }]));
      },
      async listArticleTaxonomies(args) { return args.kind === "category" ? [category] : [tag]; },
      async listArticlesTaxonomies({ articleIds, kind }) {
        const rows = kind === "category" ? [category] : [tag];
        return Object.fromEntries(articleIds.map((articleId) => [articleId, rows]));
      },
      async getArticleLikeInfo(args) { calls.push(["like", args]); return likeInfo; },
    },
  });
});

test("REST following feed requires a session and reads only what the viewer follows", async () => {
  const calls = [];
  const writerProfile = {
    userId: "writer-user", displayName: "作者", bio: "简介", avatarUrl: null,
    websiteUrl: null, locale: "zh-CN",
    createdAt: "2025-12-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    followerCount: 4, followingCount: 3, isFollowing: true,
  };
  const article = {
    id: "article-1", authorId: "writer-user", slug: "followed-work", workType: "other",
    status: "published", locale: "zh-CN", title: "关注的新作", summary: "摘要",
    contentBlocks: [{ id: "p1", type: "paragraph", text: "正文" }],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
    publishedAt: "2026-01-02T00:00:00.000Z", author: writerProfile, categories: [], tags: [],
    likeCount: 3, likedByViewer: false,
  };
  await withServer(async (baseUrl) => {
    // A feed is personal: without a session there is nothing to render, not the public one.
    const anonymous = await fetch(baseUrl + "/api/v1/me/feed");
    assert.equal(anonymous.status, 401);

    const headers = { authorization: "Bearer " + signedToken("reader-user") };
    const badLocale = await fetch(baseUrl + "/api/v1/me/feed?locale=nope", { headers });
    assert.equal(badLocale.status, 400);
    const badLimit = await fetch(baseUrl + "/api/v1/me/feed?limit=0", { headers });
    assert.equal(badLimit.status, 400);
    const badOffset = await fetch(baseUrl + "/api/v1/me/feed?offset=100001", { headers });
    assert.equal(badOffset.status, 400);
    assert.deepEqual(calls, []);

    const feed = await fetch(baseUrl + "/api/v1/me/feed?limit=5&offset=10", { headers });
    assert.equal(feed.status, 200);
    assert.deepEqual(await feed.json(), { data: [article] });
    assert.deepEqual(calls, [{ actorId: "reader-user", locale: "zh-CN", limit: 5, offset: 10 }]);

    const wrongMethod = await fetch(baseUrl + "/api/v1/me/feed", { method: "DELETE" });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "GET");
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async listFollowingArticles(args) { calls.push(args); return [article]; },
      async getAuthorProfile() { return writerProfile; },
      async getAuthorProfilesByIds({ userIds }) {
        return Object.fromEntries(userIds.map((userId) => [userId, writerProfile]));
      },
      async listArticleTaxonomies() { return []; },
      async listArticlesTaxonomies({ articleIds }) {
        return Object.fromEntries(articleIds.map((articleId) => [articleId, []]));
      },
      async getArticleLikeInfo() { return { articleId: "article-1", slug: "followed-work", likeCount: 3, likedByViewer: false }; },
    },
  });
});

test("REST article discovery accepts sort=popular and rejects an unknown sort", async () => {
  const calls = [];
  const profile = {
    userId: "some-author", displayName: "作者", bio: "", avatarUrl: null, websiteUrl: null,
    locale: "zh-CN", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    followerCount: 0, followingCount: 0, isFollowing: false,
  };
  await withServer(async (baseUrl) => {
    const popular = await fetch(baseUrl + "/api/v1/articles?sort=popular&limit=7&offset=2");
    assert.equal(popular.status, 200);
    assert.deepEqual(await popular.json(), { data: [] });
    assert.deepEqual(calls[0], { locale: "zh-CN", query: "", sort: "popular", limit: 7, offset: 2 });

    // Omitted, the historical order is unchanged: newest first.
    const latest = await fetch(baseUrl + "/api/v1/articles");
    assert.equal(latest.status, 200);
    assert.deepEqual(calls[1], { locale: "zh-CN", query: "", sort: "latest", limit: 20, offset: 0 });

    const bogus = await fetch(baseUrl + "/api/v1/articles?sort=hottest");
    assert.equal(bogus.status, 400);

    // The author listing shares the same parameter.
    const byAuthor = await fetch(baseUrl + "/api/v1/authors/some-author/articles?sort=popular&limit=3");
    assert.equal(byAuthor.status, 200);
    assert.deepEqual(calls[2], { authorId: "some-author", locale: "zh-CN", query: "", sort: "popular", limit: 3, offset: 0 });
    const authorBogus = await fetch(baseUrl + "/api/v1/authors/some-author/articles?sort=hottest");
    assert.equal(authorBogus.status, 400);
    assert.equal(calls.length, 3);
  }, {
    env: authEnv,
    store: {
      async listPublishedArticles(args) { calls.push(args); return []; },
      async getAuthorProfile() { return profile; },
    },
  });
});

/**
 * `sort=popular` has no cursor to fall back on, so the page it may be asked for
 * is bounded; `sort=latest` does have one and keeps the deeper ceiling
 * (audit F-23). The refusal names the ceiling and the way out, because "Invalid
 * offset query parameter" would send a client to retry the same page.
 */
test("REST article discovery stops the most-saved order at its ceiling and says how to page deeper", async () => {
  const calls = [];
  const profile = {
    userId: "some-author", displayName: "作者", bio: "", avatarUrl: null, websiteUrl: null,
    locale: "zh-CN", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    followerCount: 0, followingCount: 0, isFollowing: false,
  };
  await withServer(async (baseUrl) => {
    const deepPopular = await fetch(baseUrl + "/api/v1/articles?sort=popular&offset=10001");
    assert.equal(deepPopular.status, 400);
    const refusal = (await deepPopular.json()).error.message;
    assert.match(refusal, /offset is limited to 10000 with sort=popular/);
    assert.match(refusal, /sort=latest and a cursor/, "the refusal has to name the way to page that deep");

    // The same depth is still offered newest-first, and the newest-first ceiling
    // is unchanged.
    const deepLatest = await fetch(baseUrl + "/api/v1/articles?offset=10001");
    assert.equal(deepLatest.status, 200);
    assert.deepEqual(calls[0], { locale: "zh-CN", query: "", sort: "latest", limit: 20, offset: 10001 });
    assert.equal((await fetch(baseUrl + "/api/v1/articles?offset=100001")).status, 400);

    // An author's work list is the same list, so it states the same ceiling...
    const authorDeep = await fetch(baseUrl + "/api/v1/authors/some-author/articles?sort=popular&offset=10001");
    assert.equal(authorDeep.status, 400);
    assert.match((await authorDeep.json()).error.message, /sort=popular/);
    // ...and a genuinely malformed parameter still gets the parameter error.
    const bogus = await fetch(baseUrl + "/api/v1/authors/some-author/articles?sort=hottest&offset=10001");
    assert.equal(bogus.status, 400);
    assert.match((await bogus.json()).error.message, /Invalid author user ID, locale/);
    assert.equal(calls.length, 1, "a refused page never reaches the store");
  }, {
    env: authEnv,
    store: {
      async listPublishedArticles(args) { calls.push(args); return []; },
      async getAuthorProfile() { return profile; },
    },
  });
});

/**
 * A cursor is a place in one order, and `sort=popular` has none (F-23's other
 * half).
 *
 * The store already refuses the combination, but it refuses from *inside* a
 * query, which the transport can only report as the generic "The request input
 * is invalid." The reader who sent it learns nothing: the message does not say
 * which of six parameters is wrong, and it does not say that the same page is
 * available newest-first. So the check moved to the parser, where the reason is
 * known — and where a refused page never reaches the store, the same rule the
 * offset ceiling follows.
 */
test("a cursor with sort=popular is a named 400, not an exception from the store", async () => {
  const calls = [];
  const profile = {
    userId: "some-author", displayName: "作者", bio: "", avatarUrl: null, websiteUrl: null,
    locale: "zh-CN", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    followerCount: 0, followingCount: 0, isFollowing: false,
  };
  await withServer(async (baseUrl) => {
    const cursor = encodeURIComponent("2026-01-01T00:00:00.000Z|11111111-1111-4111-8111-111111111111");
    const popular = await fetch(`${baseUrl}/api/v1/articles?sort=popular&cursor=${cursor}`);
    assert.equal(popular.status, 400, "a cursor in the most-saved order is bad input, not a server error");
    const refusal = (await popular.json()).error.message;
    assert.match(refusal, /cursor is only supported with sort=latest/);
    assert.match(refusal, /offset up to 10000/, "the refusal names the way to page in this order");
    assert.match(refusal, /sort=latest with a cursor/, "and the way to page deeper");

    // The author's list is the same list, so it refuses the same way.
    const authorPopular = await fetch(`${baseUrl}/api/v1/authors/some-author/articles?sort=popular&cursor=${cursor}`);
    assert.equal(authorPopular.status, 400);
    assert.match((await authorPopular.json()).error.message, /cursor is only supported with sort=latest/);

    // A cursor in the newest-first order is still passed through untouched, and
    // a page with neither parameter is still the first page.
    const latest = await fetch(`${baseUrl}/api/v1/articles?cursor=${cursor}&limit=5`);
    assert.equal(latest.status, 200);
    assert.deepEqual(calls[0], { locale: "zh-CN", query: "", sort: "latest", limit: 5, cursor: "2026-01-01T00:00:00.000Z|11111111-1111-4111-8111-111111111111" });
    assert.equal((await fetch(`${baseUrl}/api/v1/articles?sort=popular&offset=10`)).status, 200);
    assert.deepEqual(calls[1], { locale: "zh-CN", query: "", sort: "popular", limit: 20, offset: 10 });

    // The two refusals never reached the store.
    assert.equal(calls.length, 2, "a refused page must not be built by the store");
  }, {
    env: authEnv,
    store: {
      async listPublishedArticles(args) { calls.push(args); return []; },
      async getAuthorProfile() { return profile; },
    },
  });
});

test("REST role assignment is editor-only, refuses self-service and returns the updated profile", async () => {
  const calls = [];
  let roleOfWriter = "member";
  const profileFor = (userId) => ({
    userId, role: userId === "writer-user" ? roleOfWriter : "member",
    displayName: "作者", bio: "", avatarUrl: null, websiteUrl: null, locale: "zh-CN",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    followerCount: 0, followingCount: 0, isFollowing: false,
  });
  const put = (baseUrl, userId, token, body) => fetch(baseUrl + "/api/v1/users/" + userId + "/role", {
    method: "PUT",
    headers: token
      ? { authorization: "Bearer " + signedToken(token), "content-type": "application/json" }
      : { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  await withServer(async (baseUrl) => {
    // A role is personal state: without a session there is nothing to assign.
    assert.equal((await put(baseUrl, "writer-user", null, { role: "editor" })).status, 401);

    // A member is authenticated and still refused — 403, not 404: the resource
    // exists, the caller simply may not touch it.
    const member = await put(baseUrl, "writer-user", "member-user", { role: "editor" });
    assert.equal(member.status, 403);
    assert.deepEqual(await member.json(), { error: { code: "FORBIDDEN", message: "You are not allowed to access this resource." } });
    assert.deepEqual(calls, []);

    const editor = (userId, body) => put(baseUrl, userId, "editor-user", body);
    const bogusRole = await editor("writer-user", { role: "admin" });
    assert.equal(bogusRole.status, 400);
    const extraField = await editor("writer-user", { role: "editor", admin: true });
    assert.equal(extraField.status, 400);
    const missing = await editor("missing-user", { role: "editor" });
    assert.equal(missing.status, 404);
    // ADR 0016, decision 3: even an editor cannot change their own role.
    const self = await editor("editor-user", { role: "member" });
    assert.equal(self.status, 400);
    assert.deepEqual(calls, []);

    const promoted = await editor("writer-user", { role: "editor" });
    assert.equal(promoted.status, 200);
    assert.deepEqual(await promoted.json(), { data: profileFor("writer-user") });
    assert.deepEqual(calls, [{ actorId: "editor-user", userId: "writer-user", role: "editor" }]);

    const wrongMethod = await fetch(baseUrl + "/api/v1/users/writer-user/role");
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "PUT");
  }, {
    // The editor here comes from the environment list, which is how an empty
    // database gets its first one.
    env: { ...authEnv, EDITOR_USER_IDS: "editor-user" },
    store: {
      async isSessionRevoked() { return false; },
      async getUserRole() { return "member"; },
      async setUserRole(args) {
        if (args.actorId === args.userId) throw new ProfileInputError("You cannot change your own role.");
        if (args.userId === "missing-user") throw new ProfileNotFoundError();
        // Only a successful assignment is recorded: a refused one wrote nothing.
        calls.push(args);
        roleOfWriter = args.role;
        return args.role;
      },
      async getAuthorProfile(args) { return profileFor(args.userId); },
    },
  });
});

test("REST taxonomy writes keep hashtags open and reserve categories for editors", async () => {
  const calls = [];
  const taxonomy = (kind, slug) => ({ id: `taxonomy-${slug}`, kind, slug, name: slug, description: "", locale: "zh-CN", articleCount: 0, createdBy: "author-user" });
  const post = (baseUrl, token, body) => fetch(baseUrl + "/api/v1/taxonomies", {
    method: "POST",
    headers: { authorization: "Bearer " + signedToken(token), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  await withServer(async (baseUrl) => {
    // A hashtag is the author's own words: a plain member may still mint one.
    const tag = await post(baseUrl, "member-user", { kind: "tag", slug: "nowave", name: "NoWave" });
    assert.equal(tag.status, 201);
    assert.deepEqual(calls[0], { kind: "tag", slug: "nowave", name: "NoWave", locale: "zh-CN", description: "", actorId: "member-user", actorIsEditor: false });

    // A category is the platform speaking: the same account is refused.
    const category = await post(baseUrl, "member-user", { kind: "category", slug: "poetry", name: "诗歌" });
    assert.equal(category.status, 403);
    assert.deepEqual(await category.json(), { error: { code: "FORBIDDEN", message: "You are not allowed to access this resource." } });

    // The refused attempt still reached persistence with an honest answer about
    // the caller, so the adapter — not the transport — is what says no.
    assert.deepEqual(calls[1], { kind: "category", slug: "poetry", name: "诗歌", locale: "zh-CN", description: "", actorId: "member-user", actorIsEditor: false });

    const created = await post(baseUrl, "editor-user", { kind: "category", slug: "poetry", name: "诗歌" });
    assert.equal(created.status, 201);
    assert.deepEqual(calls[2], { kind: "category", slug: "poetry", name: "诗歌", locale: "zh-CN", description: "", actorId: "editor-user", actorIsEditor: true });

    // Deleting a category needs the role even from the account that created it.
    const removed = await fetch(baseUrl + "/api/v1/taxonomies/11111111-1111-4111-8111-111111111111", {
      method: "DELETE",
      headers: { authorization: "Bearer " + signedToken("member-user") },
    });
    assert.equal(removed.status, 403);
    assert.deepEqual(calls[3], { taxonomyId: "11111111-1111-4111-8111-111111111111", actorId: "member-user", actorIsEditor: false });
    assert.equal(calls.length, 4);
  }, {
    env: { ...authEnv, EDITOR_USER_IDS: "editor-user" },
    store: {
      async isSessionRevoked() { return false; },
      async getUserRole() { return "member"; },
      // The fake enforces the same rule the persistence contract asserts, so the
      // HTTP layer is tested against the refusal a real adapter would produce.
      async createTaxonomy(args) {
        calls.push(args);
        if (args.kind === "category" && args.actorIsEditor !== true) throw new ArticleAuthorizationError("Only an editor can create a category.");
        return taxonomy(args.kind, args.slug);
      },
      async deleteTaxonomy(args) {
        calls.push(args);
        if (args.actorIsEditor !== true) throw new ArticleAuthorizationError("Only an editor can delete a category.");
        return true;
      },
    },
  });
});

test("REST featured shelf is public to read and editorial to arrange", async () => {
  const calls = [];
  const article = (slug) => ({
    id: `article-${slug}`, authorId: "writer-user", slug, workType: "other", status: "published",
    locale: "zh-CN", title: slug, summary: "", contentBlocks: [{ id: "p1", type: "paragraph", text: "正文" }],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", publishedAt: "2026-01-02T00:00:00.000Z",
    author: null, categories: [], tags: [], likeCount: 0, likedByViewer: false,
  });
  await withServer(async (baseUrl) => {
    // Anyone may read the shelf, signed in or not.
    const read = await fetch(baseUrl + "/api/v1/featured?limit=5");
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), { data: [article("picked")] });
    assert.deepEqual(calls[0], ["list", { locale: "zh-CN", limit: 5, offset: 0 }]);

    // Arranging it needs a session first, then the role.
    const anonymous = await fetch(baseUrl + "/api/v1/featured", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ articleIds: [] }),
    });
    assert.equal(anonymous.status, 401);

    const member = await fetch(baseUrl + "/api/v1/featured", {
      method: "PUT",
      headers: { authorization: "Bearer " + signedToken("member-user"), "content-type": "application/json" },
      body: JSON.stringify({ articleIds: [] }),
    });
    assert.equal(member.status, 403);

    // The member reaches the store carrying the assembled fact, which is what
    // turns the request down — not a second question asked at the wrong depth.
    assert.deepEqual(calls[1], ["set", {
      actorId: "member-user", actorIsEditor: false, locale: "zh-CN", articleIds: [],
    }]);

    const editor = await fetch(baseUrl + "/api/v1/featured", {
      method: "PUT",
      headers: { authorization: "Bearer " + signedToken("editor-user"), "content-type": "application/json" },
      body: JSON.stringify({ articleIds: ["11111111-1111-4111-8111-111111111111"] }),
    });
    assert.equal(editor.status, 200);
    assert.deepEqual(calls[2], ["set", {
      actorId: "editor-user", actorIsEditor: true, locale: "zh-CN",
      articleIds: ["11111111-1111-4111-8111-111111111111"],
    }]);

    // The body carries the whole shelf and nothing else.
    const malformed = await fetch(baseUrl + "/api/v1/featured", {
      method: "PUT",
      headers: { authorization: "Bearer " + signedToken("editor-user"), "content-type": "application/json" },
      body: JSON.stringify({ articleIds: ["11111111-1111-4111-8111-111111111111"], position: 0 }),
    });
    assert.equal(malformed.status, 400);
    assert.equal(calls.length, 3);

    const wrongMethod = await fetch(baseUrl + "/api/v1/featured", { method: "POST" });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "GET, PUT");
  }, {
    env: { ...authEnv, EDITOR_USER_IDS: "editor-user" },
    store: {
      async isSessionRevoked() { return false; },
      async getUserRole() { return "member"; },
      async listFeaturedArticles(args) { calls.push(["list", args]); return [article("picked")]; },
      async setFeaturedArticles(args) {
        calls.push(["set", args]);
        if (args.actorIsEditor !== true) throw new ArticleAuthorizationError("Only an editor can change the featured shelf.");
        return args.articleIds.map((id) => article(id));
      },
    },
  });
});

test("REST featured shelf falls back to default word-count algorithm when uncurated and is overridden when curated", async () => {
  const shortArticle = {
    id: "art-short", authorId: "author-1", slug: "short-slug", workType: "short_story", status: "published",
    locale: "zh-CN", title: "短篇", summary: "", contentBlocks: [{ id: "p1", type: "paragraph", text: "短小正文" }], // 4 chars
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", publishedAt: "2026-01-02T00:00:00.000Z",
    author: null, categories: [], tags: [], likeCount: 0, likedByViewer: false, viewCount: 0,
  };
  const longArticle = {
    id: "art-long", authorId: "author-1", slug: "long-slug", workType: "novel", status: "published",
    locale: "zh-CN", title: "长篇", summary: "", contentBlocks: [{ id: "p1", type: "paragraph", text: "这是一篇非常长非常具有深度的长篇巨作" }], // 18 chars
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", publishedAt: "2026-01-02T00:00:00.000Z",
    author: null, categories: [], tags: [], likeCount: 0, likedByViewer: false, viewCount: 0,
  };

  let curatedArticles = [];

  await withServer(async (baseUrl) => {
    // 1. Initially uncurated: algorithm prioritizes art-long (18 chars) over art-short (4 chars)
    const fallbackRes = await fetch(baseUrl + "/api/v1/featured?locale=zh-CN");
    assert.equal(fallbackRes.status, 200);
    const fallbackBody = await fallbackRes.json();
    assert.deepEqual(fallbackBody.data.map((item) => item.id), ["art-long", "art-short"]);

    // 2. Editor curates shelf: sets art-short first, art-long second
    curatedArticles = [shortArticle, longArticle];

    // 3. Now curated: editor order takes precedence and overrides the algorithm
    const curatedRes = await fetch(baseUrl + "/api/v1/featured?locale=zh-CN");
    assert.equal(curatedRes.status, 200);
    const curatedBody = await curatedRes.json();
    assert.deepEqual(curatedBody.data.map((item) => item.id), ["art-short", "art-long"]);
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async getUserRole() { return "member"; },
      async listFeaturedArticles() { return curatedArticles; },
      async listPublishedArticles() { return [shortArticle, longArticle]; },
    },
  });
});

test("REST public author profile reflects the optional viewer follow state", async () => {
  let received;
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/v1/authors/target-user", {
      headers: { authorization: "Bearer " + signedToken("viewer-user") },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      data: {
        userId: "target-user", displayName: "目标作者", bio: "",
        avatarUrl: null, websiteUrl: null, locale: "zh-CN",
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
        followerCount: 2, followingCount: 1, isFollowing: true,
      },
    });
    assert.deepEqual(received, { userId: "target-user", locale: "zh-CN", viewerId: "viewer-user" });
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async getAuthorProfile(args) {
        received = args;
        return {
          userId: args.userId, displayName: "目标作者", bio: "",
          avatarUrl: null, websiteUrl: null, locale: args.locale,
          createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
          followerCount: 2, followingCount: 1, isFollowing: args.viewerId === "viewer-user",
        };
      },
    },
  });
});

/**
 * `GET /api/v1/me/sessions` and its two `DELETE` shapes.
 *
 * The HTTP-level assertions are about who may ask and what the transport hands
 * to the identity service: both are authenticated, the device that asks is the
 * one that gets spared, an id that is not a device of this account answers 404,
 * and — the detail the last slice settled — the spared device is named by the
 * token's `sid`, not by its `jti`.
 */
test("REST device management is authenticated, spares the session that asks and refuses a body", async () => {
  const seen: { list: Record<string, unknown> | null; ended: Record<string, unknown> | null; others: Record<string, unknown> | null } = { list: null, ended: null, others: null };
  const device = {
    sessionId: "session-sessions-user",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: null,
    expiresAt: "2026-01-08T00:00:00.000Z",
  };
  await withServer(async (baseUrl) => {
    const headers = { authorization: "Bearer " + signedToken("sessions-user") };

    const list = await fetch(baseUrl + "/api/v1/me/sessions", { headers });
    assert.equal(list.status, 200);
    assert.equal(list.headers.get("cache-control"), "no-store");
    assert.deepEqual(await list.json(), { data: { sessions: [{ ...device, current: true }] } });
    assert.deepEqual(seen.list, { userId: "sessions-user", limit: 50 });

    const endedOthers = await fetch(baseUrl + "/api/v1/me/sessions", { method: "DELETE", headers });
    assert.deepEqual(await endedOthers.json(), { data: { ok: true, revokedSessions: 1 } });
    assert.deepEqual(seen.others, { userId: "sessions-user", exceptSessionId: "session-sessions-user" });
    assert.notEqual(seen.others?.exceptSessionId, "token-sessions-user",
      "the access token is not a device, and sparing it would spare nothing");

    const endedOne = await fetch(baseUrl + "/api/v1/me/sessions/a-device", { method: "DELETE", headers });
    assert.deepEqual(await endedOne.json(), { data: { ok: true } });
    assert.deepEqual(seen.ended, { userId: "sessions-user", sessionId: "a-device" });

    // A body would only be a second place to name the device.
    const withBody = await fetch(baseUrl + "/api/v1/me/sessions/a-device", {
      method: "DELETE", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "another-device" }),
    });
    assert.equal(withBody.status, 400);
    assert.equal((await withBody.json()).error.code, "BAD_USER_INPUT");

    for (const path of ["/api/v1/me/sessions", "/api/v1/me/sessions/a-device"]) {
      const anonymous = await fetch(baseUrl + path, { method: path.endsWith("a-device") ? "DELETE" : "GET" });
      assert.equal(anonymous.status, 401);
      assert.equal(anonymous.headers.get("cache-control"), "no-store");
      assert.equal((await anonymous.json()).error.code, "UNAUTHENTICATED");
    }
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async listIdentitySessions(args) { seen.list = args; return [device]; },
      async revokeIdentitySession(args) { seen.ended = args; return true; },
      async revokeIdentitySessions(args) { seen.others = args; return 1; },
    },
  });
});

test("REST ending a device that is not this account's is a 404, and a session that cannot be checked is a 401", async () => {
  let asked = 0;
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/v1/me/sessions/not-a-device", {
      method: "DELETE",
      headers: { authorization: "Bearer " + signedToken("sessions-user") },
    });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, "NOT_FOUND");
    assert.equal(asked, 1, "the store was asked once and answered no");
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async revokeIdentitySession() { asked += 1; return false; },
    },
  });

  // Fail closed: a revocation check that cannot be answered is not a session.
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/v1/me/sessions", {
      headers: { authorization: "Bearer " + signedToken("sessions-user") },
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, "UNAUTHENTICATED");
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { throw new Error("the revocation store is down"); },
      async listIdentitySessions() { throw new Error("must not be called"); },
    },
  });
});

test("REST current-session logout revokes the access token that was presented, through the token expiry", async () => {
  let received;
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/v1/me/session", {
      method: "DELETE",
      headers: { authorization: "Bearer " + signedToken("logout-user") },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: true });
    // The token id, not the session id: signing out ends the credential that
    // was presented, and leaves the visitor's other devices alone.
    assert.equal(received.sessionId, "token-logout-user");
    assert.ok(received.expiresAt instanceof Date);
    assert.ok(received.expiresAt.getTime() > Date.now());
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async revokeSession(args) { received = args; return true; },
    },
  });
});

/**
 * `PUT /api/v1/me/password`.
 *
 * The HTTP-level assertions are about the shape of the contract, not the rules:
 * the endpoint is authenticated and single-method, the session that makes the
 * request is the one the identity service is told to spare, and a wrong current
 * password is a 401 that changes nothing. What "spare" and "12 characters"
 * mean is decided once, in the identity service, and tested there.
 */
test("REST password change is authenticated, spares its own session and stores only the new hash", async () => {
  const seen: { replaced: Record<string, unknown> | null } = { replaced: null };
  // One salted hash for the whole test: a real store answers the same value
  // every time it is asked, and the proof the service hands back names it.
  const passwordHash = await hashPassword("the-current-password");
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/v1/me/password", {
      method: "PUT",
      headers: {
        authorization: "Bearer " + signedToken("password-user"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ currentPassword: "the-current-password", newPassword: "a-brand-new-password" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { ok: true, revokedSessions: 1 } });
    // One call carries both halves, so no response can be produced with the
    // new credential saved and the old sessions still signed in.
    assert.equal(seen.replaced?.userId, "password-user");
    assert.ok(await verifyPassword("a-brand-new-password", String(seen.replaced?.passwordHash)));
    // The session to spare is `sid`, not `jti`: a token is minted afresh on
    // every refresh, so sparing the token id would spare nothing and sign the
    // visitor out with their own request.
    assert.equal(seen.replaced?.exceptSessionId, "session-password-user");
    assert.notEqual(seen.replaced?.exceptSessionId, "token-password-user",
      "the access token is not a session, and must not be treated as one");
    // The store re-checks this under its own lock, so the transport hands over
    // exactly the state the service verified — no more of the account.
    assert.deepEqual(seen.replaced?.proof, { email: "owner@example.test", passwordHash });
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async findIdentityCredentials({ userId }) { return { userId, passwordHash }; },
      async findIdentityAccountByUserId({ userId }) {
        return { userId, email: "owner@example.test", emailVerifiedAt: null };
      },
      async replaceIdentityPassword(args) { seen.replaced = args; return { updated: true, revokedSessions: 1 }; },
    },
  });
});

test("REST password change answers 401 for a wrong current password and stores nothing", async () => {
  let stored = 0;
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/v1/me/password", {
      method: "PUT",
      headers: {
        authorization: "Bearer " + signedToken("password-user"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ currentPassword: "not-the-password", newPassword: "a-brand-new-password" }),
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, "UNAUTHENTICATED");
    assert.equal(stored, 0, "a refused change must not write a credential");
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async findIdentityCredentials({ userId }) {
        return { userId, passwordHash: await hashPassword("the-current-password") };
      },
      async replaceIdentityPassword() { stored += 1; return { updated: true, revokedSessions: 0 }; },
    },
  });
});

test("REST password change is refused without a session, and only accepts PUT", async () => {
  await withServer(async (baseUrl) => {
    const anonymous = await fetch(baseUrl + "/api/v1/me/password", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: "the-current-password", newPassword: "a-brand-new-password" }),
    });
    assert.equal(anonymous.status, 401);

    const read = await fetch(baseUrl + "/api/v1/me/password", { headers: { authorization: "Bearer " + signedToken("password-user") } });
    assert.equal(read.status, 405);
    assert.equal(read.headers.get("allow"), "PUT", "a password is never readable");
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async findIdentityCredentials() { throw new Error("must not be called"); },
    },
  });
});

test("REST authentication fails closed if durable session revocation cannot be checked", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/v1/me/articles", {
      headers: { authorization: "Bearer " + signedToken("reader-user") },
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, "UNAUTHENTICATED");
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { throw new Error("database unavailable"); },
      async listMyArticles() { throw new Error("must not be called"); },
    },
  });
});

test("REST optional viewer authentication does not grant viewer state to revoked sessions", async () => {
  let received;
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/v1/articles/poetry-work/like", {
      headers: { authorization: "Bearer " + signedToken("revoked-viewer") },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(received, { slug: "poetry-work", locale: "zh-CN", actorId: null });
  }, {
    env: authEnv,
    store: {
      // Revocation is recorded against the access token, not the session.
      async isSessionRevoked(tokenId) { return tokenId === "token-revoked-viewer"; },
      async getArticleLikeInfo(args) { received = args; return null; },
    },
  });
});

test("REST profile update derives userId from the JWT and rejects identity fields", async () => {
  const received: { upsert: Record<string, unknown> | null; read: Record<string, unknown> | null } = { upsert: null, read: null };
  const savedProfile = {
    userId: "profile-owner", displayName: "新名字", bio: "简介", avatarUrl: null,
    websiteUrl: "https://example.test/", locale: "zh-CN", followerCount: 0,
    followingCount: 0, isFollowing: false,
  };
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/v1/me/profile", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + signedToken("profile-owner"),
      },
      body: JSON.stringify({
        displayName: "新名字", bio: "简介", avatarUrl: null,
        websiteUrl: "https://example.test/", locale: "zh-CN",
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: savedProfile });
    assert.deepEqual(received.upsert, {
      userId: "profile-owner", displayName: "新名字", bio: "简介",
      avatarUrl: null, websiteUrl: "https://example.test/", locale: "zh-CN",
    });
    assert.deepEqual(received.read, { userId: "profile-owner", locale: "zh-CN", viewerId: "profile-owner" });

    const spoofed = await fetch(baseUrl + "/api/v1/me/profile", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + signedToken("profile-owner"),
      },
      body: JSON.stringify({ displayName: "冒名", userId: "victim" }),
    });
    assert.equal(spoofed.status, 400);
    assert.equal((await spoofed.json()).error.code, "BAD_USER_INPUT");
    assert.equal(received.upsert.userId, "profile-owner");
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async upsertAuthorProfile(args) { received.upsert = args; },
      async getAuthorProfile(args) {
        received.read = args;
        return { ...savedProfile, userId: args.userId, locale: args.locale };
      },
    },
  });
});

test("REST follow and unfollow use stable target userId and verified actor identity", async () => {
  const calls = [];
  let isFollowing = false;
  const getProfile = () => ({
    userId: "target-user", displayName: "目标作者", bio: "", avatarUrl: null, websiteUrl: null,
    locale: "zh-CN", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
    followerCount: isFollowing ? 1 : 0, followingCount: 0, isFollowing,
  });
  await withServer(async (baseUrl) => {
    const follow = await fetch(baseUrl + "/api/v1/users/target-user/follow", {
      method: "POST",
      headers: { authorization: "Bearer " + signedToken("follower-user") },
    });
    assert.equal(follow.status, 200);
    assert.deepEqual(await follow.json(), { data: getProfile() });

    const unfollow = await fetch(baseUrl + "/api/v1/users/target-user/follow", {
      method: "DELETE",
      headers: { authorization: "Bearer " + signedToken("follower-user") },
    });
    assert.equal(unfollow.status, 200);
    assert.deepEqual(await unfollow.json(), { data: getProfile() });
    assert.deepEqual(calls, [
      ["follow", { actorId: "follower-user", targetUserId: "target-user" }],
      ["unfollow", { actorId: "follower-user", targetUserId: "target-user" }],
    ]);
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async followUser(args) { calls.push(["follow", args]); isFollowing = true; },
      async unfollowUser(args) { calls.push(["unfollow", args]); isFollowing = false; },
      async getAuthorProfile(args) {
        assert.deepEqual(args, { userId: "target-user", locale: "zh-CN", viewerId: "follower-user" });
        return getProfile();
      },
    },
  });
});

test("REST article like endpoint sets an explicit idempotent state rather than toggling", async () => {
  const calls = [];
  await withServer(async (baseUrl) => {
    for (const liked of [true, true, false]) {
      const response = await fetch(baseUrl + "/api/v1/articles/poetry-work/like?locale=zh-CN", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + signedToken("reader-user"),
        },
        body: JSON.stringify({ liked }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.data.likedByViewer, liked);
      assert.equal(body.data.slug, "poetry-work");
    }
    const spoofed = await fetch(baseUrl + "/api/v1/articles/poetry-work/like", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + signedToken("reader-user"),
      },
      body: JSON.stringify({ liked: true, actorId: "attacker" }),
    });
    assert.equal(spoofed.status, 400);
    assert.equal((await spoofed.json()).error.code, "BAD_USER_INPUT");
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map((call) => call.liked), [true, true, false]);
    assert.ok(calls.every((call) => call.actorId === "reader-user"));
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async setArticleLike(args) {
        calls.push(args);
        return {
          articleId: "article-1", slug: args.slug, likeCount: args.liked ? 1 : 0,
          likedByViewer: args.liked,
        };
      },
    },
  });
});
