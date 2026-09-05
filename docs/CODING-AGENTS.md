# Coding-agent providers

**Status:** `CodingAgentProvider` and the Jules adapter are implemented and
tested. The validation/repair loop is implemented against a port; the pipeline
behind that port arrives in Phase 5. See [Limitations](#limitations).

---

## 1. What a coding-agent provider is

A coding agent is an **execution provider**. It receives a brief this system
wrote and returns a patch this system validates. It is not the intelligence of
the product, and the architecture is arranged so it cannot become that.

Everything that decides _what_ to build stays here:

| Owned by this system                                     | Delegated        |
| -------------------------------------------------------- | ---------------- |
| API intelligence (`api-engine`, `api-ir`)                | Writing the code |
| Code intelligence (`code-intelligence`, `code-graph`)    |                  |
| API ↔ code contract analysis (`integration-planner`)     |                  |
| The Integration Planner and the brief it produces        |                  |
| Validation, repair decisions, and the definition of done |                  |
| Security policy, secrets, approvals                      |                  |

The provider never sees the user's raw message, never chooses the endpoint,
never decides whether the work is finished, and never holds a credential of
ours beyond its own API key.

```
User request
  → Intent understanding          (integration-planner/intent.ts)
  → API intelligence              (api-engine)
  → Code intelligence             (code-intelligence, code-graph)
  → Integration Planner           (integration-planner/planner.ts)
  → brief                         (renderBrief)
  → CodingAgentProvider           (coding-agent/contract.ts)
  → JulesProvider                 (coding-agent/providers/jules)
  → unified diff
  → Validation                    (ValidationRunner port → validation-engine)
  → Repair loop, bounded          (coding-agent/delegation.ts)
  → Verified result
  → Diff review, then Git         (fs-engine, git-engine)
```

## 2. Configuring the API key

The key is referenced, never embedded. In `aica.config.json`:

```jsonc
{
  "codingAgent": {
    "provider": "jules",
    "apiKeyRef": "env:JULES_API_KEY",
    "sourceId": "github-acme-shop",
    "startingBranch": "main",
    "requirePlanApproval": true,
    "maxRepairAttempts": 3,
  },
}
```

Then set the variable in the environment:

```bash
export JULES_API_KEY="..."   # from jules.google.com/settings
```

`apiKeyRef` is validated against `secretReferenceSchema`, so a literal key in
configuration is a **validation failure**, not a leak. The reference is resolved
through `SecretResolver` at the moment of each request, which registers the
value with the shared `Redactor` — from then on it is scrubbed from every log
line, event, and prompt automatically.

The key is sent only in the `x-goog-api-key` header. Never a query parameter,
which would put it into every access log along the way.

In the VS Code extension (Phase 6), read the key from `SecretStorage` and expose
it as the same kind of reference. The provider needs no change.

### Where the key must never appear

Enforced, with a test for each: LLM prompts · logs · telemetry · Git commits ·
PR descriptions · VS Code output · browser code · error messages.

## 3. Repository configuration

Jules works on GitHub repositories connected through the Jules web app. **The
API can only read sources, not create them** — connect the repository at
[jules.google.com](https://jules.google.com) first.

```ts
const repositories = await provider.listRepositories();
// [{ sourceId: 'github-acme-shop' }]
```

`sourceId` and `startingBranch` are validated before they reach a URL or a
request body (`safety.ts`): allowlisted character sets, no path traversal, no
control characters. Validation happens _before_ the request, so a bad
identifier costs nothing.

## 4. How a task is delegated

The brief comes from the planner, never from the user's message:

```ts
const plan = buildPlan({ intent: parseIntent(userRequest), code, graph, specs });
if (plan.confidence === 'low') return askUser(plan.openQuestions);

const outcome = await new Delegator({ provider, validation, redactor }).run({
  brief: renderBrief(plan),
  title: describeIntent(plan.intent),
  repository: { sourceId, startingBranch },
});
```

A brief states the objective, the endpoint with its real request and response
shapes, the existing call sites, the repository's own conventions (HTTP
mechanism, API client, auth helper, base URL constant), the files to change, the
files to leave alone, the constraints, the expected tests, and the definition of
done. It is assembled from indexed facts and is size-capped. The repository is
never dumped into it.

## 5. Validation and repair

**A provider reporting `COMPLETED` means it stopped working. Nothing is
`verified` until validation says so.** The state mapping enforces this: Jules's
`COMPLETED` maps to our `completed`, and no provider state maps to `verified`.

```
completed → validate → passed → verified
                   ↓ failed
              repair instruction → provider → back to polling
```

Every loop is bounded:

| Bound                    | Default | Why                                                  |
| ------------------------ | ------- | ---------------------------------------------------- |
| `maxRepairAttempts`      | 3       | Stops an agent oscillating between two broken states |
| `maxPolls`               | 240     | A provider answering instantly can't spin the loop   |
| `maxDurationMs`          | 30 min  | A merely slow provider can't run forever             |
| Repair with no new patch | —       | Stops rather than asking again                       |

Repair instructions are specific: the check, the file, the line, the message.
"Tests are failing, please fix" produces flailing. The list is capped at 20
findings because a hundred cascading type errors usually share one cause.

Every instruction ends with _do not change unrelated files_ and _do not disable
or skip a check to make it pass_ — the two shortcuts an agent reaches for under
pressure.

## 6. Security considerations

| Threat                                | Control                                                            |
| ------------------------------------- | ------------------------------------------------------------------ |
| Key leaking into logs/prompts/UI      | Secret reference resolved at use, registered with `Redactor`       |
| Key in a URL                          | Header-only; asserted by test                                      |
| Path/header injection via identifiers | Allowlist validation before the request                            |
| Credential smuggled into a brief      | `assertBriefIsSafe` refuses; error names the _line_, not the value |
| Prompt injection from provider output | All provider text is data, redacted and length-bounded             |
| Unsafe URL in a response              | Only `https:` accepted for `session.url`                           |
| Runaway session                       | Poll cap + wall-clock budget                                       |
| Duplicate agents                      | `create` and `sendMessage` are never retried                       |
| Oversized patch                       | Rejected above 4 MB                                                |
| Unattended repository edits           | `requirePlanApproval` defaults to on                               |

The LLM never controls the API key: it is resolved by `SecretResolver` inside
the provider, from a reference in configuration the model cannot write.

## 7. Failure scenarios

| Scenario                 | Behaviour                                            |
| ------------------------ | ---------------------------------------------------- |
| Key missing              | `CONFIG_ERROR` before any request                    |
| Key rejected             | `AUTH_FAILURE`, no retry                             |
| Jules unreachable        | `NETWORK_ERROR`, retryable, bounded                  |
| Jules 5xx                | `API_ERROR`, retried with backoff                    |
| Rate limited             | `RATE_LIMITED`, retried                              |
| Request hangs            | `TIMEOUT` at 30 s                                    |
| Malformed JSON           | `MALFORMED_RESPONSE`                                 |
| Unknown session state    | Mapped to `pending` and reported, never guessed      |
| Session fails            | `DelegationStatus.failed` with the reason            |
| Finished, no changes     | `failed` — "finished without producing any changes"  |
| Validation never passes  | `repairExhausted`, changes returned for human review |
| No validation configured | `unvalidated` — **never** `verified`                 |
| Plan awaiting approval   | `awaitingDecision`; stops rather than auto-approving |

Jules being unavailable is an ordinary condition returned as a value, not an
exception. One failing provider never terminates an agent run.

## 8. Replacing Jules with another provider

1. Implement `CodingAgentProvider` (`coding-agent/src/contract.ts`).
2. Keep the vendor's wire types private to your provider directory, as
   `providers/jules/types.ts` does. Export only the class and its options.
3. Map the vendor's states onto `CodingSessionState`. Map "finished" to
   `completed`, never to `verified`.
4. Reuse `safety.ts` for identifier validation and text sanitization.
5. Report unsupported capabilities honestly in `capabilities` and return
   `UNSUPPORTED` from the corresponding method.
6. Add the name to `codingAgentKindSchema`.

Nothing above `CodingAgentProvider` should need to change. If it does, the
abstraction has leaked.

## 9. Limitations

**Of the Jules API, as documented at `v1alpha`:**

- **No cancellation.** No cancel method is documented, so `cancel()` returns
  `UNSUPPORTED`. A running session must be stopped from the Jules web app or
  left to finish. This is the one requested capability that cannot be met.
- **Sources are read-only.** Repositories must be connected through the web app.
- **No webhooks.** Progress is polled; there is no push channel.
- **No documented `Retry-After`.** Backoff is a fixed exponential schedule
  rather than one derived from a header.
- **`v1alpha`.** The surface may change.

**Of this integration, pending later phases:**

- **The validation pipeline is a port.** `ValidationRunner` is implemented and
  the loop around it is tested, but the real typecheck/lint/test/build runner is
  `validation-engine`'s deliverable in Phase 5. Until then a caller supplies its
  own runner, or gets `unvalidated` results — clearly labelled, never
  `verified`.
- **No VS Code UI.** `apps/vscode-extension` is empty until Phase 6. The events
  the UI will render (`coding_agent.session.*`) are emitted already.
- **No dashboard.** `apps/web` is empty until Phase 9.
- **No Git automation.** Nothing commits or opens a PR. The diff is returned for
  the existing review flow, per the architecture's Git posture.
