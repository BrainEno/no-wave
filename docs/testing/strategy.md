# Testing Strategy: Behavior-First, Risk-Based

## Policy

Use behavior-driven requirements and risk-based verification, with selective TDD for high-risk logic. Do not mandate full TDD for every line or Gherkin/Cucumber for every feature.

The objective is to catch user-visible regressions, security failures and data-integrity problems at the lowest reliable cost—not to maximize test count or coverage percentage.

## Workflow

1. Describe the observable behavior and acceptance criteria.
2. Assign risk: critical, high, medium or low.
3. Choose the cheapest reliable verification layer.
4. For critical/high-risk behavior and bug fixes, write a test that fails for the expected reason before implementation (Red).
5. Implement the smallest correct change (Green).
6. Refactor while keeping tests green.
7. Run the focused checks, then the relevant package suite and full CI checks when feasible.
8. Report actual results; never infer success from unrun checks.

If test-first is impractical, explain why and provide proportionate verification.

## Risk levels

### Critical / high

Always automated before acceptance where technically feasible:
- authentication, session refresh/logout and authorization;
- preventing user impersonation through client-supplied IDs;
- private conversation access and participant management;
- message/notification persistence, idempotency, retry and offline recovery;
- data migration and concurrency-sensitive updates;
- private cache isolation and sensitive-data exposure;
- destructive actions and payment/security-sensitive behavior if introduced.

Use unit tests for pure policy and domain rules, integration tests for persistence/transactions, API/contract tests for exposed operations, and a small number of E2E tests for complete journeys.

### Medium

Automate representative behavior:
- blog CRUD and publishing state;
- follow/unfollow, like/unlike and comments;
- editor serialization and validation;
- public metadata, canonical URLs, sitemap and not-found behavior;
- API error handling and generated contract compatibility.

### Low

For static copy, simple presentational styling and trivial component markup, use review, typecheck, lint, visual checks or targeted tests as appropriate. Do not add a test solely to cover a getter, constant or styling detail with no meaningful behavior.

## Test layers

- **Unit:** pure functions, validation, domain rules, authorization policy and event/idempotency logic.
- **Integration:** real isolated database or disposable containers for persistence, unique constraints, transaction behavior and query isolation.
- **Contract:** GraphQL schema/operation validation and generated client types.
- **E2E:** a small critical user journey set: sign-in, publish/read article, follow, comment/like, send message, offline recovery and access denial.
- **Manual exploratory:** visual quality, responsive behavior, accessibility and PWA installation on supported devices. Record what was checked.

Do not repeat the same assertion at every layer. Each layer should catch a different class of failure.

## Reliability scenarios

- Unauthenticated requests cannot access private resources.
- Non-participants cannot read, send to or mark a conversation read.
- Altering senderId/userId in a request cannot impersonate another account.
- Persisted messages can be retrieved after recipient offline time.
- Duplicate event delivery does not create duplicate logical notifications.
- A failed push does not erase the underlying message/notification.
- Retry and reconnect recover from transient delivery failures.
- Private responses have appropriate non-public cache policy.
- Public article pages render crawlable content and expected metadata.
- Unit tests run without production credentials or external production services.

## Tooling guardrails

- Start with the test runner best supported by the chosen framework and API stack; avoid adding multiple test frameworks without a demonstrated need.
- Avoid real network calls in unit tests, arbitrary sleeps, and shared mutable fixtures.
- Freeze time/control randomness where needed.
- Do not weaken or delete tests to make CI pass. If behavior intentionally changes, update acceptance criteria and tests in the same reviewed change.
- Do not set a blanket 100% coverage requirement. Establish a baseline after the initial test suite exists and use coverage as a diagnostic, not the goal.
- CI should run formatting/lint, typecheck, relevant tests, contract generation/checks and production builds. Security/dependency checks should be added with actionable failure policies.

## Completion report

List each check actually run, result, and relevant command. State which checks were not run and why.
