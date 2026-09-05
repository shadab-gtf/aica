/**
 * Postgres, through a local Supabase stack.
 *
 * "Local" is a security property, not a deployment preference. §7 forbids
 * silent data egress, and a symbol index is a map of someone's private
 * codebase. The default configuration points at `127.0.0.1:54321` — a stack the
 * developer started with `supabase start` — and a project that wants a hosted
 * instance has to say so explicitly, in configuration, with a secret reference
 * for the key.
 *
 * The connection uses the **service role**, which is why the schema enables
 * row-level security everywhere with no policies: the server bypasses RLS, and
 * every other key can read nothing. If this ever points at a hosted project by
 * accident, the failure mode is "no access", not "the whole index readable by
 * anyone holding the publishable key".
 *
 * Writes here are best-effort by contract. Every method returns `Result` and
 * every caller logs and continues, because history is a projection of work that
 * already happened — a database being down must never be the reason someone
 * cannot index their code.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@supabase/supabase-js';

import type { Logger, Result } from '@aica/shared';
import { AgentError, ErrorCode, err, ok, silentLogger } from '@aica/shared';

import type {
  ApiSnapshot,
  ApprovalRow,
  AuditRow,
  FindingRow,
  IndexSnapshot,
  ProjectRecord,
  RunEventRow,
  RunQuery,
  RunRow,
  Store,
  SymbolRow,
  ToolCallRow,
} from './contract.js';

export const SUPABASE_DEFAULT_URL = 'http://127.0.0.1:54321';

export interface SupabaseStoreOptions {
  readonly url: string;
  /** Service-role key, already resolved from a secret reference. */
  readonly serviceKey: string;
  readonly logger?: Logger;
  /** Injected in tests. */
  readonly client?: SupabaseClient;
  /**
   * Rows per insert. Postgres will take far more, but a single statement
   * carrying a hundred thousand references is a request body that times out
   * before it is a query that is slow.
   */
  readonly batchSize?: number;
}

const DEFAULT_BATCH_SIZE = 500;

export class SupabaseStore implements Store {
  readonly kind = 'supabase' as const;

  private readonly client: SupabaseClient;
  private readonly logger: Logger;
  private readonly batchSize: number;

