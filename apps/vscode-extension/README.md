# AICA — API Integration & Code Intelligence

Takes an API, an intent, and the codebase you already have, and works out what
to change — from evidence rather than from a guess.

Most of what it does needs no model at all.

## What it does

**Reads your codebase properly.** Builds a symbol and reference index with the
TypeScript compiler, then a dependency graph on top of it. "What depends on
this?" is answered from the AST, and the answer says what it could _not_ see —
a reference reached through a property access needs a type to resolve, and a
report that quietly omitted those would be confidently wrong.

**Imports an API and tells you if you already call it.** OpenAPI, Swagger,
Postman collections, a pasted cURL command, or a Postman workspace. Every source
lands in the same intermediate representation, and each endpoint is matched
against the URLs actually present in your code — including when the base path
lives in a `BASE_URL` constant and the specification's path carries it instead.
"Three call sites" and "not called yet" are different tasks, and the catalog
knows which one you have.

**Plans deterministically before a model is involved.** The plan names files,
quotes signatures the index actually holds, states which files not to touch, and
lists what it could not determine. A plan the evidence does not support arrives
as a question rather than as work.

**Proposes changes; you decide.** Nothing is written until you say so. The diff
you review is against the file as it is _now_, not a snapshot from when the run
started. A revert restores content captured at apply time rather than inverting
a diff.

**Validates what it wrote, and repairs within a budget.** Typecheck, lint,
tests, build. A check with no configured command is reported as _skipped_, never
folded into "passed" — and a run that changed nothing reports "no changes"
rather than a tick.

**Connects to MCP servers**, with per-tool risk classification. A server's claim
that its own tool is read-only buys one step down, never a free pass; only you
can mark a specific tool trusted.

## Getting started

1. Open a folder. The extension starts a local agent server for it.
2. **AICA: Index Workspace** — this is what everything else reads.
3. **AICA: Import API Specification** — a file, the clipboard, or Postman.
4. Open the chat and describe what you want.

Steps 1–3 need no API key. Step 4 needs a model.

## Configuration

An optional `agent.config.json` in your project root. Every default is the
cautious one: the agent proposes rather than writes, no command runs that is not
allowlisted, and nothing is sent anywhere you have not configured.

```json
{
  "model": { "provider": "openrouter", "model": "anthropic/claude-sonnet-4.5" },
  "permissions": { "approvalMode": "askAlways" },
  "validation": { "typecheck": ["pnpm", "typecheck"], "test": ["pnpm", "test"] },
  "limits": { "maxFilesChanged": 25 }
}
```

**A key never appears in configuration.** It holds a _reference_ —
`env:OPENROUTER_API_KEY`, `keychain:postman` — and a literal credential there is
a validation failure rather than a leak. Set the value with an environment
variable, or for Postman use **AICA: Set Postman API Key**, which puts it in the
OS keychain through VS Code's SecretStorage.

Set `"model": { "provider": "scripted" }` for a dry run: the plan is real, the
writing is not, and nothing reaches a network.

## What it will not do

Worth knowing before you install it.

- **It will not write without permission** in the default modes. It is not given
  a tool that writes.
- **It will not disable a test to make validation pass.** That is stated in its
  instructions and the validation layer would report the change regardless.
- **It will not put a credential in code.** Authentication is described as a
  scheme and a reference; a value never enters the model's context.
- **It will not read outside your project.** Every path is resolved, symlinks
  included, and checked for containment.
- **It will not claim a check passed that did not run.**

## Privacy

The agent server is a local process. Your code is read locally and indexed
locally. What leaves the machine is what you configure: prompts to your chosen
model provider, and requests to APIs you point it at. Both are recorded in an
egress ledger — destinations and volumes, never payloads — and
`"privacy": { "localOnly": true }` refuses egress entirely.

Optional history is stored in Postgres, off by default, and metadata only: file
paths, symbol names, signatures, and the graph between them. Source text, doc
comments, prompts, and model output are never stored, because the schema has no
column for them.

## Requirements

- VS Code 1.96 or later
- Node.js 22 or later
- A TypeScript or JavaScript project. Other languages are not yet indexed.

## Known limits

- Indexing covers TypeScript and JavaScript only.
- Symbol resolution is syntactic. A reference through a property access is
  counted but not attributed, and impact reports say so rather than guessing.
- The bundled agent server is large, because it carries the TypeScript compiler.

## Licence

MIT.
