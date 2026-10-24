# Acceptance Scenarios: Security and Authorization

These are behavior contracts, not a mandate to create a separate Gherkin file or a separate E2E test for every scenario. Implement each scenario at the cheapest reliable layer, with integration coverage for persistence and a small number of end-to-end journeys.

## AUTH-01 — Client cannot choose its identity

**Risk:** Critical

Given Alice is authenticated and Bob is another existing user  
When Alice sends a message request that includes Bob's ID as `senderId`  
Then the API must derive the sender from Alice's authenticated context  
And the persisted message must never claim Bob as its sender.

## AUTH-02 — Unauthenticated requests cannot mutate private state

**Risk:** Critical

Given no valid session is present  
When the client attempts to send a message, mark a conversation read, follow a user or edit a profile  
Then the API rejects the operation  
And no message, relationship, profile or read-state change is persisted.

## AUTH-03 — Non-participants cannot read a conversation

**Risk:** Critical

Given Alice and Bob are participants in a conversation and Carol is not  
When Carol requests the conversation or its messages  
Then the API denies access without exposing message bodies, participant details or unread state.

## AUTH-04 — Non-participants cannot alter read state

**Risk:** Critical

Given Alice and Bob are participants in a conversation and Carol is not  
When Carol submits a read-state mutation for that conversation  
Then the API rejects it  
And Alice's and Bob's read states remain unchanged.

## AUTH-05 — Blog ownership is enforced

**Risk:** Critical

Given Alice owns a draft and Bob is a different authenticated user  
When Bob tries to update or delete Alice's draft  
Then the API rejects the operation  
And the draft remains unchanged.

Given an authorized administrator acts under the documented admin policy  
When the administrator updates or deletes a blog  
Then the operation succeeds and is auditable.

## AUTH-06 — Private account fields are not public profile fields

**Risk:** High

Given an anonymous visitor requests a public profile, user search results or follower lists  
When the API returns public user data  
Then it excludes email, password hashes, reset tokens, session tokens and other private account fields.

Given Alice requests her own account settings  
When the API returns account data  
Then it returns only the private fields explicitly required by that screen.

## AUTH-07 — Sensitive credentials never enter logs

**Risk:** Critical

Given login, refresh, logout or password reset succeeds or fails  
When application logs are emitted  
Then access tokens, refresh tokens, reset tokens, passwords, cookies and authorization headers are redacted  
And logs contain enough non-sensitive context to diagnose the failure.

## AUTH-08 — Password reset does not disclose account existence or reset secrets

**Risk:** High

Given an email address may or may not belong to an account  
When a password-reset request is submitted  
Then the public response does not reveal account existence  
And the API never returns a reset token or token-bearing URL as a fallback.

## CACHE-01 — Private response cannot leak through shared cache

**Risk:** Critical

Given Alice is authenticated and requests private account or conversation data  
When the response passes through a shared cache or CDN  
Then the response is not reusable by Bob or an anonymous visitor  
And route-level cache policy is explicitly tested.

## Required negative assertions

For every rejected mutation, verify both the error/response and the absence of side effects. A test that only checks an error message is insufficient for authorization and data-integrity behavior.
