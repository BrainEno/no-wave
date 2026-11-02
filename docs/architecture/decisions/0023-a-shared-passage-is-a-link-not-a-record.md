# ADR 0023: A shared passage is a link, not a record

- Status: Accepted
- Date: 2026-11-02
- Extends [ADR 0021](0021-reading-marks-stay-on-the-readers-device.md), which lists sharing a passage
  under "deliberately not included" and is the reason this decision has to be made explicitly rather
  than quietly added.

## Context

Underlining a sentence is half a reading practice; the other half is showing it to somebody. ADR 0021
kept marks in the reader's browser and refused to record them on the server, and that decision is not
in question — it is why the feature can exist without an account.

The obvious way to add sharing is the obvious way to lose that: a share writes the passage somewhere
(a row, a short code, a card), and the moment it does, the server is holding a record of what a
particular reader marked, or shared, or was reading when they shared it. A short link is tidier to
look at than a long one and needs a table, an expiry rule and a deletion path. A rendered share card
needs an endpoint that takes someone else's words and an image pipeline. Each of them is the
server-side highlights table ADR 0021 refused, arriving by the back door.

What makes a link enough is that the work is already on the page. A passage is a span of words the
reader can see; the reader who follows a link has the same span in front of them and needs only to be
told which one.

## Decision

A shared passage is **the work's own words, in a URL fragment, on the work's own page.**

- **The fragment is the whole transport.** `#nw-p=<start>.<end>.<base64url(text)>`. A fragment is not
  part of an HTTP request, so the server is never told a passage was shared, opened or declined.
  There is no endpoint, no port method, no table, no short code, and nothing to expire or delete.
- **What travels is the work's own words and where they sat.** Offsets first, then the quoted text as
  the fallback: if the work was edited, the offsets are a hint and the words are the fact. Nothing
  else is in the link — see the next point.
- **The note does not travel.** It was written beside the words and belongs to whoever wrote it. A
  share link that carried it would publish a private thought under cover of sharing a sentence. The
  dialog says so in one line before the reader copies anything.
- **A link never writes to the reader's device.** Opening one paints the passage under a highlight
  name of its own (`nw-passage-shared`), scrolls to it and offers 保存到我的划线. Nothing is saved
  until that button is pressed: a page must not edit a reader's shelf on the strength of an address.
  What is saved then is rebuilt from the text on *that* page, with its own context on both sides, so
  from then on the mark is indistinguishable from one made by hand.
- **A link that no longer matches the work marks nothing.** The passage is looked for in the work's
  text; if the words are gone (or were never there — anyone can write any sentence into a fragment),
  the card says so and nothing is painted. A link may carry words the work does not contain; the work
  decides, not the link.
- **Dismissed means dismissed**: 关闭 clears the highlight and takes the fragment out of the address,
  so a reload does not ask the same question again.
- **The link is on the screen**, selected, in a read-only input, with 复制链接 beside it. Browsers
  that refuse the clipboard API are not a failure mode to report: the reader copies by hand.

### Deliberately not included

- **Short links.** They need storage, and storage is the thing this decision declines to add. A long
  link that says what it carries is the honest trade.
- **Share cards, images, and social previews.** They need an endpoint that renders text supplied by a
  stranger and somewhere to put the result.
- **Sharing straight from the selection toolbar.** A passage is shared from the shelf, where it
  already lives; adding it to the toolbar would be a second copy of the same button.
- **Counts, analytics, or "shared N times".** Counting a private act is how a reading history starts.
- **Sharing a note, or a set of passages.** One passage, one link.

## Consequences

- `packages/web-ui/src/lib/passage-share.ts` is pure and tested without a browser (11 tests): the
  encoding round-trips in every alphabet a work is written in, and every malformed, truncated or
  hand-edited fragment decodes as `null` rather than as a passage nobody marked.
- The browser half lives in `PassageAnnotations`, next to the marks it extends, and is covered by two
  journeys in `e2e/passages.spec.ts`: one reader marks and shares, another opens the link in a fresh
  browser — with nothing in it — and takes the passage onto their own shelf; and a link whose words
  are not in the work says so and paints nothing.
- A shared passage is only as durable as the words: if the author edits or deletes them, the link
  stops working. That is the same bargain the marks themselves make (ADR 0021), and it is the right
  one — the alternative is a copy of the work's text kept somewhere for a link to point at.
- Links are long, and a passage of the maximum length makes a URL of a few hundred characters. Chat
  applications truncate them; truncation is handled rather than feared: what survives decodes as a
  shorter passage of the same words, and the work is still searched for those.
- No new dependency, no API surface, no migration.
