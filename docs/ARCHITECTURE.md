# API Integration & Code Intelligence Agent — Architecture

**Status:** Phase 0 (Discovery) complete. Living document; revised at each phase gate.
**Repository:** greenfield monorepo, `pnpm` workspaces, TypeScript, Node >= 22.

---

## 1. Problem statement

Transform three inputs — **an API**, **a user intent**, and **an existing codebase** — into a
software change that has been analyzed, planned, implemented, tested, validated, repaired, and
made reviewable. The system behaves as an autonomous senior engineer operating inside a real
repository, not as a code generator.

## 2. Governing principle: the LLM is not the source of truth

This constraint shapes every layer. Authority order, highest first:

1. The compiler / typechecker
2. The test suite and build
3. Actual repository contents (AST-derived facts)
4. The API specification
5. Real HTTP responses
6. Git state
7. LLM reasoning

The LLM is confined to **reasoning, planning, classification, mapping, and tool selection**.
Deterministic subsystems own **parsing, search, AST analysis, file mutation, process execution,
HTTP requests, and Git**. Whenever model output conflicts with deterministic evidence, the
evidence wins and the conflict is surfaced as a finding rather than silently reconciled.

A direct consequence: every fact the agent asserts must be traceable to a tool result. Tool
results are recorded in the run log, so any claim in a plan or report can be audited back to the
evidence that produced it.

## 3. Process topology

One local agent-server owns all state. Both user interfaces are clients.

```
┌────────────────────────┐        ┌──────────────────────────┐
│  VS Code Extension     │        │  Web Dashboard (Next.js) │
│  (extension host, CJS) │        │  (browser)               │
└───────────┬────────────┘        └────────────┬─────────────┘
            │ JSON-RPC over stdio              │ HTTP + SSE
            │ (child process, auto-spawned)    │ (localhost, token-auth)
            └───────────────┬──────────────────┘
                            ▼
              ┌──────────────────────────────┐
              │   Agent Gateway (protocol)   │
              ├──────────────────────────────┤
              │   Orchestrator               │
              │   Agent Runtime (loop)       │
              │   Tool Registry + Dispatcher │
              ├──────────────────────────────┤
              │ api-engine   code-intel      │
              │ mcp-engine   skill-engine    │
              │ validation   git-engine      │
              │ fs-engine    exec-engine     │
              │ security-engine  memory      │
              ├──────────────────────────────┤
              │  SQLite (index, runs, audit) │
              └──────────────────────────────┘
```

**Why a separate server process.** The code index, API catalog, run history, and audit log are
expensive to build and must be identical for both UIs. A single owner means one indexing pass, one
event bus, and one transaction boundary. Native modules (`better-sqlite3`) load in a plain Node 22
process rather than the VS Code extension host, avoiding ABI coupling to whichever Electron build
ships with the editor. The gateway is the only layer that knows about transports, so the same core
can later be hosted remotely without changes to either UI.

**Trust boundary.** The server is the policy enforcement point. UIs may _request_ anything; the
server decides. No security decision is made in a UI, because a UI can be bypassed.

## 4. Package layout

```
apps/
  vscode-extension/   VS Code UI: sidebar, chat, diff review, CodeLens, diagnostics, commands
  web/                Next.js control dashboard: projects, API catalog, graph, runs, MCP, skills
  agent-server/       Local process: gateway, orchestrator, SQLite, event bus

packages/
  shared/             Result/error types, IDs, event contracts, logger, clock. Zero deps.
  schemas/            Zod schemas: config, protocol, events, tool I/O. Single validation source.
  security-engine/    Redaction, path policy, command policy, risk classification, approvals, SSRF
  exec-engine/        Policy-gated child-process execution: timeouts, limits, env filtering
  fs-engine/          Workspace filesystem + transactional patch application
  git-engine/         Git status/diff/log/branch/commit with destructive-op refusal
  tool-registry/      Tool contract, registry, validating + policy-enforcing dispatcher
  agent-core/         AIProvider abstraction, providers, agent loop, task router, confidence
  api-ir/             Canonical API intermediate representation (types + invariants)
  api-engine/         OpenAPI/Postman/cURL/doc parsers, endpoint index + search, HTTP executor
  code-intelligence/  AST parsing (TS Compiler API, Tree-sitter), symbol/reference indexing
  code-graph/         Code knowledge graph: nodes, edges, subgraph queries, impact analysis
  mcp-engine/         MCP client, server/tool discovery, per-tool permission enforcement
  skill-engine/       Skill registry, task-based selection, scoped loading
  validation-engine/  Typecheck/lint/test/build/contract-test orchestration, failure diagnosis
  memory/             Scoped memory (global/project/task), secret-free by construction

skills/               Shipped skill packages (api-integration, react, nextjs, typescript, ...)
fixtures/             Synthetic target repos used by golden scenarios
docs/                 Architecture and design records
```

