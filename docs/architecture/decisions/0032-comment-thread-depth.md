# ADR 0032: A comment thread has a bottom, and the reader sees all of it

- Status: Accepted
- Date: 2026-11-09

## Context

Two defects shared one root: nothing in the system agreed on how deep a comment
thread may go (#246).

- `createArticleComment` accepted a reply to any comment, at any depth, and
  notified the parent's author each time.
- `listArticleComments` walked the tree with a recursive CTE that stopped at
  `depth < 10`, a number written into the SQL of both adapters.

Neither constant knew about the other, so the tenth and eleventh levels were
created successfully and then never returned: the writer saw `201`, refreshed,
and found their comment missing. The failure is the worst kind — no error, no
trace, and a reader who concludes the site lost their words.

The same read path was also the last projection with a per-item author lookup:
`serializeRestComments` asked `getAuthorProfile` once per node, so a thread of 50
comments cost 50 statements. Article lists had this removed in #162; comments were
the branch left behind.

## Decision

**The cap is enforced on write, at a depth the reader can see.**

```ts
export const MAX_COMMENT_REPLY_DEPTH = 8;   // 9 visible levels, 0…8
```

A reply whose parent already sits at `MAX_COMMENT_REPLY_DEPTH` is refused with
`400 COMMENT_DEPTH_EXCEEDED` and a message that says what to do instead ("answer
an earlier comment in this thread"). The store walks *up* the parent chain to
answer "how deep is this comment", because that is the direction that terminates:
a thread has many replies and exactly one parent.

The code is its own rather than `BAD_USER_INPUT` for the reason `EMAIL_TAKEN` has
one: the generic 400 reaches every client as "the request input is invalid",
which is true and unactionable. A client that wants to say "this thread is full"
has to recognise the case, and a status code shared with a hundred validation
failures cannot express it.

**The read path carries no display cap at all.** The recursion stops at
`MAX_COMMENT_TREE_DEPTH = 64`, which is a cycle guard — a comment whose parent
chain contains itself would otherwise recurse forever — not a rule. Nothing the
write path accepts comes close to it, so every comment that was accepted is
returned, including threads that were written before this decision and are deeper
than the new cap. Hiding history to make the schema look tidy is the bug, not the
fix.

**The author projection is batched.** The tree is walked once, the distinct
`(author, locale)` pairs are collected, and one `getAuthorProfilesByIds` call per
locale answers all of them; assembly is in-memory. The statement count is
independent of how wide or deep the thread is, and a unit test asserts that by
counting prepared statements rather than timing anything.

## Consequences

- **A refused reply is visible where it happens.** The browser currently composes
  only top-level comments, so the cap cannot be reached from the UI today; when a
  reply affordance is added, the `400` message is already the text it should show,
  and the depth is a server-owned number the client does not need to duplicate.
- **The number is a product decision.** 8 levels is a conversation on a phone
  screen; past that the indentation is wider than the column and every reply
  answers something the reader cannot see in context. Changing it is a one-line
  constant change plus the message, not a migration: depth is derived from
  `parent_comment_id`, never stored.
- **Notifications follow the write.** A refused reply notifies nobody, because the
  depth check runs before the insert and inside the same transaction as the
  article read.
- **Legacy deep threads stay readable**, and cannot be extended further. That is
  the honest reading of "the cap is for new writing": the alternative — deleting
  or hiding what people already wrote — is data loss dressed as consistency.
- **One extra statement on the write path.** Creating a reply now walks its parent's
  ancestors (a bounded chain, at most `MAX_COMMENT_REPLY_DEPTH` steps because the
  cap is enforced on every write). A comment creation already reads the article,
  the parent and inserts three rows, so this is not the statement that matters.
