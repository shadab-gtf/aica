-- The agent's data model (§6).
--
-- Postgres via a local Supabase stack. Local is the point: §7 forbids silent
-- data egress, and an index of someone's private repository is exactly the kind
-- of thing that must not leave the machine by accident. Nothing here reaches a
-- network the developer did not start themselves.
--
-- Two rules shape every table below.
--
-- **Hard project isolation (§48).** Every row carries `project_id` and every
-- query is scoped by it. Cross-project leakage is not prevented by discipline;
-- there is no table without the column to join on.
--
-- **Metadata only, never file contents.** Paths, symbol names, kinds,
-- signatures, and graph edges are stored. Source text, doc comments, snippets,
-- prompts, and model output are not — they are read from disk on demand, where
-- the path policy still governs them. A column named `content`, `source`,
-- `snippet`, `body`, `doc`, `prompt`, or `completion` does not appear in this
-- file, and a test asserts that it never will.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Projects
-- ---------------------------------------------------------------------------

create table if not exists projects (
  id text primary key,
  name text not null,
  root text not null,
  created_at timestamptz not null default now(),
  last_indexed_at timestamptz,
  -- Counted facts from the most recent index, so a dashboard can show the
  -- shape of a project without loading the whole index.
  file_count integer not null default 0,
  symbol_count integer not null default 0,
  reference_count integer not null default 0,
  resolution_rate double precision not null default 0
);

-- ---------------------------------------------------------------------------
-- Code index
--
-- A projection, not a source of truth. §2 puts AST facts above stored state, so
-- the in-memory index is always rebuilt from source rather than restored from
-- here. These rows exist to be queried — by the dashboard, by history, by
-- "what did this look like last week" — never to reconstitute the index.
-- ---------------------------------------------------------------------------

create table if not exists files (
  project_id text not null references projects (id) on delete cascade,
  path text not null,
  language text,
  bytes integer not null default 0,
  lines integer not null default 0,
  -- Detects a file that changed since indexing, without keeping what is in it.
  digest text,
  indexed_at timestamptz not null default now(),
  primary key (project_id, path)
);

create table if not exists symbols (
  project_id text not null references projects (id) on delete cascade,
  id text not null,
  path text not null,
  name text not null,
  kind text not null,
  exported boolean not null default false,
  -- The declaration line as written. Enough to know the shape of an API; not
  -- the implementation, and never the doc comment.
  signature text,
  container text,
  start_line integer not null default 0,
  start_column integer not null default 0,
  end_line integer not null default 0,
  end_column integer not null default 0,
  is_async boolean not null default false,
  deprecated boolean not null default false,
  primary key (project_id, id)
);

create index if not exists symbols_name_idx on symbols (project_id, name);
create index if not exists symbols_path_idx on symbols (project_id, path);

-- Full-text search over symbol names (§6 asks for FTS; Postgres does it with
-- tsvector rather than SQLite's FTS5).
alter table symbols
  add column if not exists search tsvector
  generated always as (
    to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(path, ''))
  ) stored;

create index if not exists symbols_search_idx on symbols using gin (search);

create table if not exists refs (
  project_id text not null references projects (id) on delete cascade,
  id bigserial,
  path text not null,
  name text not null,
  kind text not null,
  line integer not null default 0,
  "column" integer not null default 0,
  -- Null when the reference could not be attributed. Those are the blind spots
  -- an impact report has to admit to.
  symbol_id text,
  is_member boolean not null default false,
  external_module text,
  primary key (project_id, id)
);

create index if not exists refs_symbol_idx on refs (project_id, symbol_id);
create index if not exists refs_path_idx on refs (project_id, path);

create table if not exists graph_edges (
  project_id text not null references projects (id) on delete cascade,
  from_id text not null,
  to_id text not null,
  kind text not null,
  count integer not null default 1,
  primary key (project_id, from_id, to_id, kind)
);

create index if not exists graph_edges_to_idx on graph_edges (project_id, to_id);

-- ---------------------------------------------------------------------------
-- API catalog
--
-- Unlike the code index this *is* durable state: a Postman collection fetched
-- over the network, or a specification pasted once, should not have to be
-- fetched or pasted again after a restart.
-- ---------------------------------------------------------------------------

create table if not exists apis (
  project_id text not null references projects (id) on delete cascade,
  id text not null,
  title text not null,
  version text,
  format text not null,
  source_location text,
  servers jsonb not null default '[]'::jsonb,
  auth_schemes jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  imported_at timestamptz not null default now(),
  primary key (project_id, id)
);

create table if not exists endpoints (
  project_id text not null references projects (id) on delete cascade,
  api_id text not null,
  id text not null,
  method text not null,
  path text not null,
  operation_id text,
  summary text,
  tags text[] not null default '{}',
  requires_auth boolean not null default false,
  deprecated boolean not null default false,
  primary key (project_id, api_id, id),
  foreign key (project_id, api_id) references apis (project_id, id) on delete cascade
);

alter table endpoints
  add column if not exists search tsvector
  generated always as (
    to_tsvector(
      'simple',
      coalesce(method, '') || ' ' || coalesce(path, '') || ' ' || coalesce(summary, '')
    )
  ) stored;

