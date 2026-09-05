---
name: react
description: React components — state, effects, data fetching, and rendering states
requires: [react]
extensions: [.tsx, .jsx]
keywords: [react, component, hook, state, effect, render, ui, jsx]
tasks: [FRONTEND_REVIEW, GENERAL_DEVELOPMENT]
---

## Every async surface has three states

Loading, error, and empty are not edge cases; they are most of what a user sees.
A component that renders only the success path will render nothing, or a blank
box, at exactly the moment something has gone wrong.

Empty is distinct from loading. "No orders yet" and "still fetching" look the
same in a component that conflates them, and the user cannot tell whether to
wait.

## Fetch the way this codebase already fetches

If there is a data-fetching library — TanStack Query, SWR, a custom hook — use
it. Adding a bare `useEffect` beside it gives you two caching strategies, two
retry behaviours, and a race condition.

If the codebase does use raw effects, cancel on unmount and ignore a response
that arrives after the inputs changed.

## Effects are for synchronising with something outside React

Not for deriving state. If a value can be computed during render, compute it
during render. An effect that sets state from other state renders twice and
drifts.

## Keys identify, they do not order

A list key is a stable identity from the data. An array index reuses a key for a
different item the moment the list reorders, and React will keep the wrong DOM
node, the wrong scroll position, and the wrong input value.
