# API Integration & Code Intelligence Agent — Architecture

**Status:** Phases 0-5 complete (gate green: build, typecheck, lint, format, 1194 tests).
Living document; revised at each phase gate.
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
  web/                Next.js control dashboard: project overview, API catalog, runs, live events
  agent-server/       Local process: gateway, orchestrator, run loop, Postgres store, event bus

packages/
  shared/             Result/error types, IDs, event contracts, logger, clock. Zero deps.
  schemas/            Zod schemas: config, protocol, events, tool I/O. Single validation source.
  rpc/                JSON-RPC 2.0 peer + length-prefixed framing. Transport-agnostic.
  security-engine/    Redaction, path policy, command policy, risk classification, approvals, SSRF
  exec-engine/        Policy-gated child-process execution: timeouts, limits, env filtering
  fs-engine/          Workspace filesystem + transactional patch application
  git-engine/         Git status/diff/log/branch/commit with destructive-op refusal
  tool-registry/      Tool contract, registry, validating + policy-enforcing dispatcher
  agent-core/         AIProvider abstraction, providers, agent loop, task router, confidence
  api-ir/             Canonical API intermediate representation (types + invariants)
  api-engine/         OpenAPI/Postman/cURL/doc parsers, endpoint index + search, HTTP executor
  code-intelligence/  AST parsing (TS Compiler API), symbol/reference indexing, retrieval
  integration-planner/ Intent, API<->code matching, plan construction, executor briefs
  coding-agent/       CodingAgentProvider contract, delegation loop, Jules adapter
  code-graph/         Code knowledge graph: nodes, edges, subgraph queries, impact analysis
  mcp-engine/         MCP client (stdio), tool discovery, risk classification, permissions
  skill-engine/       Skill registry, task-based selection, scoped loading
  validation-engine/  Typecheck/lint/test/build orchestration, failure diagnosis, bounded repair
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

## 6. Data model (Postgres, via a local Supabase stack)

Owned exclusively by the server. Projects are hard-isolated (§48): every row is keyed by
`project_id` and every query is scoped by it, so no cross-project context leak is possible.

Principal tables: `projects`, `files`, `symbols`, `refs`, `graph_edges`, `apis`, `endpoints`,
`api_schemas`, `integrations`, `runs`, `run_events`, `tool_calls`, `findings`, `memory_entries`,
`mcp_servers`, `mcp_tools`, `approvals`, `audit_log`. Full-text search over symbol names and
endpoint paths/summaries uses Postgres `tsvector` with GIN indexes.

**Local, and that is a security property.** The stack runs on loopback (`supabase start`), so an
index of a private codebase does not leave the machine. Pointing this at a hosted project is
possible and deliberate: it takes editing `database.url` and supplying a key reference.

**Optional.** Disabled by default. With no database the server keeps everything in memory and
loses it on restart; nothing else changes. Indexing a repository must never require Docker to be
running, so a store that is unreachable degrades to "no history" and is reported as a
configuration issue, not as a failure to work.

**Metadata only, never file contents.** Paths, symbol names, kinds, signatures, and graph edges
are stored. Source text, doc comments, snippets, prompts, and model output are not — they are
read from disk on demand, where the path policy still governs them. The schema has no column to
put them in and a test asserts that it never gains one.

**The code index is a projection, not a source of truth.** §2 puts AST facts above stored state,
so the in-memory index is always re-derived from source rather than restored from the database.
The API catalog is the exception and is durable: a collection fetched over the network should not
have to be fetched again after a restart.

**Row-level security is on everywhere, with no policies.** The server connects with the service
role, which bypasses RLS; every other key — including the anon key a browser would hold — reads
nothing. If this schema is ever pointed at a hosted project, the default is "no access".

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
- **ESM throughout, shipped artifacts bundled to CJS by esbuild** — Node 22 is ESM-native; the
  VS Code extension host expects CommonJS, and bundling is the standard reconciliation. The agent
  server is bundled to CJS as well; §9.8 records why.
- **Zod as the single schema authority** — one definition drives runtime validation, static types,
  and the JSON Schema shown to the model. Eliminates contract drift.
- **Anchored edits over unified diff as the primary patch format** — hash preconditions make
  concurrent user edits a loud failure instead of silent data loss.
- **Argument-vector command execution** — makes shell injection structurally impossible rather
  than relying on sanitization.
- **`Result` over exceptions at every boundary** — a recoverable tool failure must not end a run.

## 9. Design records

