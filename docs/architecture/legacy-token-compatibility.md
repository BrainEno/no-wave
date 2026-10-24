# Legacy access-token compatibility and migration plan

## Verified legacy issuer behavior

Reviewed the legacy backend implementation at:

- `src/utils/sendRefreshToken.ts`: `createAccessToken` signs with `ACCESS_TOKEN_SECRET`, sets a 15-minute expiry, and includes `_id`, `name`, `username`, `tokenVersion`, and `role`. It does not add `iss`, `aud`, or `sub`.
- `src/middlewares/authChecker.ts`: authorization verifies the bearer token with `ACCESS_TOKEN_SECRET`; the admin middleware assigns the decoded payload to `context.user`.
- `src/resolvers/AuthResolvers.ts`: login and refresh flows currently log access-token values. This is a credential-exposure risk and should be removed in the legacy backend before further production use.

Sources:
- https://github.com/BrainEno/bot-thk-gqlserver/blob/main/src/utils/sendRefreshToken.ts
- https://github.com/BrainEno/bot-thk-gqlserver/blob/main/src/middlewares/authChecker.ts
- https://github.com/BrainEno/bot-thk-gqlserver/blob/main/src/resolvers/AuthResolvers.ts

## Compatibility conclusion

The new API verifier intentionally requires HS256 plus exact `iss`, matching `aud`, a future `exp`, and a non-empty `sub`. Consequently, the currently observed legacy access tokens are **not compatible**: they use `_id` instead of `sub` and do not include the required issuer/audience claims. The verifier also does not yet query a user store to enforce legacy `tokenVersion` revocation.

Do not make the new verifier accept missing issuer/audience or silently fall back from `sub` to `_id`. That would turn a deliberate token contract into an ambiguous trust boundary.

## Safe migration sequence

1. Remove access/refresh token values from legacy logs; log only event names and non-sensitive correlation IDs.
2. Agree on a stable issuer and API audience and define whether access tokens are shared between services or exchanged for API-specific tokens.
3. Update the trusted issuer to issue tokens with `iss`, `aud`, `sub`, `exp`, and the selected signing algorithm. Use a high-entropy secret of at least 32 bytes if HS256 remains the chosen algorithm. Prefer asymmetric signing if multiple services need verification without token-minting capability.
4. Decide how `tokenVersion` or another revocation/session mechanism will be checked. Signature and expiry alone do not invalidate a token after a user's session is revoked.
5. Add contract tests using issuer-produced fixtures and a negative compatibility test for the old token format.
6. Roll out only after issuer and API configuration are provisioned through secret management and end-to-end tests pass. Never place production secrets in repository files or CI logs.

## Current boundary

This repository currently implements and tests the verification mechanism and a minimal `viewer` query. It does not yet integrate with the legacy issuer or a database-backed user/session store, and it does not protect future domain operations automatically. Keep deployment disabled until the migration sequence and authorization coverage are complete.
