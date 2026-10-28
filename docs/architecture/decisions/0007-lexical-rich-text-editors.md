# ADR 0007: Lexical for article and comment editors

- Status: Accepted
- Date: 2026-10-27
- Scope: Web editor technology; implementation is pending

## Context

The Web application uses Next.js App Router with React 19. Article bodies already use structured content blocks, while a production article editor, comment editor and media-upload workflow remain incomplete. Building two separate editor implementations would duplicate editing behavior, keyboard handling, accessibility work, paste handling and serialization logic.

Lexical is an extensible editor framework with official React bindings, a structured editor state, history support and extension points for rich-text nodes. Its documented use cases include both short-form comment/message inputs and full document editors. This fits the application's two editor surfaces while allowing each to expose a different capability set.

## Decision

1. **Use Lexical for both the article editor and the comment editor.** Treat it as the shared editing engine, not as a commitment to make both editors equally powerful.
2. **Use separate editor configurations.**
   - The article editor may expose paragraphs, headings, quotations, ordered/unordered lists, inline formatting, links and approved code/image nodes. Each capability must be enabled only when its content contract and rendering path support it.
   - The comment editor should start with a deliberately smaller set: paragraphs, basic inline formatting and links. Do not enable images, code blocks, tables, arbitrary embeds or other heavy nodes without a separate product need.
3. **Keep the business content contract application-owned and versioned.** Do not make Lexical's internal JSON shape or arbitrary HTML the long-term REST/database contract. Add explicit, tested adapters between Lexical editor state and the application's structured document schema. Preserve unsupported data rather than silently flattening or dropping it.
4. **Version the application schema independently of Lexical.** Article content version 0 is the existing block array. Version 1 adds optional inline runs to paragraph/heading/quote blocks and per-item inline runs to lists; each run may carry an allowlisted set of marks and a safe link target. The plain-text fallback must exactly equal the concatenation of inline runs so older consumers never silently render stale text. The version is persisted on each article translation. The comment API/storage contract must also be upgraded explicitly if rich-text comments are to persist formatting; do not put Lexical JSON into an existing plain-text field without a contract change.
5. **Validate at the server boundary.** The API validates content version, allowed node fields, unique block IDs, text and collection limits, inline mark names, exact plain-text fallbacks, safe link schemes and image URL syntax independently of client-side validation. Version 1 supports HTTP(S) and site-root-relative links only; protocol-relative links, URL credentials, executable schemes, arbitrary HTML and unrecognized block properties are rejected. Image references must still follow the separately approved upload/storage flow. Public rendering must use a safe structured renderer or properly sanitized generated markup; never treat client-submitted HTML as trusted content.
6. **Treat HTML and Markdown as interchange formats, not the source of truth.** Pasted HTML must be imported through an allowlisted conversion path. If export is needed for SEO, previews or copy/paste, generate it from the validated application document schema.
7. **Pin compatible dependencies and use supported APIs.** When implementation begins, install matching pinned releases of lexical and its React bindings, commit the lockfile, verify Next.js/React 19 compatibility in CI, and use the recommended composition API for that pinned release rather than starting with APIs already deprecated by it.
8. **Test Chinese and accessible editing behavior.** Acceptance coverage must include IME composition and cursor stability, undo/redo, keyboard-only operation, screen-reader labels, mobile layouts, paste/import edge cases, malformed payloads, and round-trip serialization without content loss.

## Alternatives considered

- **Two different editor libraries:** rejected because it duplicates maintenance and creates inconsistent editing and serialization behavior.
- **A plain contenteditable implementation:** rejected because the application would need to own browser selection, undo/redo, input-method-editor and paste edge cases.
- **Persist arbitrary HTML as the canonical body:** rejected because it makes validation, safe rendering, cross-client support and future schema evolution harder to control.
- **Expose Lexical's internal JSON as the public API contract:** rejected for now because the API should remain an application-owned, versioned contract usable by clients other than this React implementation.

## Consequences

- Article and comment editing share a maintained core while using different feature profiles.
- Article inline marks and hyperlinks now have an explicit version-1 application contract and additive persisted version column; version-0 rows remain readable without rewriting their content.
- Lexical-state adapters, comment rich-text persistence, media upload integration, safe public rendering and the editor UI remain implementation work. The API contract deliberately does not expose Lexical internal JSON as the canonical format.

## References

- [Lexical repository](https://github.com/facebook/lexical)
- [Lexical introduction](https://lexicaljs.org/docs/intro)
- [Lexical package/API documentation](https://lexicaljs.org/docs/api/)
- [Lexical releases and migration notes](https://github.com/facebook/lexical/releases)
