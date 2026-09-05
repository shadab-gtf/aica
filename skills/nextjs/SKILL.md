---
name: nextjs
description: Next.js App Router — server and client components, data loading, route handlers
requires: [next]
extensions: [.tsx, .ts]
keywords: [next, nextjs, app, router, server, client, route, page, layout]
---

## Server by default, client when there is a reason

A component becomes a client component because it needs state, an effect, an
event handler, or a browser API — not because it is easier. `'use client'` at the
top of a tree pulls everything below it into the bundle.

## A secret in a client component is a published secret

Anything a client component can read ships to the browser, including anything
passed to it as a prop. Read credentials in server components and route handlers
only. `NEXT_PUBLIC_` means public: treat the prefix as a declaration, not a
convenience.

## Say what is dynamic

Caching defaults change between versions and are the most common source of "it
works locally". Be explicit about revalidation on a fetch or a route rather than
relying on whatever the current default is.

## Route handlers validate their input

A route handler is a public HTTP endpoint. Parse and validate the body, the
query, and the params before using them, and return a status the caller can act
on.
