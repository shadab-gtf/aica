/**
 * The persistence contract.
 *
 * Two implementations sit behind it: an in-memory one, and Postgres through a
 * local Supabase stack. The interface exists because of what each is for, not
 * to keep options open — the in-memory store is what tests and an unconfigured
 * project run against, so the entire server works with no database at all, and
 * "the database is not running" is never the reason a user cannot index their
 * code.
 *
 * Three rules hold across every method here.
 *
 * **Metadata only.** Nothing in these types carries source text, a doc comment,
 * a snippet, a prompt, or model output. The shapes below are the enforcement:
 * there is no field to put file contents in.
 *
 * **Writes never fail a run.** Persistence is a projection of work that already
 * happened. A store that is down should degrade to "no history", not to "the
 * agent cannot work", so write methods return `Result` and every caller is
 * expected to log a failure and continue.
 *
 * **Project-scoped by construction.** Every method takes a project id, because
 * §48's isolation should not depend on remembering to add a filter.
 */

import type { Result } from '@aica/shared';

export interface ProjectRecord {
  readonly id: string;
  readonly name: string;
  readonly root: string;
  readonly lastIndexedAt?: string;
  readonly fileCount: number;
  readonly symbolCount: number;
  readonly referenceCount: number;
  readonly resolutionRate: number;
}

export interface FileRecord {
  readonly path: string;
  readonly language?: string;
  readonly bytes: number;
  readonly lines: number;
  /** Detects a file that changed since indexing, without keeping what is in it. */
  readonly digest?: string;
}

export interface SymbolRow {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly kind: string;
  readonly exported: boolean;
  /** The declaration line as written. Never the doc comment below it. */
  readonly signature?: string;
  readonly container?: string;
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly isAsync: boolean;
  readonly deprecated: boolean;
}

export interface ReferenceRow {
  readonly path: string;
  readonly name: string;
  readonly kind: string;
  readonly line: number;
  readonly column: number;
  /** Absent when the reference could not be attributed — a blind spot. */
  readonly symbolId?: string;
  readonly isMember: boolean;
  readonly externalModule?: string;
}

export interface EdgeRow {
  readonly from: string;
  readonly to: string;
  readonly kind: string;
  readonly count: number;
}

export interface IndexSnapshot {
  readonly files: readonly FileRecord[];
  readonly symbols: readonly SymbolRow[];
  readonly references: readonly ReferenceRow[];
  readonly edges: readonly EdgeRow[];
  readonly stats: {
    readonly files: number;
    readonly symbols: number;
    readonly references: number;
    readonly resolutionRate: number;
  };
}

export interface ApiRow {
  readonly id: string;
  readonly title: string;
  readonly version?: string;
  readonly format: string;
  readonly sourceLocation?: string;
  readonly servers: readonly unknown[];
  readonly authSchemes: readonly unknown[];
  readonly warnings: readonly unknown[];
}

export interface EndpointRow {
  readonly apiId: string;
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly operationId?: string;
  readonly summary?: string;
  readonly tags: readonly string[];
  readonly requiresAuth: boolean;
  readonly deprecated: boolean;
}

export interface ApiSnapshot {
  readonly api: ApiRow;
  readonly endpoints: readonly EndpointRow[];
  readonly schemas: readonly { name: string; definition: unknown }[];
}

export interface RunRow {
  readonly id: string;
  readonly projectId: string;
  readonly task: string;
  readonly provider: string;
  readonly model: string;
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled';
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly summary?: string;
  readonly toolCalls: number;
  readonly filesChanged: number;
  readonly validationPassed?: boolean;
  readonly stoppedBecause?: string;
}

export interface RunEventRow {
  readonly id: string;
  readonly runId: string;
  readonly projectId: string;
  readonly seq: number;
  readonly type: string;
  readonly at: string;
  readonly payload: unknown;
}

export interface ToolCallRow {
  readonly id: string;
  readonly runId: string;
  readonly projectId: string;
  readonly tool: string;
  readonly risk: string;
  readonly subject?: string;
  readonly argsPreview?: string;
  readonly resultPreview?: string;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly error?: unknown;
  readonly at: string;
}

export interface ApprovalRow {
  readonly id: string;
  readonly projectId: string;
  readonly runId?: string;
  readonly subject: string;
  readonly risk: string;
  readonly environment?: string;
  readonly granted: boolean;
  readonly remembered: boolean;
  readonly at: string;
}

export interface AuditRow {
  readonly projectId: string;
  readonly runId?: string;
  readonly actor: string;
  readonly action: string;
  readonly subject: string;
  readonly decision: string;
  readonly at: string;
}

export interface FindingRow {
  readonly id: string;
  readonly projectId: string;
  readonly runId?: string;
  readonly title: string;
  readonly severity: string;
  readonly category: string;
  readonly path?: string;
  readonly line?: number;
}

export interface RunQuery {
  readonly limit?: number;
  readonly status?: RunRow['status'];
}

/**
 * The store.
 *
 * Deliberately not a generic repository. Each method corresponds to something
 * the server actually does, which keeps the Postgres implementation free to
 * batch a whole index in one transaction instead of row by row.
 */
export interface Store {
  readonly kind: 'memory' | 'supabase';

  /** True when the store is reachable. Checked once, at startup. */
  health(): Promise<Result<true>>;

  saveProject(project: ProjectRecord): Promise<Result<true>>;
  getProject(projectId: string): Promise<Result<ProjectRecord | undefined>>;
  listProjects(): Promise<Result<readonly ProjectRecord[]>>;

  /** Replace a project's whole index projection. */
  replaceIndex(projectId: string, snapshot: IndexSnapshot): Promise<Result<true>>;

  /** Free-text search over stored symbols, for the dashboard. */
  searchSymbols(
    projectId: string,
    query: string,
    limit?: number,
  ): Promise<Result<readonly SymbolRow[]>>;

  saveApi(projectId: string, snapshot: ApiSnapshot): Promise<Result<true>>;
  listApis(projectId: string): Promise<Result<readonly ApiSnapshot[]>>;
  deleteApi(projectId: string, apiId: string): Promise<Result<true>>;

  startRun(run: RunRow): Promise<Result<true>>;
  finishRun(runId: string, patch: Partial<RunRow>): Promise<Result<true>>;
  listRuns(projectId: string, query?: RunQuery): Promise<Result<readonly RunRow[]>>;

  appendEvent(event: RunEventRow): Promise<Result<true>>;
  listEvents(runId: string, sinceSeq?: number): Promise<Result<readonly RunEventRow[]>>;

  recordToolCall(call: ToolCallRow): Promise<Result<true>>;
  recordApproval(approval: ApprovalRow): Promise<Result<true>>;
  recordAudit(entry: AuditRow): Promise<Result<true>>;
  recordFindings(findings: readonly FindingRow[]): Promise<Result<true>>;

  close(): Promise<void>;
}

/**
 * Column names that must never appear in the schema.
 *
 * Kept here rather than only in the migration so that a test can assert the SQL
 * against it. The decision "metadata only, never file contents" is worth more
 * as something the build checks than as a comment someone has to remember.
 */
export const FORBIDDEN_COLUMN_NAMES: readonly string[] = [
  'content',
  'contents',
  'source_text',
  'snippet',
  'body',
  'doc',
  'docs',
  'documentation',
  'prompt',
  'completion',
  'response_text',
  'file_text',
  'code',
];