### 9.1 API IR (Phase 2)

- **Security is two levels, not one.** `Endpoint.security` is a list of options,
  each a conjunction of requirements. OpenAPI's list means "or" between entries
  and "and" within one, and flattening the two would tell the agent that either
  half of an API-key-plus-signature pair suffices — a wrong integration rather
  than an incomplete one.
- **References are inlined, cycles are named.** Every consumer sees one complete
  shape, so path resolution and contract comparison need no resolver. A
  recursive type terminates as a `ref` node carrying its name.
- **Gaps are values.** A source that does not describe a shape produces
  `unknown` with a reason; parsers never infer a type from a field name.
- **Wire format is not schema.** Query, path, and header values are strings on
  the wire, so an observed string never contradicts a declared `integer`. The
  observed value is still checked against a declared enumeration, which is where
  real mismatches in that position occur.
- **A pasted request never yields a stored credential.** The cURL and Postman
  parsers record the auth _scheme_ and discard the value, emitting a warning
  that names the environment variable to set. Credential-shaped values are also
  excluded from inferred examples.
- **Observation is evidence, bounded by what was observed.** Schemas inferred
  from payloads mark a field required only when it appeared in every sample, and
  a lone `null` yields nullability rather than a type.

### 9.2 HTTP executor and documentation parser (Phase 2)

- **The executor is where the phase-1 policies converge.** SSRF validation, risk
  classification, the approval gate, and secret resolution all meet at the one
  component in `api-engine` with a side effect. `SsrfPolicy`, `classifyHttpRisk`,
  and the `Limits.maxHttp*` values were built in phase 1 for exactly this.
- **Redirects are followed manually and credentials dropped across origins.**
  Letting the runtime follow redirects forwards `Authorization` to whatever host
  the response names. Each hop is re-validated against the SSRF policy before it
  is taken.
- **Authorization precedes DNS.** A request the user would refuse is never
  announced to a resolver.
- **A non-2xx response is a result, not an error.** `Err` is reserved for
  requests that could not be attempted or completed.
- **The response's inferred shape is returned with it.** A real response is
  evidence ranking above the specification, so it feeds straight into
  `compareSchemas` as the observed side.
- **Documentation is the weakest source and behaves like it.** Only explicit
  `METHOD /path` statements yield endpoints; response shapes come from example
  payloads or stay `unknown`. Instruction-shaped prose is extracted as a
  description and never acted on, per §7.

### 9.3 Code intelligence and the graph (Phase 3)

- **Analysis is syntactic on purpose.** `ts.createSourceFile`, not `ts.Program`:
  no type checker, no module resolution, no `node_modules`. The agent has to
  index a repository it has just opened, whose dependencies may not be installed
  and whose code may not compile. A type-aware pass would fail exactly when the
  codebase is in the state the agent most needs to understand it.
- **Resolution is graded, not binary.** A name resolves to a workspace
  declaration, comes from an external package, is reached through a property
  access, or resolves to nothing. Counting these together would make a healthy
  index of a dependency-heavy project look broken; `resolutionRate` excludes
  what was never in scope, so it measures what it claims to.
- **Members are never resolved by name.** Which declaration `order.status` means
  depends on the type of `order`. Matching it against a same-named import would
  attribute `obj.format()` to an imported `format` — a wrong answer dressed up
  as a resolved one.
- **Locals are not indexed.** A `const response` inside a function is not
  addressable from elsewhere; indexing it would bury real declarations and
  collide with every other function using the name.
- **Impact analysis does not follow `declares` backwards.** A file declaring a
  symbol is not a dependent of it. Following that edge inbound would let any
  symbol change reach its own file and from there everything importing the file,
  reporting the whole repository as affected by a one-line change.
- **Exposure is distinguished from use.** A barrel re-exporting a type does not
  depend on it the way a caller does, so `exposes` is its own edge kind.
- **Blind spots are reported.** Dynamic dispatch, reflection, and unresolvable
  members produce no edges, so an impact report says where the analysis could
  not see rather than implying completeness.
- **Tree-sitter is deferred, deliberately.** Earlier drafts of this document
  listed it alongside the TypeScript compiler API. It buys parsing for languages
  other than TS/JS, which nothing in the system consumes yet — the shipped
  skills target api-integration, React, Next.js and TypeScript — and it costs a
  multi-megabyte `.wasm` grammar committed per language. It is dropped from the
  package description rather than left there as an unmet promise; when a
  non-TS/JS target appears, it returns as scoped work.

