/**
 * 分享一段划线 — one passage, in a link.
 *
 * A mark lives in the reader's own browser and never leaves it (ADR 0021), and
 * sharing one has to keep that promise. What travels is therefore not the mark
 * but a **URL fragment**: the words, on the work's own page. A fragment is not
 * part of an HTTP request — the server is never told it was there — so this
 * needs no endpoint, no port method, no account and no table, and it leaves no
 * record behind of who shared what.
 *
 * That rules out the obvious alternatives. A short link would be tidier to look
 * at and would need somewhere to keep it, which is a store of other people's
 * reading. Sending the passage to the server to be rendered is simply the
 * server-side highlights table ADR 0021 refused, arriving by the back door.
 *
 * What is in the link is **the work's own words and where they sit**: the
 * offsets, and the quoted text itself. Not the note — that was written beside
 * the words and belongs to whoever wrote it, and a link that carried it would
 * publish a private thought under the cover of sharing a sentence. Not the
 * surrounding context either: it is what finds a passage after an edit, and a
 * link born at one moment does not need it, because the reader who follows it
 * has the whole work in front of them and `relocate` will search it.
 *
 * Everything here is pure, so the encoding is testable without a browser.
 */

import { PASSAGE_LIMIT, characterCount, type PassageAnchor } from "./passages.ts";

/** The fragment a shared passage arrives under. */
export const SHARE_PREFIX = "nw-p=";

/**
 * A passage, as a link carries it.
 *
 * `start`/`end` are the offsets the sharer saw; they are a hint, not a fact —
 * the work may have been edited since, which is exactly why the words come
 * along.
 */
export type SharedPassage = { start: number; end: number; text: string };

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const SIX_BIT: Record<string, number> = Object.fromEntries(
  Array.from(ALPHABET, (character, index) => [character, index]),
);

/**
 * Bytes as base64url, without padding.
 *
 * Written out rather than taken from `btoa`, which wants a binary string and so
 * needs a second encoding on top for anything outside Latin-1 — and which is
 * the deprecated global in Node. Twenty lines of shifting is the smaller cost,
 * and it behaves identically in the browser, in the test runner and in a reader
 * who has no idea any of this is happening.
 */
function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const left = bytes[index]!;
    const middle = bytes[index + 1];
    const right = bytes[index + 2];
    out += ALPHABET[left >> 2];
    out += ALPHABET[((left & 0x03) << 4) | ((middle ?? 0) >> 4)];
    if (middle === undefined) break;
    out += ALPHABET[((middle & 0x0f) << 2) | ((right ?? 0) >> 6)];
    if (right === undefined) break;
    out += ALPHABET[right & 0x3f];
  }
  return out;
}

/**
 * Base64url back to bytes, or `null`.
 *
 * Strict on purpose: characters outside the alphabet, a stray `=` and bits left
 * over at the end are all refused rather than guessed at. A link is written by
 * hand and edited by accident, and a passage that decodes to the wrong words is
 * worse than one that does not decode at all.
 */
function fromBase64Url(value: string): Uint8Array | null {
  if (value.length === 0) return null;
  if (value.length % 4 === 1) return null;
  const bytes: number[] = [];
  let bits = 0;
  let held = 0;
  for (const character of value) {
    const six = SIX_BIT[character];
    if (six === undefined) return null;
    bits += 6;
    held = (held << 6) | six;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((held >> bits) & 0xff);
    }
  }
  // Bits left over mean the last character carried more than it was entitled
  // to: a second, different spelling of the same bytes, refused here so that
  // one passage has one link.
  if (bits > 0 && (held & ((1 << bits) - 1)) !== 0) return null;
  return Uint8Array.from(bytes);
}

/** The passage, as the part of a fragment after `nw-p=`. */
export function encodeSharedPassage(anchor: SharedPassage): string {
  const text = anchor.text.slice(0, PASSAGE_LIMIT);
  return `${Math.trunc(anchor.start)}.${Math.trunc(anchor.end)}.${toBase64Url(new TextEncoder().encode(text))}`;
}

/**
 * Read a passage out of a fragment, or `null` when there is not one there.
 *
 * `null` is the ordinary answer as much as the failure one: most addresses have
 * no shared passage in them, and a link that has been cut short in a chat
 * window is not an error to report, it is a page to read.
 */
export function decodeSharedPassage(hash: string): SharedPassage | null {
  // Whole addresses are accepted as well as bare fragments: the reader of this
  // function always has a fragment to hand, but a caller that has an address
  // should not have to know that, and a link pasted into the wrong place is
  // still a link.
  const at = hash.indexOf("#");
  const trimmed = at >= 0 ? hash.slice(at + 1) : hash;
  if (!trimmed.startsWith(SHARE_PREFIX)) return null;
  const body = trimmed.slice(SHARE_PREFIX.length);
  const parts = body.split(".");
  if (parts.length !== 3) return null;
  const [rawStart, rawEnd, payload] = parts;
  if (!/^\d{1,7}$/.test(rawStart) || !/^\d{1,7}$/.test(rawEnd)) return null;
  const start = Number(rawStart);
  const end = Number(rawEnd);
  if (end <= start) return null;
  const bytes = fromBase64Url(payload);
  if (!bytes) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  if (text.length === 0 || characterCount(text) > PASSAGE_LIMIT) return null;
  return { start, end, text };
}

/**
 * A shared passage, as something the work can be searched for.
 *
 * A link brings no context of its own, and that is deliberate — 48 characters
 * on either side would double every link for a case that barely happens. It
 * costs nothing where it matters: `relocate` tries the offsets first and, when
 * they no longer hold the words, searches for them and takes the occurrence
 * nearest to where the sharer saw them. Without context to score by, that is
 * the whole rule, and it is the right one.
 *
 * What is saved afterwards is a different anchor — one built from the text on
 * *this* page, with its own context — so a passage taken from a link is
 * indistinguishable from one marked by hand from then on.
 */
export function searchablePassage(shared: SharedPassage): PassageAnchor {
  return { start: shared.start, end: shared.end, text: shared.text, prefix: "", suffix: "" };
}

/**
 * The address one reader hands to another.
 *
 * Anything already in the fragment is dropped: a shared passage is the only
 * thing that belongs there, and a reader who follows two links in a row should
 * get the second one.
 */
export function passageShareUrl(address: string, anchor: PassageAnchor | SharedPassage): string {
  const base = address.split("#")[0] ?? "";
  return `${base}#${SHARE_PREFIX}${encodeSharedPassage(anchor)}`;
}
