# API Integration & Code Intelligence Agent

An autonomous engineering agent that takes **an API**, **a stated intent**, and **an existing
codebase**, and produces a change that has been analyzed, planned, implemented, validated,
repaired, and made reviewable.

Primary interface: a VS Code extension. Secondary: a local web dashboard for control,
visualization, and configuration.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and the phase plan.

## Governing principle

The LLM is not the source of truth. It reasons, plans, classifies, and selects tools.
Deterministic subsystems own parsing, AST analysis, file mutation, process execution, HTTP, and
Git. When model output conflicts with deterministic evidence, the evidence wins and the conflict
is reported.

## Status

| Phase | Scope                                                                            | State       |
| ----- | -------------------------------------------------------------------------------- | ----------- |
| 0     | Monorepo scaffold, architecture document                                         | Complete    |
| 1     | Agent runtime, provider abstraction, tool registry, security/exec/fs/git engines | Complete    |
| 2     | API IR, spec parsers, endpoint index, auth model                                 | Not started |
| 3     | AST indexing, symbols, references, dependency graph                              | Not started |
| 4     | Integration planner and patch generation                                         | Not started |
| 5     | Validation pipeline and bounded auto-repair                                      | Not started |
| 6     | VS Code extension                                                                | Not started |
| 7     | MCP client and permissions                                                       | Not started |
| 8     | Skill registry and selection                                                     | Not started |
| 9     | Web dashboard                                                                    | Not started |
| 10    | Enterprise hardening                                                             | Not started |

## Requirements

- Node >= 22
- pnpm 10

## Development

```bash
pnpm install
pnpm build       # tsc -b across all packages
pnpm test        # vitest
pnpm lint        # eslint
pnpm gate        # build + lint + test, the phase gate
```

## Configuration

Copy `.env.example` to `.env` and set the provider key. Credentials are referenced, never
embedded: configuration holds `env:OPENROUTER_API_KEY`, and the value is resolved at the moment
of use and registered with the redactor so it cannot appear in logs, events, prompts, or the UI.

Project behaviour is configured in `agent.config.json`, validated by
`@aica/schemas`. Every field has a safe default; an unconfigured project can read the repository
and does nothing else without asking.
