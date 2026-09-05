---
name: api-integration
description: Integrating a REST API into an existing codebase — clients, errors, auth, retries
tasks: [API_INTEGRATION, API_ANALYSIS, API_CHANGE_IMPACT]
keywords: [api, endpoint, rest, http, fetch, request, integrate, client, webhook]
extensions: [.ts, .tsx, .js, .jsx]
---

## Reuse the client that exists

Find the file that already makes HTTP calls and add to it. A second HTTP client
in one codebase means two places to fix a timeout, two places to add a header,
and two behaviours under failure. If the existing client is genuinely wrong for
this endpoint, say why before writing a new one.

Match what is already there: the same `fetch`/`axios`/`ky`, the same base-URL
constant, the same way errors are surfaced, the same naming.

## Authentication is a reference

Read the credential from wherever the codebase already reads it. Never write a
key, token, or secret into source, a test, a fixture, or a comment — not even a
placeholder that looks real. If no mechanism exists yet, add one that reads from
the environment and say so.

## Handle the failures the endpoint actually has

From the specification, not from habit:

- Every documented non-2xx status the caller needs to distinguish. A 404 that
  means "not found yet" and a 404 that means "wrong URL" are different bugs.
- A network failure, which is not a status code at all.
- A timeout. Every request gets one; the default is "forever".

Retry only what is safe to retry: a GET, or a documented idempotent write. Never
retry a POST that creates something unless the API documents an idempotency key.

## Types come from the specification

Derive request and response types from what the API documents, and let the
compiler check the call site against them. Do not hand-write a type that
approximates the response — approximations are where "sometimes null" lives.

## What to check before saying it works

- The call site compiles against the response type.
- The error path is exercised, not just the success path.
- Nothing logs the request headers.
