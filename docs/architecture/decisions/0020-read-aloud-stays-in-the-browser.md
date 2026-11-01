# ADR 0020: Read-aloud stays in the browser

- Status: Accepted
- Date: 2026-11-01
- Borrowed from [`red-room-archive`](https://github.com/BrainEno/red-room-archive), whose article
  pages read a work aloud with the same platform API. What is borrowed is the *idea*, not the code:
  that project is Astro with per-page scripts, this one is React Router with shared client
  components, so only the behaviour travels.

## Context

A literary site is read with the eyes and, for some readers, not only with the eyes. The
`red-room-archive` pages offer 朗读, and the gesture is worth having here: a work is already on the
screen in full, and a reader who is tired, commuting, or simply listening deserves the same text
read aloud.

The alternative readings of "add read-aloud" are heavier than the feature:

- a server-side speech endpoint, which would mean storing or streaming generated audio, paying for
  synthesis per article, and holding a copy of every work in a second format;
- a client-side audio library, which would add a dependency and ship a voice the reader's own
  operating system already has;
- a component that assumes the capability exists, which would put a button on the page that does
  nothing on the browsers where it is missing.

## Decision

Reading aloud is a **browser capability and nothing else**.

- The engine is the platform's Web Speech API (`speechSynthesis`). No new dependency, no new
  package, no audio file, no upload.
- **No server involvement at all**: no endpoint, no port method, no account data, no telemetry.
  The page already holds every word of the work; the only thing that can say them is the reader's
  own device, and nothing about the reading is reported back.
- **What is said is derived from the content blocks**, not scraped from the DOM — the same blocks
  the page renders, in the same order, with the same ids. So the list of things to say is identical
  before and after hydration, and the component can point at the paragraph it is speaking without
  guessing.
- **The unit is the paragraph**, split only when a sentence is longer than a mouthful (`CHUNK_LIMIT`
  characters), and split at punctuation or a word boundary rather than mid-word. Code blocks are
  not read; an image contributes its caption and not its alt text, which describes the picture
  rather than being part of the work.
- **Where the engine is missing the control is absent, not disabled.** `speechSynthesis` is
  detected in an effect, so the server renders nothing and no reader is shown a button that cannot
  work.
- **The language asked for is the work's own locale** (`zh-CN`, `zh-TW`, `en-US`). The voice is the
  browser's choice: the project does not pick, download or pin one, because which voice a reader
  can hear is a fact about their device.
- **One utterance at a time.** A queue cannot be paused mid-utterance without losing the reader's
  place, and stopping has to feel immediate — `cancel()` cannot interrupt what has already been
  handed over, so the wait after 停止 is at most one chunk.
- **Leaving the page ends the reading.** Navigating away unmounts the component and cancels: an
  utterance that outlives its article talks over whatever the reader went to next.
- The block being spoken is marked with `.nw-speaking` and scrolled into view **only when it is off
  screen** — following along must not take the paragraph away from a reader who is already looking
  at it.

## Consequences

- The logic that decides *what* is said lives in `packages/web-ui/src/lib/read-aloud.ts` as pure
  functions and is tested there (`read-aloud.test.ts`) without a browser. What is left in the
  component is exactly the part that needs one.
- The rendered article blocks carry `data-block={block.id}`, so reader features can address a
  paragraph by the content's own id rather than by position. 划线的 anchors need the same thing.
- `ReadAloud` renders nothing until after hydration, so no HTTP-level or HTML assertion can see it.
  The client bundle is therefore asserted (`client-bundle.test.ts`, sentinel `speechSynthesis`) —
  the check that catches "the page renders and never hydrates".
- The page's half of the behaviour is covered in a browser (`e2e/read-aloud.spec.ts`) with the
  **engine replaced by a fake**: a headless browser has no voices installed, so the real one cannot
  be driven, and what is left to prove — the order the paragraphs are handed over, the mark that
  follows them, stopping, and the control's absence when the capability is missing — is the
  application's own. How any particular voice sounds is not this project's claim.
- Voice quality, availability and rate are the reader's browser's business and are not part of this
  project's contract. A site that promised a voice would be promising something it cannot ship.
- Nothing is persisted. Not the position, not the rate, not the fact that a work was read aloud.
  If a future change wants a reading position or a per-reader voice, that is a new decision and a
  new place where reader data would be stored.
