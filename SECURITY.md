# Security policy

## Reporting a vulnerability

Please do not put exploit details, secrets, credentials, private data or a
working proof of concept in a public issue, pull request, discussion or commit.
Report privately so maintainers have time to investigate and coordinate a fix.

When GitHub private vulnerability reporting is enabled for this repository,
use [Report a vulnerability](https://github.com/BrainEno/no-wave/security/advisories/new).
If that option is unavailable, contact the repository owner through an existing
private channel and ask how to share a security report; do not publish the
vulnerability as a workaround. Repository administrators must enable private
vulnerability reporting in **Settings → Security → Code security and analysis**
for the GitHub form to be available. This file alone does not enable it.

A useful report includes the affected version or commit, prerequisites, a
minimal reproduction, expected and actual behavior, impact, and any proposed
mitigation. Redact tokens and personal data. Do not test on someone else's
instance, or perform destructive tests against production systems.

Maintainers should acknowledge reports, assess impact and affected versions,
prepare a fix and regression test, and coordinate disclosure with the reporter.
No response or remediation timeline is promised until the project has a
maintained security contact and an agreed service level.

## Supported versions

The project is currently developed on `main`; no long-term support branches or
backport guarantees have been announced. Operators should update to a reviewed,
tested current revision and follow the deployment guidance in the README.

## Dependency and code checks

The required CI `verify` job audits the complete pnpm lockfile at high severity,
including development dependencies. Registry or network failures fail the check;
they are not silently treated as a clean audit. The CodeQL workflow analyzes
JavaScript and TypeScript on pull requests and main. Dependabot is configured for
weekly grouped npm and GitHub Actions updates. These checks complement review,
tests and responsible disclosure; they do not prove the absence of vulnerabilities.
