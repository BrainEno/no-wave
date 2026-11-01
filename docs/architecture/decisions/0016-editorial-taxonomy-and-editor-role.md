# ADR 0016: Editorial taxonomy control and the editor role

- Status: Accepted
- Date: 2026-11-01
- Scope: Who may shape the public taxonomy, what "editor" means, and what the three default reading
  shelves are. Excludes moderation, reporting and the rest of issue #72, which remains its own ADR.

## Context

`docs/audit/feature-traceability.md` has carried one open question for a long time: **who may create a
category**. The API answered it by accident — `POST /api/v1/taxonomies` lets any authenticated account
create either kind, so the public taxonomy is whatever the last person to sign up felt like typing.
The product decision (2026-11-01) is that this is wrong:

- **Categories are an editorial structure.** They are how the platform says "these works belong
  together", and they only mean something if a reader can trust that somebody read the work first.
- **Hashtags are not.** A tag is the author's own words about their own work; `behavior-baseline.md`
  already draws the line between "categories" and "hashtags", and the Flutter client's
  create-or-reuse tag flow depends on being able to mint one.

Three public shelves were chosen at the same time: **精选 `featured`** (editors pick and order),
**最新 `latest`** (by publication date), and **最多收藏 `most-saved`** (by save count). Two facts
about the existing system shape how those three can be built:

1. **A save *is* a like.** The client's 收藏 page calls `GET /api/v1/me/liked-articles`; both words name
   the same row in `article_likes`. So `most-saved` needs no new signal — it is a count over a table
   that already exists.
2. **There is no role system at all.** Nothing in the schema distinguishes one account from another.
   Issue #72 (moderation, reporting, roles) is still a design question, and the three shelves cannot
   wait for it.

## Decision

**1. Categories become editor-controlled; hashtags stay open.** `kind: "category"` in
`POST /api/v1/taxonomies` requires the editor role. `kind: "tag"` keeps working exactly as it does
today for every authenticated author. Deleting a category also requires the editor role; deleting a
tag stays creator-scoped, so an author can retract their own words but not somebody else's.

**2. The role lives in the database: `user_profiles.role`, `member` (default) or `editor`.**
An environment list, `EDITOR_USER_IDS`, is honoured *in addition to* the column.

The column is the source of truth because a role is account state: it has to survive a redeploy, be
visible to the client through the profile it already fetches, and be auditable. The environment list
exists for exactly one reason — **bootstrapping**. A brand-new database has no editor, and the column
can only be written by an editor; without an outside way in, the role system is a lock with the key
on the wrong side. It also doubles as emergency access if the last editor account is ever lost.

**3. An editor cannot change their own role.** `PUT /api/v1/users/:userId/role` rejects
`userId === actorId`. This is not about distrust, it is about the shape of the state machine: a
single-editor instance where that editor demotes themselves has no way back in except the
environment list, and "one person can quietly make the platform unable to curate itself" is a bad
failure to design for. Promoting others is allowed; demoting others is allowed; touching yourself is
not.

**4. `featured` gets its own small table, not a category.** `featured_articles(article_id, position,
created_by, created_at)`.

A category is a *set*; featured is an *ordered list*. Folding the order into the category-association
table would give every other category a `position` column it never uses, and would leave no record of
**who** put a work on the shelf or when — the one thing an editorial decision needs to be answerable
for. The table is three columns wider than the alternative and buys both.

**5. `most-saved` is an all-time ranking.** The 30-day window that shipped in `sort=popular` is
replaced by a straight count of saves.

The window was there to stop an all-time chart from freezing — the same few old works holding the top
forever. That worry was real *for `popular` as a trend signal*, but the three shelves divide the work
differently now: **freshness is `latest`'s job, quality is `featured`'s job, and reputation is
`most-saved`'s job**. A short story does not expire, so a work that has been saved for two years
deserves its place on the reputation shelf; a new work reaches readers through `latest` or through an
editor, not by out-ranking a classic.

**6. Serial publishing is out of scope.** The platform is for short fiction: one piece is one work.
No series/collection table, no next/previous pointers. Recorded in `platform-capability-backlog.md`
as a deliberate "won't do", so it is not rediscovered as a gap later.

## Consequences

- **Every existing account is a `member`.** `ALTER TABLE ... DEFAULT 'member'` handles it; no
  backfill, and no account silently gains privileges.
- **`EDITOR_USER_IDS` is a deploy-time concern.** Adding an editor by column needs no redeploy;
  adding one through the environment list does. The two are additive, not exclusive.
- **Issue #72 gets a starting point, not a solution.** `role` is one column with two values. A real
  moderation system will want more (suspended accounts, a report queue, per-action permissions), and
  should replace this rather than extend it.
- **The client sees the role through the profile.** `AuthorProfile` gains a `role` field, so an
  author's profile shows whether they speak for the platform, and a signed-in editor's own client can
  decide whether to show editorial controls. No new endpoint.
- **Not yet built:** the `featured` shelf itself and the category-permission change. Both depend on
  this ADR's role decision, and land as their own slices.