- **Retrieval enforces its own budget.** Sections 51 and 63 forbid dumping a
  repository into a prompt; the byte and item caps live inside `retrieve`, not
  in its callers, because the failure mode is a caller that means well.

### 9.4 Planning and delegation (Phase 4)

- **Intent is read deterministically first.** "Integrate POST /payments into the
  checkout form" states its action, endpoint, and target; asking a model to
  extract them adds latency and a failure mode to recover what the sentence
  already contains. What stays ambiguous is reported, not guessed.
- **API-to-code matching is structural.** A documented `/orders/{orderId}` has
  the signature `/orders/{}`; a template literal `` `/orders/${id}` `` collapses
  to the same string. Comparing two indexed facts is what makes the result
  usable as evidence rather than as a suggestion, so URL literals are now part
  of the index.
- **A plan names few files.** Targets are capped and score-filtered: a plan
  listing half the repository is not a plan, and a file sharing one word with
  the request is not a target.
- **Being named beats being clever.** A file the user named outranks one the
  matcher found, including one that already calls the endpoint.
- **The brief is the product's own work.** Whatever executes a plan receives a
  specification derived from indexed facts — never the raw user message, never
  the repository. That is what keeps an execution provider swappable.

### 9.5 Coding-agent providers (Phase 4)

Full detail in `CODING-AGENTS.md`.

- **A coding agent is an execution provider, not the intelligence.** It is handed
  a brief and returns a patch. It never sees the raw request, never picks the
  endpoint, never decides whether the work is done.
- **`CodingAgentProvider` is not `AIProvider`.** One streams tokens for a
  conversation driven turn by turn; the other is a long-running out-of-process
  job, polled, returning a diff. Fusing them would leave half of either
  interface meaningless.
- **"Completed" is not "verified".** No provider state maps to verified. Without
  a validation pipeline the result is returned marked `unvalidated`, which is
  the one thing the loop must never quietly upgrade.
- **Vendor types stay in the vendor's directory.** Only the provider class is
  exported; if a caller could import `JulesSession`, swapping providers would
  stop being a configuration change.
- **Unsupported is stated, not faked.** The Jules API documents no cancellation,
  so `cancel()` returns `UNSUPPORTED` rather than silently doing nothing.
- **Non-idempotent calls are never retried.** A retried `create` after an
  ambiguous timeout would start a second agent on the same repository.
- **Every loop is bounded**, and all three separately: polls, wall-clock, and
  repair attempts.

### 9.6 Validation and repair (Phase 5)

- **Checks run in dependency order and stop at the first failure.** A type error
  makes every later check meaningless — the tests that "fail" are failing
  because nothing compiled. Reporting forty test failures caused by one missing
  property sends an agent chasing symptoms.
- **A check that cannot run has not passed.** An unconfigured or unresolvable
  command is recorded as skipped with a reason, and a pipeline where nothing ran
  does not report success.
- **Parsers never invent a location and never drop output.** A line without
  `file:line` yields a finding with no location; an unrecognized format yields
  the tail of the output verbatim. A failure with nothing to act on is the worst
  thing the loop can produce.
- **Diagnosis groups findings by shared cause and ranks them.** One missing
  property produces an error at every call site; the repair loop is sent the
  group that accounts for most of the failure, not the cascade.
- **Some failures are not repairable and are not attempted.** A timeout or a
  missing binary cannot be fixed by editing source, and trying spends an attempt
  from a small budget.
- **Repair requires progress.** An attempt that does not change the failures
  ends the loop; one that makes things worse ends it and says so, so the change
  can be reverted rather than dug into.

### 9.7 Live API sources (Phase 5)

- **Fetching and parsing are separate.** `PostmanApiClient` is a transport;
  `parsePostman` — built in Phase 2 and already tested — does the normalizing.
  A second normalizer would be duplicate architecture whose halves drift.
- **Every source reaches the same IR.** OpenAPI, Swagger, Postman file, Postman
  API, cURL, and documentation all produce an `ApiSpec`, and nothing downstream
  can tell which one it came from beyond `source.format`.
- **The client is read-only.** This system imports API definitions; it does not
  manage a Postman account. A client that could delete a collection would be a
  capability with no use here and a real blast radius.
- **Identifiers are validated before they reach a URL**, and the key travels in
  `X-API-Key` only — never a query parameter.

### 9.8 The editor client and the agent server (Phase 6)

