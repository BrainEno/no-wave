# ADR 0021: Reading marks stay on the reader's device

- Status: Accepted
- Date: 2026-11-01
- Borrowed from [`red-room-archive`](https://github.com/BrainEno/red-room-archive), whose article pages
  let a reader underline a passage and write beside it. As with 朗读 (ADR 0020), what travels is the
  *idea*: that project is Astro with per-page scripts, this one is React Router with shared client
  components, so the behaviour is rebuilt here rather than ported.

## Context

Underlining a sentence and keeping it is one of the oldest things a reader does to a text, and a
literary site is where it belongs. The obvious way to build it — a server-side "highlights" table
keyed by account — would make reading marks the first feature in this project that records what a
reader did with a particular work, when, and in what order. That is a reading history. It would need
an account (anonymous readers could not mark anything), a migration, a retention rule, an export
path and a deletion path, and it would make a private act legible to whoever runs the database.

The alternative is to keep the marks where the reading happens. A work is already fully on the page;
a mark is a pair of offsets into it and, optionally, some words beside it. Nothing about that needs
to leave the reader's browser.

## Decision

Reading marks are **the reader's own, kept in their own browser, and never sent anywhere**.

- **Storage is `localStorage`, one key per work** (`nw-passages-v1:<slug>`). No endpoint, no port
  method, no account, no sync, no telemetry. A reader who is not signed in can mark a work; a reader
  who is signed in gets exactly the same feature and nothing more.
- **A mark is anchored to the words, not to the position.** Alongside `start`/`end` it remembers the
  text itself and 48 characters on each side. When the offsets no longer hold those words — the work
  was edited, a paragraph was inserted — every occurrence is scored by that remembered context and
  the nearest one wins. A passage whose words have gone from the work cannot be painted, and the mark
  is kept rather than thrown away, because it comes back if the words do.
- **Painting uses the Custom Highlight API** (`CSS.highlights`), which colours a range without
  rewriting the reader's DOM. The marked paragraph and the unmarked one have identical markup: the
  article's HTML is the server's, and the reader's marks are drawn over it, never inside it.
- **Both capabilities are required, or the feature is absent.** Where `CSS.highlights` is missing the
  marks could not be painted; where `localStorage` is refused they could not be kept. In either case
  the component renders nothing rather than offering a button that cannot work — the same choice
  [ADR 0020](0020-read-aloud-stays-in-the-browser.md) makes for 朗读.
- **Bounded, because a shelf is not a database**: 240 characters per passage, 280 per note, 50 marks
  per work. When the shelf is full the reader is told so, and nothing already there is dropped to
  make room.
- **The same passage marked twice is one mark**: identical offsets, or identical words in identical
  surroundings, updates the note instead of adding a row.
- **Another tab of the same work is the same reader**: a `storage` event repaints the shelf, so a mark
  made in one tab appears in the other without a reload.
- Marks are **removed** from the registry and from `localStorage` when the last one goes, and when the
  reader leaves the page nothing is left painted behind.

### Deliberately not included

- **Copy watermarking and blocking near-whole-article copies.** `red-room-archive` does both. They are
  a copyright posture, not a reading feature, and this project's position on reuse and on automated
  collection is still an open decision for the owner — no ADR records one, and this file is not the
  place to smuggle one in behind 划线.
- **Sharing a passage, as a record.** `red-room-archive` builds a share card for one, and any version
  of sharing that writes the passage somewhere is refused here for the reasons above. Sharing was
  added later *as a link and nothing else* — the work's own words in a URL fragment, carrying no note
  and reaching no server — and it is its own decision:
  [ADR 0023](0023-a-shared-passage-is-a-link-not-a-record.md). Reading a marked passage aloud is part
  of this work, and it shares the single voice described in ADR 0020 with the control that reads the
  whole work.

## Consequences

- The rules live in `packages/web-ui/src/lib/passages.ts` as pure functions and are tested there
  (`passages.test.ts`, 15 tests) without a browser: what a mark is, how it is read back from
  untrusted storage, how it is found again after an edit, and what happens at the limits.
- The DOM half — collecting the work's text, turning a selection into offsets, painting, and the
  shelf — is in `PassageAnnotations`, and is covered in a browser (`e2e/passages.spec.ts`). The one
  internal that spec inspects is `CSS.highlights`, because the paint has no DOM of its own to assert.
- Marks are per browser, and they are the reader's to lose: clearing site data removes them, and
  private browsing refuses them. That is the honest trade for a feature that collects nothing, and
  the shelf says so ("留在这台设备上").
- A mark cannot be carried to another device or searched. It **can** be shared, but only as a link
  that carries the work's own words and reaches no server (ADR 0023). Anyone who wants a mark synced
  across devices is asking for the server-side feature this decision declines to be — which is a new
  ADR, not a setting.
- `packages/web-ui` gains no dependency and the API gains no surface. Rendering a work is unchanged.
