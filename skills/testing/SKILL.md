---
name: testing
description: Writing tests that would catch a real regression, including the failure paths
tasks: [TEST_GENERATION, BUG_FIX]
keywords: [test, tests, testing, spec, coverage, vitest, jest, assertion]
extensions: [.test.ts, .test.tsx, .spec.ts]
---

## A test earns its place by failing when the code is wrong

Before writing one, decide what change it would catch. A test that passes
against a broken implementation is worse than no test: it costs time to run and
buys confidence that is not there.

The name states the behaviour, not the function. "returns 404 when the order
does not exist" beats "test getOrder".

## Test the failure paths

Most defects live there, and most test suites do not go there. For anything that
can fail: the error path, the empty case, the boundary, and the concurrent case
if one exists.

## Assert on outcomes, not on implementation

Assert what the caller observes. A test that asserts a private method was called
breaks on every refactor and passes when the behaviour regresses — the exact
inverse of what it is for.

## Never make a test pass by weakening it

Do not delete an assertion, skip the test, widen a matcher, or add a retry to
get green. If a test is wrong, say so and fix it deliberately.