- **A separate `rpc` package, not transport code inside an app.** The framing
  and the JSON-RPC peer have two consumers — the server and the extension — and
  the same class runs on both ends. Putting it in either app would have made one
  app depend on the other; putting it in `shared` would have contradicted that
  package's "zero dependencies, no I/O" remit.
- **JSON-RPC rather than a request/response protocol, because the direction
  matters.** The server needs to call _into_ the editor: SecretStorage is
  reachable only from the extension host, and so is the user. A protocol where
  only the client may ask questions turns both of those into polling.
- **The protocol is Zod, and the schema that describes a call is the schema that
  guards it** — the same rule as the tool registry (§5.5). Registration takes a
  contract, so there is no way to bind a handler without also binding its
  validation. Results are validated too: object schemas strip unknown keys, so
  an internal record returned by mistake loses everything the contract does not
  name.
- **Event payloads are deliberately not re-derived in Zod.** `shared` owns the
  event union as a TypeScript discriminated type; a second definition could
  disagree with the first. Events cross the wire in a validated envelope and are
  narrowed on `type` against that one definition.
- **Capabilities are advertised, and the server asks for nothing that was not
  offered.** A server calling a method the client never registered gets a
  timeout, which is a far worse failure than a clean refusal.
- **The extension holds the keychain; the server still holds the policy.** A
  secret crosses one local pipe between two processes owned by the same user and
  is registered with the redactor the moment it arrives. §3's trust boundary is
  unchanged: the server decides _whether_ a credential is needed, and only asks
  the process that has hands to fetch it.
- **A missing secret is `found: false`, never an error.** An error would carry
  the name of what was missing into a log.
- **Anything that decides what to show lives outside the `vscode` imports.**
  Tree shapes, diagnostic ranges, and status text are pure functions, so the
  decisions that matter — an unlocated finding is not anchored to line 1, a
  skipped check is not reported as passed, an empty view says why it is empty —
  are testable without an editor running.
- **Both bundles are CommonJS.** The extension host requires it, and so, in
  practice, does the server: the indexer depends on `typescript`, which reaches
  for `require`, `__filename`, and `__dirname` at runtime. Bundled into ESM
  those become shims that throw on the first indexing call rather than at build
  time. Nothing in the server's own source uses `import.meta`, so the conversion
  costs nothing. This supersedes the ESM half of the bundling decision recorded
  above.

### 9.9 Runs, patches, and persistence (post-Phase 6)

- **A run plans deterministically before the model sees anything.** The integration planner reads
  the index and the catalog and produces a brief; the model is handed that, not the user's
  sentence. Constraints, protected files, and open questions are in front of it before it writes.
- **Proposing and writing are different tools.** `propose_patch` computes a preview and stages it
  and touches nothing; `apply_patch` writes, transactionally, and is the only tool that does. An
  agent that could only write would make review a formality performed after the fact.
- **The agent only gets `apply_patch` in modes that permit it to write** — `auto` and
  `askOnDestructive`. In every other mode it proposes and a person applies, because a yes/no
  approval prompt with no diff attached is not a review.
- **A proposal is never written to disk to be reviewed.** It is served from memory as a virtual
  document. A proposed change written to the working tree has already happened, whatever the UI
  says next: a build watcher picks it up and a test runner sees it.
- **A revert restores captured content, not an inverted diff.** The before-text of every file is
  recorded at apply time, so restoring is exact rather than a second guess at what was there.
- **Validation runs on what was written, and only on what was written.** A run that applied
  nothing has nothing to validate, and reports that rather than a pass. §39's repair loop owns the
  budget and the progress rule; the model performs an attempt and the pipeline judges it.
- **Persistence never fails a run.** Writes return `Result`, callers log and continue, and the
  store is chosen at open time with a health check so a missing database is a configuration issue
  surfaced once — not a failure discovered halfway through a run.

### 9.10 Model Context Protocol (Phase 7)

- **The codec is injectable rather than the connection duplicated.** MCP frames
  messages by newline; this system's own transport frames by `Content-Length`.
  Sharing `RpcConnection` means request correlation, cancellation, timeouts, and
  "settle everything when the pipe dies" exist once — they are the parts that
  are easy to get subtly wrong twice.
- **A server's self-description may raise the risk assigned to a tool, never
  lower it.** `destructiveHint` is volunteered against the server's own interest
  and is believed. `readOnlyHint` is a program asserting it is harmless, which is
  exactly the assertion that cannot be taken on trust, so it buys one step down
  rather than a free pass. The asymmetry is the difference between evidence and
  a claim.
