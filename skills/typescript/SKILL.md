---
name: typescript
description: TypeScript conventions — strict types, narrow returns, honest error handling
requires: [typescript]
extensions: [.ts, .tsx, .mts, .cts]
keywords: [typescript, type, types, interface, generic, strict]
---

## Types describe reality, not intent

If a value can be absent, the type says so. Widening to `any`, asserting with
`as`, or adding `!` to silence the compiler moves a runtime failure to somewhere
further from its cause. If the compiler is wrong, prove it with a narrowing
check rather than an assertion.

`unknown` at a boundary and a validator to narrow it. Never `any`.

## Follow the codebase, not the general style

Read the surrounding file first. If it returns a result object, return one. If
it throws, throw. Mixing the two in one module is worse than either.

## Errors carry what the caller needs to act

An error message names what failed and what to do about it. "Invalid input" is
not actionable; "expected `limit` to be a positive integer, received -1" is.

## Never weaken a check to make it pass

Do not add `// @ts-expect-error`, disable an ESLint rule, skip a test, or loosen
a type to get a green build. If a check is wrong, fix the check deliberately and
say why. A build that passes for the wrong reason is worse than one that fails.