create index if not exists endpoints_search_idx on endpoints using gin (search);
create index if not exists endpoints_api_idx on endpoints (project_id, api_id);

create table if not exists api_schemas (
  project_id text not null references projects (id) on delete cascade,
  api_id text not null,
  name text not null,
  -- The IR node for a named schema. Structure from the specification the user
  -- supplied, not anything read out of their source tree.
  definition jsonb not null,
  primary key (project_id, api_id, name),
  foreign key (project_id, api_id) references apis (project_id, id) on delete cascade
);

create table if not exists integrations (
  project_id text not null references projects (id) on delete cascade,
  id text primary key,
  api_id text,
  endpoint_id text,
  status text not null,
  files text[] not null default '{}',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Runs and the audit record (§28, §29, §62)
-- ---------------------------------------------------------------------------

create table if not exists runs (
  id text primary key,
  project_id text not null references projects (id) on delete cascade,
  task text not null,
  provider text not null,
  model text not null,
  status text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  summary text,
  tool_calls integer not null default 0,
  files_changed integer not null default 0,
  validation_passed boolean,
  stopped_because text
);

create index if not exists runs_project_idx on runs (project_id, started_at desc);

create table if not exists run_events (
  id text primary key,
  run_id text not null references runs (id) on delete cascade,
  project_id text not null,
  seq integer not null,
  type text not null,
  at timestamptz not null,
  -- Already redacted before emission (§5.1). The payload is the event
  -- contract's own shape: status, previews, and counts, never raw arguments or
  -- results.
  payload jsonb not null default '{}'::jsonb
);

create unique index if not exists run_events_seq_idx on run_events (run_id, seq);

create table if not exists tool_calls (
  id text primary key,
  run_id text not null references runs (id) on delete cascade,
  project_id text not null,
  tool text not null,
  risk text not null,
  subject text,
  args_preview text,
  result_preview text,
  ok boolean not null,
  duration_ms integer not null default 0,
  error jsonb,
  at timestamptz not null default now()
);

create index if not exists tool_calls_run_idx on tool_calls (run_id, at);

create table if not exists findings (
  id text primary key,
  project_id text not null references projects (id) on delete cascade,
  run_id text,
  title text not null,
  severity text not null,
  category text not null,
  path text,
  line integer,
  created_at timestamptz not null default now()
);

create index if not exists findings_project_idx on findings (project_id, created_at desc);

create table if not exists approvals (
  id text primary key,
  project_id text not null references projects (id) on delete cascade,
  run_id text,
  subject text not null,
  risk text not null,
  environment text,
  granted boolean not null,
  remembered boolean not null default false,
  at timestamptz not null default now()
);

create table if not exists audit_log (
  id bigserial primary key,
  project_id text not null references projects (id) on delete cascade,
  run_id text,
  actor text not null,
  action text not null,
  subject text not null,
  decision text not null,
  at timestamptz not null default now()
);

create index if not exists audit_log_project_idx on audit_log (project_id, at desc);

-- ---------------------------------------------------------------------------
-- Memory, MCP
-- ---------------------------------------------------------------------------

create table if not exists memory_entries (
  id text primary key,
  project_id text references projects (id) on delete cascade,
  scope text not null,
  key text not null,
  -- Secret-free by construction: a reference such as `env:PAYMENT_API_KEY` may
  -- be stored, a credential may not.
  value text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists memory_scope_key_idx
  on memory_entries (coalesce(project_id, ''), scope, key);

create table if not exists mcp_servers (
  id text primary key,
  project_id text not null references projects (id) on delete cascade,
  name text not null,
  transport text not null,
  command text,
  args text[] not null default '{}',
  url text,
  enabled boolean not null default true,
  require_approval boolean not null default true,
  allowed_environments text[] not null default '{local}',
  last_connected_at timestamptz,
  last_error text
);

create unique index if not exists mcp_servers_name_idx on mcp_servers (project_id, name);

create table if not exists mcp_tools (
  id text primary key,
  project_id text not null,
  server_id text not null references mcp_servers (id) on delete cascade,
  name text not null,
  title text,
  risk text not null,
  allowed boolean not null default false,
  discovered_at timestamptz not null default now()
);

create unique index if not exists mcp_tools_name_idx on mcp_tools (server_id, name);

-- ---------------------------------------------------------------------------
-- Row-level security
--
-- Enabled everywhere with no policies. The server connects with the service
-- role, which bypasses RLS; every other key — including the anon key a browser
-- would hold — can read nothing. That is deliberate insurance: if this schema
-- is ever pointed at a hosted project, the default is "no access" rather than
-- "everything readable by anyone holding the publishable key".
-- ---------------------------------------------------------------------------

do $$
declare
  target text;
begin
  foreach target in array array[
    'projects', 'files', 'symbols', 'refs', 'graph_edges',
    'apis', 'endpoints', 'api_schemas', 'integrations',
    'runs', 'run_events', 'tool_calls', 'findings', 'approvals', 'audit_log',
    'memory_entries', 'mcp_servers', 'mcp_tools'
  ]
  loop
    execute format('alter table %I enable row level security', target);
  end loop;
end
$$;
