# UI polish decisions: reading, writing and error pages

Status: archived

This records the decisions made for issues #284 and #286 against the current
implementation. Those issues contain the same brief; the longer list mentioned
in their acceptance criteria is not in the issue body. Do not treat this note as
an exhaustive disposition of an unavailable checklist.

## Adopted

### Put the writing surface first

A signed-in writer sees the title and body before the profile form and inbox.
The author profile and notification inbox remain mounted, with their existing
controls and error handling, after the editor. The article list remains adjacent
on a wide screen and precedes the editor on a narrow screen. Language, work type
and optional summary remain editable below the body, rather than consuming the
first screen before writing begins. Nothing about publication or draft recovery
is changed by this layout.

The 2026-11 v3 redesign keeps this order. The workspace header is one line
(identity on the left, text links on the right), the article list is a sticky
248-pixel column, the title is a borderless input above a sticky format toolbar,
and save/publish sit in a sticky bar under the editor. Profile, notifications
and trash are an always-visible "appendix" of three cards. On tool routes the
site navigation scrolls away with the page instead of covering the title. See
`packages/web-ui/docs/UI_DESIGN_SYSTEM.md` §22.

The desktop acceptance target is a 1440 × 900 viewport with the entire title
input and at least the first 100 pixels of the body visible without scrolling.
The browser test also exercises a 390-pixel viewport, keyboard-editable fields,
mobile overflow and the continued availability of profile and notifications.

Evidence: [workspace](../../packages/web-ui/src/components/authoring/authoring-workspace.tsx),
[editor](../../packages/web-ui/src/components/authoring/article-editor.tsx),
[browser test](../../e2e/reading-writing-polish.spec.ts).

### Avoid repeating a standfirst

When the displayed summary is already the opening of the rendered article,
including a truncated excerpt ending in an ellipsis, suppress the standfirst on
the reader page. A distinct editorial summary remains visible. This affects only
the reader's visual heading, not the stored summary, search results, feeds or
SEO metadata. The comparison uses prose blocks, excludes images and code as the
API summary generator does, and handles whitespace and paragraph boundaries.
Older or unusual content that does not compare confidently keeps its summary.

Evidence: [comparison](../../packages/web-ui/src/lib/article-standfirst.ts),
[comparison tests](../../packages/web-ui/src/lib/article-standfirst.test.ts),
[API summary generator](../../apps/api/src/domain/article-summary.ts).

### Preserve context on failure

The 404 and service-error boundary keep normal navigation and use the same
heading offset as other pages. A missing page says the link may be stale or the
work unpublished. An unavailable service asks the reader to try again. HTTP
status, privacy and robots headers are unchanged; a backend 503 is not turned
into a successful page.

Evidence: [boundary](../../apps/web-rr/app/root.tsx),
[HTTP tests](../../apps/web-rr/test/web.test.ts),
[browser test](../../e2e/reading-writing-polish.spec.ts).

### Do not offer disabled email

The writing route now passes its server-side mail feature flag to the workspace.
When disabled, an unverified address is still described as unverified, but the
button that cannot send a verification email is not offered. When enabled, the
existing verification action remains available; authorization and API-side mail
configuration remain authoritative. The account page already follows this rule.

Evidence: [writing route](../../apps/web-rr/app/routes/write.tsx),
[workspace](../../packages/web-ui/src/components/authoring/authoring-workspace.tsx),
[account panel](../../packages/web-ui/src/components/auth/account-panel.tsx).

## Deferred / not inferred

- The issue refers to other backlog items but does not include their descriptions;
  ask for the full list rather than inventing or silently rejecting items.
- Moving the inbox below the editor does not add polling, push delivery or change
  the notification retention policy. The bell remains available in the chrome.
- No new preview, cover picker or submission-approval workflow is introduced.
- No visual redesign or new product decision is implied by this layout change.