Dependency direction is strictly downward. `shared` and `schemas` depend on nothing internal.
Engines never import `agent-core`; `agent-core` orchestrates engines through the tool registry.
This is enforced by TypeScript project references — a cycle fails the build.

## 5. Layer contracts

### 5.1 `shared`

`Result<T, E>` for every fallible operation; exceptions are reserved for programmer error.
`AgentError` carries a stable `code`, a human message, structured `details`, and a `retryable`
flag. Every failure mode named in §64 of the specification has a code. Tool failures are values,
so one failing tool never terminates a run.

The event contract (§58) is defined here, typed as a discriminated union on `type`. Both UIs are
consumers; the union is the API between core and UI.

### 5.2 `security-engine`

Four independent policies, each individually testable:

- **Redaction** — pattern-based (provider key formats, JWTs, PEM blocks, `Authorization`
  headers, cookies, assignment-shaped secrets) plus registration of _known_ secret values learned
  at runtime from the environment. Applied at the boundary: nothing reaches a log, an event, a
  model prompt, or a UI without passing through it. Redaction is the last line of defense, not the
  only one — secrets are also never loaded into prompt context in the first place.
- **Path policy** — every filesystem path is resolved (including symlinks) and must lie inside the
  project root. Ignore rules layer `.gitignore`, built-in denials (`node_modules`, `.git`, build
  output, lockfiles, binaries), and per-project configuration.
- **Command policy** — commands are allowlisted by _program name_, and arguments arrive as an
  array, never as a shell string. There is no shell interpolation path, so shell metacharacter
  injection is structurally impossible rather than filtered. A separate deny layer catches
  destructive argument shapes.
- **Risk classification** — `READ_ONLY | LOW_RISK_WRITE | HIGH_RISK_WRITE | DESTRUCTIVE`, applied
  uniformly to built-in tools, MCP tools, API calls, and commands, and combined with the
  environment (`local | staging | production`) to decide whether approval is required.

### 5.3 `exec-engine`

Spawns child processes with `shell: false`. On Windows, `.cmd`/`.bat` shims are executed through
`cmd.exe /d /s /c` with each argument quoted by the documented Windows rules — the command line is
constructed from an already-allowlisted program plus a quoted argument vector, so no user or model
text is ever concatenated into a shell string. Enforces wall-clock timeout, output byte caps,
process-tree termination, and a filtered environment (secrets are injected only when the tool
declares it needs them).

### 5.4 `fs-engine`

Reads are size- and line-bounded. Writes are **transactional**: a patch across N files either
fully applies or fully rolls back from a staging snapshot. Two edit formats are supported — an
anchored structured edit (`oldText` to `newText`, with an expected-content hash precondition) and
unified diff. The anchored form is preferred because it fails loudly when the file has changed
underneath the agent, which preserves concurrent user edits (§37) instead of clobbering them.
Nothing is written outside the project root, and no whole-repository write path exists.

### 5.5 `tool-registry`

The only route from model to side effect. A tool declares name, description, category, risk level,
a Zod input schema, whether it mutates, and its handler. The dispatcher: validates input against
the schema, resolves policy and requests approval when required, executes under timeout, converts
any throw into a structured error, redacts the result, emits `TOOL_CALLED`, and appends to the run
log. The model receives JSON Schema derived from the same Zod schema that guards execution, so the
advertised contract and the enforced contract cannot drift.

### 5.6 `agent-core`

`AIProvider` normalizes multi-turn tool-calling across vendors:

```
chat(request) -> AsyncIterable<ProviderEvent>
  ProviderEvent = text-delta | tool-call | usage | done | error
```

Vendor-specific request/response shapes stay inside adapters. **OpenRouter** is the first concrete
adapter (OpenAI-compatible, streaming SSE, model selectable per project). A **scripted** provider
plays back a fixed event sequence so the entire agent loop — including tool dispatch, validation
failure, and the repair loop — is testable in CI with no network and no key.

The runtime is a bounded loop: build context, call provider, execute requested tools, feed results
back, stop on completion, iteration cap, abort, or unrecoverable error. Context is assembled by
_retrieval_, never by repository dump (§51, §63).

