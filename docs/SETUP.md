# Setup

What you need before this does anything, and what you do not.

## The short version

Nothing works better than nothing. Indexing, the API catalog, impact analysis, planning,
validation, patch review, MCP servers, skill selection, both user interfaces — all of it runs with
no keys at all. The planner is deterministic: it reads your code and your API specifications
without a model.

One key buys one thing: **a model that writes patches**. Everything else is optional.

| Key             | Buys                             | Required?           |
| --------------- | -------------------------------- | ------------------- |
| OpenRouter      | The agent writing actual code    | Only for real runs  |
| Supabase secret | History surviving a restart      | No — off by default |
| Postman         | Importing from a Postman account | No                  |
| Jules           | Delegating to an external agent  | No                  |

A key is never written into `agent.config.json`. Configuration holds a _reference_ —
`env:NAME`, `keychain:NAME`, `file:path`, or `prompt:NAME` — and a literal credential there is a
validation failure rather than a leak.

## The model (OpenRouter)

```
setx OPENROUTER_API_KEY "sk-or-v1-..."
```

`agent.config.json` already defaults to `env:OPENROUTER_API_KEY`, so nothing else is needed. To
use a different model:

```json
{ "model": { "provider": "openrouter", "model": "anthropic/claude-sonnet-4.5" } }
```

`"provider": "scripted"` runs the whole loop — planning, tools, validation, repair — with a
deterministic stand-in and no network. That is what the test suite uses, and it is a genuine dry
run: the plan is real, only the writing is not.

## The database (optional)

Postgres through Supabase. Off unless you turn it on, and the server keeps everything in memory
without it — you lose history across restarts and nothing else.

### Local

```
pnpm db:start     # starts the stack and applies migrations
pnpm db:status
```

The CLI does not print API keys while `auth` is disabled in `supabase/config.toml`, which it is
here on purpose. The secret key lives on the Studio container:

```bash
docker inspect supabase_studio_aica --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -oE "sb_secret_[A-Za-z0-9_-]+"
```

Then:

```
setx SUPABASE_SECRET_KEY "sb_secret_..."
```

```json
{
  "database": {
    "enabled": true,
    "url": "http://127.0.0.1:54321",
    "serviceKeyRef": "env:SUPABASE_SECRET_KEY"
  }
}
```

**It must be the secret key, not the publishable one.** Every table has row-level security enabled
with no policies, so the server bypasses RLS with the service role. A publishable or anon key —
the browser-safe one — reads exactly zero rows. That is the intended behaviour, not a
misconfiguration to work around.

**On a shared network, stop it when you are not using it.** `supabase start` publishes its ports
on `0.0.0.0`: Postgres on 54322 answers to the CLI's shared default credentials, and Studio on
54323 has no authentication. `pnpm db:stop`.

### Hosted

A deliberate, different decision: the metadata this schema stores — file paths, symbol names,
signatures, and the graph between them — is a real map of a private codebase, and it goes to a
server somebody else operates. Source text, doc comments, prompts, and model output are still
never stored, because no column exists to put them in.

```
pnpm db:link -- --project-ref <your-ref>
pnpm db:push:remote
```

Take `SUPABASE_SECRET_KEY` (`sb_secret_...`) from **Project Settings → API Keys**, then:

```json
{
  "database": {
    "enabled": true,
    "url": "https://<your-ref>.supabase.co",
    "serviceKeyRef": "env:SUPABASE_SECRET_KEY"
  }
}
```

`localOnly` in the privacy block refuses all egress, loopback excepted, if you would rather it
could not reach anything at all.

## Postman (optional)

In VS Code: `Ctrl+Shift+P` → **AICA: Set Postman API Key**. It goes to the OS keychain through
SecretStorage, never to a settings file. Then:

```json
{ "postman": { "apiKeyRef": "keychain:postman" } }
```

## The web dashboard (optional)

The agent server only opens an HTTP port when asked:

```
AICA_HTTP_PORT=7333
```

It prints `AICA_SERVER_URL` and `AICA_SERVER_TOKEN` to stderr on startup. Give both to the
dashboard and run `pnpm --filter aica-web dev`. The token stays on the Next server; the browser
never holds it.

## Verifying

```
pnpm gate      # build, typecheck, lint, format, tests
```

Five tests skip without a database. With one configured they run, and the count goes from 1441 to 1446.