- **Only a person reaches READ_ONLY**, by naming a specific tool in
  `trustedTools` — deliberately separate from `allowedTools`, because
  restricting a server to three tools is a scoping decision and not a statement
  that those three are safe.
- **Protocol versions are negotiated.** The client proposes the newest revision
  it knows, accepts an older one the server chooses, and refuses a revision it
  cannot speak rather than guessing at message shapes.
- **Tool names are namespaced by server.** Two servers offering `search` would
  otherwise shadow each other — a silent capability swap — and a prefixed name
  makes it visible in a timeline and an approval prompt that a call is leaving
  the system.
- **A server's output is data.** Its `instructions`, its tool descriptions, and
  its results are instruction-shaped text from a third-party program. They are
  shown, and given to the model as documentation; they are never a directive to
  this system, and the tool wrapper says so where the model can see it.
- **One broken server does not stop a run.** Servers connect independently and a
  failure is reported as a finding against that server.

### 9.11 Skills (Phase 8)

- **Selection is deterministic and evidence-ranked.** What the repository
  depends on outranks the task kind, which outranks the files involved, which
  outranks words in the request — because a dependency is a fact about the
  codebase and a word in a sentence is the easiest signal to produce by
  accident. A skill that names required packages and finds none present is
  excluded outright, so word matching cannot pull a Vue skill into a React
  project.
- **Nothing asks a model which instructions to give itself.** That is a loop
  with no ground truth in it.
- **Loading is budgeted, and what did not fit is reported.** Skills are prompt
  tokens; a dozen of them produce a prompt in which none of the guidance is
  followed. On a tie the smaller skill wins, because it leaves room for another.
- **A skill is guidance, never authority.** Its text is rendered under a heading
  saying it does not override a safety rule or widen a permission. Skills are
  plain files that a project can ship, so "the skill told me to" must not be an
  available excuse.
- **Shipped skills are read from where the agent is installed, not through the
  workspace reader.** They live outside the project, so the path policy refusing
  them is correct behaviour; routing them through it would be either broken or a
  hole in containment. A project's own skills live in `.aica/skills`, inside the
  project, where the policy does apply — and a project skill of the same name
  replaces the shipped one, which is what a project skill is for.

### 9.12 The web dashboard (Phase 9)

- **The gateway holds handlers, not a connection.** §3 makes it the only layer
  that knows about transports, which cuts both ways: the editor speaks JSON-RPC
  over a pipe, the dashboard speaks HTTP, and both reach the same table with the
  same validation and the same policy. Welding the gateway to one connection
  would have meant a second, subtly different table for the second client.
- **The HTTP listener is opt-in.** Every editor window that opens a folder
  starts a server. Opening a port on each of them, for a dashboard the user may
  never run, would be handing out a capability nobody asked for — so it happens
  only when `AICA_HTTP_PORT` says so.
- **Loopback, a per-process token, an origin allowlist, and a `Host` check.**
  Localhost is not a security boundary against the browser the user is already
  running: any page can issue requests to it, and an attacker's domain can
  resolve to `127.0.0.1` to become same-origin. All four controls are needed;
  none of them is sufficient alone.
- **The browser never holds the token.** The page calls this app's own route
  handlers and those forward with the credential attached. That keeps the token
  out of JavaScript, out of history, and out of an `EventSource` URL — which is
  where the obvious design puts it, because `EventSource` cannot set headers.
  Same-origin also means the agent's CORS allowlist is defence in depth rather
  than the thing holding the door.
- **The dashboard's method list is an allowlist.** Its route handler is
  reachable by anything in the user's browser, and a pass-through would make the
  app a confused deputy for the agent's whole method table, writes included.
- **The Content-Security-Policy carries a per-request nonce and is set in
  middleware.** A static `script-src 'self'` blocks Next's hydration bootstrap,
  and the failure is quiet: the page still renders, because the HTML is
  server-rendered, and is simply dead. `'unsafe-inline'` would be the same as
  having no script policy at all.
- **The event stream writes a comment as soon as it opens.** Headers alone do
  not always settle a stream through an intermediary, and a client that has
  received no bytes cannot tell an idle stream from one still connecting — which
  is the difference between "nothing is happening" and "this is broken".
- **The E2E suite runs against a production build.** A dashboard whose only
  tested configuration is `next dev` is a dashboard nobody has tested: server
  components, caching, and headers all behave differently once built, and that
  is where a dashboard breaks.