`TaskRouter` (§61) classifies intent deterministically first (explicit command, file/selection
context, unambiguous phrasing) and consults the model only for genuinely ambiguous input.
`ConfidenceEngine` (§31) scores decisions from counted evidence — number of matching endpoints,
whether an existing client was found, whether types align — and escalates to the user at LOW.
Confidence is derived, never asserted by the model.

## 6. Data model (SQLite)

Owned exclusively by the server. Projects are hard-isolated (§48): every row is keyed by
`project_id` and every query is scoped by it, so no cross-project context leak is possible.

Principal tables: `projects`, `files`, `symbols`, `references`, `graph_edges`, `apis`,
`endpoints`, `schemas`, `integrations`, `runs`, `run_events`, `tool_calls`, `findings`,
`memory_entries`, `mcp_servers`, `mcp_tools`, `approvals`, `audit_log`. Full-text search over
symbol names, endpoint paths/descriptions, and documentation uses SQLite FTS5.

Secrets are never stored. Secret _references_ (e.g. `env:PAYMENT_API_KEY`) are.

## 7. Security posture

| Threat                                                    | Control                                                                                      |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Secret leakage to model/logs/UI                           | Context minimization + boundary redaction + secret references only                           |
| Prompt injection via API docs / MCP output / file content | All external text is data, never instruction; tools are allowlisted; risky ops need approval |
| Path traversal                                            | Resolve + containment check on every path, symlinks included                                 |
| Command injection                                         | Allowlisted program + argument vector; no shell string ever built from input                 |
| SSRF via API executor                                     | Hostname/protocol validation, private-IP and metadata denial, redirect re-validation         |
| Destructive Git loss                                      | `git status` before mutation; `reset --hard` / `clean -fd` / force-push refused by default   |
| Runaway patches                                           | Transactional, bounded, hash-preconditioned, in-workspace, user-reviewable                   |
| Untrusted MCP capability                                  | Per-tool risk class, permissions, environment restriction, confirmation policy               |
| Silent data egress                                        | Explicit exclusions, per-provider configuration, and a record of what left the machine       |

Documentation and tool output are treated as **untrusted data**. Instruction-shaped text found
inside an API description or an MCP result is never executed as an instruction.

## 8. Phase plan and gates

| Phase | Deliverable                                                             | Gate                                      |
| ----- | ----------------------------------------------------------------------- | ----------------------------------------- |
| 0     | Monorepo scaffold, this document                                        | Toolchain verified, build config compiles |
| 1     | Agent runtime, provider abstraction, tool registry, fs/exec/git tools   | build + lint + tests pass                 |
| 2     | API IR, OpenAPI/Postman/cURL parsers, endpoint index, auth model        | Parser round-trip + conflict detection    |
| 3     | AST indexing, symbols, references, dependency graph, retrieval          | Index correctness against fixtures        |
| 4     | Intent understanding, endpoint/code matching, planner, patching         | Golden scenarios 1-2                      |
| 5     | Validation pipeline, failure diagnosis, bounded auto-repair             | Golden scenario 4                         |
| 6     | VS Code extension: sidebar, chat, plans, diff, diagnostics, quick fixes | Manual + integration tests                |
| 7     | MCP client, discovery, permissions, risk enforcement                    | Golden scenario 8                         |
| 8     | Skill registry, task-based selection, scoped loading                    | Selection-correctness tests               |
| 9     | Web dashboard                                                           | Playwright E2E                            |
| 10    | Security policies, audit log, sandboxing, limits, observability         | Full golden suite                         |

No phase is reported complete unless build, typecheck, lint, and tests actually pass. Anything
that cannot be validated is stated as unvalidated rather than assumed.

## 9. Decisions recorded

- **Local single-process server over microservices** — §55/§62 explicitly reject unnecessary
  infrastructure. Interfaces are transport-agnostic so extraction stays possible.
- **ESM throughout, extension bundled to CJS by esbuild** — Node 22 is ESM-native; the VS Code
  extension host expects CommonJS, and bundling is the standard reconciliation.
- **Zod as the single schema authority** — one definition drives runtime validation, static types,
  and the JSON Schema shown to the model. Eliminates contract drift.
- **Anchored edits over unified diff as the primary patch format** — hash preconditions make
  concurrent user edits a loud failure instead of silent data loss.
- **Argument-vector command execution** — makes shell injection structurally impossible rather
  than relying on sanitization.
- **`Result` over exceptions at every boundary** — a recoverable tool failure must not end a run.