  constructor(options: SupabaseStoreOptions) {
    this.client =
      options.client ??
      createClient(options.url, options.serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    this.logger = (options.logger ?? silentLogger).child('store');
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  /**
   * Prove the stack is up and migrated before anything depends on it.
   *
   * A cheap select against a table the migration creates checks three things at
   * once: the process is reachable, the key is accepted, and the schema exists.
   * Checking only that the port answers would let a server start against an
   * empty database and fail on its first write.
   */
  async health(): Promise<Result<true>> {
    const { error } = await this.client.from('projects').select('id').limit(1);
    if (error) {
      return err(
        new AgentError(
          ErrorCode.CONFIG_ERROR,
          `The database is not reachable or not migrated: ${error.message}. Run \`pnpm db:start\` and \`pnpm db:push\`.`,
          { details: { code: error.code } },
        ),
      );
    }
    return ok(true);
  }

  async saveProject(project: ProjectRecord): Promise<Result<true>> {
    return this.write('projects', () =>
      this.client.from('projects').upsert(
        {
          id: project.id,
          name: project.name,
          root: project.root,
          last_indexed_at: project.lastIndexedAt ?? null,
          file_count: project.fileCount,
          symbol_count: project.symbolCount,
          reference_count: project.referenceCount,
          resolution_rate: project.resolutionRate,
        },
        { onConflict: 'id' },
      ),
    );
  }

  async getProject(projectId: string): Promise<Result<ProjectRecord | undefined>> {
    const { data, error } = await this.client
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .maybeSingle();

    if (error) return this.readError('projects', error.message);
    return ok(data ? toProjectRecord(data) : undefined);
  }

  async listProjects(): Promise<Result<readonly ProjectRecord[]>> {
    const { data, error } = await this.client.from('projects').select('*');
    if (error) return this.readError('projects', error.message);
    return ok((data ?? []).map(toProjectRecord));
  }

  /**
   * Replace a project's index projection.
   *
   * Delete then insert, rather than upsert. An index is a complete statement
   * about a repository at a moment: a symbol that was removed must disappear,
   * and an upsert would leave it behind to be found by a later search that
   * confidently reports a declaration which no longer exists.
   */
  async replaceIndex(projectId: string, snapshot: IndexSnapshot): Promise<Result<true>> {
    for (const table of ['refs', 'graph_edges', 'symbols', 'files']) {
      const { error } = await this.client.from(table).delete().eq('project_id', projectId);
      if (error) return this.writeError(table, error.message);
    }

    const files = snapshot.files.map((file) => ({
      project_id: projectId,
      path: file.path,
      language: file.language ?? null,
      bytes: file.bytes,
      lines: file.lines,
      digest: file.digest ?? null,
    }));

    const symbols = snapshot.symbols.map((symbol) => ({
      project_id: projectId,
      id: symbol.id,
      path: symbol.path,
      name: symbol.name,
      kind: symbol.kind,
      exported: symbol.exported,
      signature: symbol.signature ?? null,
      container: symbol.container ?? null,
      start_line: symbol.startLine,
      start_column: symbol.startColumn,
      end_line: symbol.endLine,
      end_column: symbol.endColumn,
      is_async: symbol.isAsync,
      deprecated: symbol.deprecated,
    }));

    const references = snapshot.references.map((reference) => ({
      project_id: projectId,
      path: reference.path,
      name: reference.name,
      kind: reference.kind,
      line: reference.line,
      column: reference.column,
      symbol_id: reference.symbolId ?? null,
      is_member: reference.isMember,
      external_module: reference.externalModule ?? null,
    }));

    const edges = snapshot.edges.map((edge) => ({
      project_id: projectId,
      from_id: edge.from,
      to_id: edge.to,
      kind: edge.kind,
      count: edge.count,
    }));

    // Order matters: symbols before the references that point at them.
    for (const [table, rows] of [
      ['files', files],
      ['symbols', symbols],
      ['refs', references],
      ['graph_edges', edges],
    ] as const) {
      const inserted = await this.insertBatched(table, rows);
      if (!inserted.ok) return inserted;
    }

    return this.write('projects', () =>
      this.client
        .from('projects')
        .update({
          last_indexed_at: new Date().toISOString(),
          file_count: snapshot.stats.files,
          symbol_count: snapshot.stats.symbols,
          reference_count: snapshot.stats.references,
          resolution_rate: snapshot.stats.resolutionRate,
        })
        .eq('id', projectId),
    );
  }

  async searchSymbols(
    projectId: string,
    query: string,
    limit = 50,
  ): Promise<Result<readonly SymbolRow[]>> {
    const needle = query.trim();
    if (needle.length === 0) return ok([]);

    const { data, error } = await this.client
      .from('symbols')
      .select('*')
      .eq('project_id', projectId)
      // `websearch` accepts what a person types — quoted phrases, `or`, `-` for
      // exclusion — without a syntax error on input a search box will receive.
      .textSearch('search', needle, { type: 'websearch', config: 'simple' })
      .order('exported', { ascending: false })
      .order('name', { ascending: true })
      .limit(limit);

    if (error) return this.readError('symbols', error.message);
    return ok((data ?? []).map(toSymbolRow));
  }

  async saveApi(projectId: string, snapshot: ApiSnapshot): Promise<Result<true>> {
    const saved = await this.write('apis', () =>
      this.client.from('apis').upsert(
        {
          project_id: projectId,
          id: snapshot.api.id,
          title: snapshot.api.title,
          version: snapshot.api.version ?? null,
          format: snapshot.api.format,
          source_location: snapshot.api.sourceLocation ?? null,
          servers: snapshot.api.servers,
          auth_schemes: snapshot.api.authSchemes,
          warnings: snapshot.api.warnings,
        },
        { onConflict: 'project_id,id' },
      ),
    );
    if (!saved.ok) return saved;

    // Re-importing a specification replaces its endpoints. An endpoint removed
    // upstream must not linger in the catalog as something still callable.
    for (const table of ['endpoints', 'api_schemas']) {
      const { error } = await this.client
        .from(table)
        .delete()
        .eq('project_id', projectId)
        .eq('api_id', snapshot.api.id);
      if (error) return this.writeError(table, error.message);
    }

    const endpoints = snapshot.endpoints.map((endpoint) => ({
      project_id: projectId,
      api_id: snapshot.api.id,
      id: endpoint.id,
      method: endpoint.method,
      path: endpoint.path,
      operation_id: endpoint.operationId ?? null,
      summary: endpoint.summary ?? null,
      tags: endpoint.tags,
      requires_auth: endpoint.requiresAuth,
      deprecated: endpoint.deprecated,
    }));

    const inserted = await this.insertBatched('endpoints', endpoints);
    if (!inserted.ok) return inserted;

    return this.insertBatched(
      'api_schemas',
      snapshot.schemas.map((schema) => ({
        project_id: projectId,
        api_id: snapshot.api.id,
        name: schema.name,
        definition: schema.definition,
      })),
    );
  }

  async listApis(projectId: string): Promise<Result<readonly ApiSnapshot[]>> {
    const { data: apis, error } = await this.client
      .from('apis')
      .select('*')
      .eq('project_id', projectId);
    if (error) return this.readError('apis', error.message);

    const { data: endpoints, error: endpointError } = await this.client
      .from('endpoints')
      .select('*')
      .eq('project_id', projectId);
    if (endpointError) return this.readError('endpoints', endpointError.message);

    const { data: schemas, error: schemaError } = await this.client
      .from('api_schemas')
      .select('*')
      .eq('project_id', projectId);
    if (schemaError) return this.readError('api_schemas', schemaError.message);

    return ok(
      (apis ?? []).map((api) => ({
        api: toApiRow(api),
        endpoints: (endpoints ?? [])
          .filter((endpoint) => endpoint.api_id === api.id)
          .map(toEndpointRow),
        schemas: (schemas ?? [])
          .filter((schema) => schema.api_id === api.id)
          .map((schema) => ({ name: schema.name as string, definition: schema.definition })),
      })),
    );
  }

  async deleteApi(projectId: string, apiId: string): Promise<Result<true>> {
    return this.write('apis', () =>
      this.client.from('apis').delete().eq('project_id', projectId).eq('id', apiId),
    );
  }

  async startRun(run: RunRow): Promise<Result<true>> {
    return this.write('runs', () =>
      this.client.from('runs').upsert(
        {
          id: run.id,
          project_id: run.projectId,
          task: run.task,
          provider: run.provider,
          model: run.model,
          status: run.status,
          started_at: run.startedAt,
          tool_calls: run.toolCalls,
          files_changed: run.filesChanged,
        },
        { onConflict: 'id' },
      ),
    );
  }

  async finishRun(runId: string, patch: Partial<RunRow>): Promise<Result<true>> {
    const update: Record<string, unknown> = {};
    if (patch.status !== undefined) update['status'] = patch.status;
    if (patch.finishedAt !== undefined) update['finished_at'] = patch.finishedAt;
    if (patch.summary !== undefined) update['summary'] = patch.summary;
    if (patch.toolCalls !== undefined) update['tool_calls'] = patch.toolCalls;
    if (patch.filesChanged !== undefined) update['files_changed'] = patch.filesChanged;
    if (patch.validationPassed !== undefined) update['validation_passed'] = patch.validationPassed;
    if (patch.stoppedBecause !== undefined) update['stopped_because'] = patch.stoppedBecause;

    if (Object.keys(update).length === 0) return ok(true);
    return this.write('runs', () => this.client.from('runs').update(update).eq('id', runId));
  }

  async listRuns(projectId: string, query: RunQuery = {}): Promise<Result<readonly RunRow[]>> {
    let request = this.client
      .from('runs')
      .select('*')
      .eq('project_id', projectId)
      .order('started_at', { ascending: false });

    if (query.status) request = request.eq('status', query.status);
    if (query.limit !== undefined) request = request.limit(query.limit);

    const { data, error } = await request;
    if (error) return this.readError('runs', error.message);
    return ok((data ?? []).map(toRunRow));
  }

  async appendEvent(event: RunEventRow): Promise<Result<true>> {
    return this.write('run_events', () =>
      this.client.from('run_events').upsert(
        {
          id: event.id,
          run_id: event.runId,
          project_id: event.projectId,
          seq: event.seq,
          type: event.type,
          at: event.at,
          payload: event.payload ?? {},
        },
        // A replayed event must not become a second row: sequence numbers are
        // what a late-joining UI uses to detect gaps.
        { onConflict: 'id' },
      ),
    );
  }

  async listEvents(runId: string, sinceSeq = 0): Promise<Result<readonly RunEventRow[]>> {
    const { data, error } = await this.client
      .from('run_events')
      .select('*')
      .eq('run_id', runId)
      .gt('seq', sinceSeq)
      .order('seq', { ascending: true });

    if (error) return this.readError('run_events', error.message);
    return ok((data ?? []).map(toEventRow));
  }

  async recordToolCall(call: ToolCallRow): Promise<Result<true>> {
    return this.write('tool_calls', () =>
      this.client.from('tool_calls').upsert(
        {
          id: call.id,
          run_id: call.runId,
          project_id: call.projectId,
          tool: call.tool,
          risk: call.risk,
          subject: call.subject ?? null,
          args_preview: call.argsPreview ?? null,
          result_preview: call.resultPreview ?? null,
          ok: call.ok,
          duration_ms: call.durationMs,
          error: call.error ?? null,
          at: call.at,
        },
        { onConflict: 'id' },
      ),
    );
  }

  async recordApproval(approval: ApprovalRow): Promise<Result<true>> {
    return this.write('approvals', () =>
      this.client.from('approvals').upsert(
        {
          id: approval.id,
          project_id: approval.projectId,
          run_id: approval.runId ?? null,
          subject: approval.subject,
          risk: approval.risk,
          environment: approval.environment ?? null,
          granted: approval.granted,
          remembered: approval.remembered,
          at: approval.at,
        },
        { onConflict: 'id' },
      ),
    );
  }

  async recordAudit(entry: AuditRow): Promise<Result<true>> {
    return this.write('audit_log', () =>
      this.client.from('audit_log').insert({
        project_id: entry.projectId,
        run_id: entry.runId ?? null,
        actor: entry.actor,
        action: entry.action,
        subject: entry.subject,
        decision: entry.decision,
        at: entry.at,
      }),
    );
  }

  async recordFindings(findings: readonly FindingRow[]): Promise<Result<true>> {
    return this.insertBatched(
      'findings',
      findings.map((finding) => ({
        id: finding.id,
        project_id: finding.projectId,
        run_id: finding.runId ?? null,
        title: finding.title,
        severity: finding.severity,
        category: finding.category,
        path: finding.path ?? null,
        line: finding.line ?? null,
      })),
    );
  }

  async close(): Promise<void> {
    // The client holds no pool of its own; it speaks HTTP to PostgREST.
  }

  // -------------------------------------------------------------------------

  private async insertBatched(
    table: string,
    rows: readonly Record<string, unknown>[],
  ): Promise<Result<true>> {
    if (rows.length === 0) return ok(true);

    for (let offset = 0; offset < rows.length; offset += this.batchSize) {
      const chunk = rows.slice(offset, offset + this.batchSize);
      const { error } = await this.client.from(table).insert(chunk);
      if (error) return this.writeError(table, error.message);
    }

    return ok(true);
  }

  private async write(
    table: string,
    run: () => PromiseLike<{ error: { message: string } | null }>,
  ): Promise<Result<true>> {
    const { error } = await run();
    if (error) return this.writeError(table, error.message);
    return ok(true);
  }

  private writeError(table: string, message: string): Result<never> {
    this.logger.warn('write failed', { table });
    return err(
      new AgentError(ErrorCode.INTERNAL, `Could not write to "${table}": ${message}`, {
        details: { table },
        // Worth retrying: the common cause is the local stack still starting.
        retryable: true,
      }),
    );
  }

  private readError(table: string, message: string): Result<never> {
    return err(
      new AgentError(ErrorCode.INTERNAL, `Could not read "${table}": ${message}`, {
        details: { table },
        retryable: true,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function toProjectRecord(row: Row): ProjectRecord {
  return {
    id: String(row['id']),
    name: String(row['name']),
    root: String(row['root']),
    ...(row['last_indexed_at'] ? { lastIndexedAt: String(row['last_indexed_at']) } : {}),
    fileCount: Number(row['file_count'] ?? 0),
    symbolCount: Number(row['symbol_count'] ?? 0),
    referenceCount: Number(row['reference_count'] ?? 0),
    resolutionRate: Number(row['resolution_rate'] ?? 0),
  };
}

function toSymbolRow(row: Row): SymbolRow {
  return {
    id: String(row['id']),
    path: String(row['path']),
    name: String(row['name']),
    kind: String(row['kind']),
    exported: Boolean(row['exported']),
    ...(row['signature'] ? { signature: String(row['signature']) } : {}),
    ...(row['container'] ? { container: String(row['container']) } : {}),
    startLine: Number(row['start_line'] ?? 0),
    startColumn: Number(row['start_column'] ?? 0),
    endLine: Number(row['end_line'] ?? 0),
    endColumn: Number(row['end_column'] ?? 0),
    isAsync: Boolean(row['is_async']),
    deprecated: Boolean(row['deprecated']),
  };
}

function toApiRow(row: Row): ApiSnapshot['api'] {
  return {
    id: String(row['id']),
    title: String(row['title']),
    ...(row['version'] ? { version: String(row['version']) } : {}),
    format: String(row['format']),
    ...(row['source_location'] ? { sourceLocation: String(row['source_location']) } : {}),
    servers: (row['servers'] as unknown[]) ?? [],
    authSchemes: (row['auth_schemes'] as unknown[]) ?? [],
    warnings: (row['warnings'] as unknown[]) ?? [],
  };
}

function toEndpointRow(row: Row): ApiSnapshot['endpoints'][number] {
  return {
    apiId: String(row['api_id']),
    id: String(row['id']),
    method: String(row['method']),
    path: String(row['path']),
    ...(row['operation_id'] ? { operationId: String(row['operation_id']) } : {}),
    ...(row['summary'] ? { summary: String(row['summary']) } : {}),
    tags: (row['tags'] as string[]) ?? [],
    requiresAuth: Boolean(row['requires_auth']),
    deprecated: Boolean(row['deprecated']),
  };
}

function toRunRow(row: Row): RunRow {
  return {
    id: String(row['id']),
    projectId: String(row['project_id']),
    task: String(row['task']),
    provider: String(row['provider']),
    model: String(row['model']),
    status: String(row['status']) as RunRow['status'],
    startedAt: String(row['started_at']),
    ...(row['finished_at'] ? { finishedAt: String(row['finished_at']) } : {}),
    ...(row['summary'] ? { summary: String(row['summary']) } : {}),
    toolCalls: Number(row['tool_calls'] ?? 0),
    filesChanged: Number(row['files_changed'] ?? 0),
    ...(row['validation_passed'] === null || row['validation_passed'] === undefined
      ? {}
      : { validationPassed: Boolean(row['validation_passed']) }),
    ...(row['stopped_because'] ? { stoppedBecause: String(row['stopped_because']) } : {}),
  };
}

function toEventRow(row: Row): RunEventRow {
  return {
    id: String(row['id']),
    runId: String(row['run_id']),
    projectId: String(row['project_id']),
    seq: Number(row['seq'] ?? 0),
    type: String(row['type']),
    at: String(row['at']),
    payload: row['payload'],
  };
}
