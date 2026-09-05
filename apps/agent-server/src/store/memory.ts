/**
 * The in-memory store.
 *
 * Not a test double — it is the real default. A project with no database
 * configured runs on this, and everything except history across restarts works
 * exactly the same. That ordering matters: indexing a repository must not
 * depend on Docker being up, so Postgres is an upgrade rather than a
 * prerequisite.
 *
 * It also means the Supabase implementation has something to be checked
 * against: both run the same test suite, and any behaviour that differs between
 * them is a bug in one of them.
 */

import type { Result } from '@aica/shared';
import { ok } from '@aica/shared';

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

export class MemoryStore implements Store {
  readonly kind = 'memory' as const;

  private readonly projects = new Map<string, ProjectRecord>();
  private readonly indexes = new Map<string, IndexSnapshot>();
  private readonly apis = new Map<string, Map<string, ApiSnapshot>>();
  private readonly runs = new Map<string, RunRow>();
  private readonly events = new Map<string, RunEventRow[]>();
  private readonly toolCalls: ToolCallRow[] = [];
  private readonly approvals: ApprovalRow[] = [];
  private readonly audit: AuditRow[] = [];
  private readonly findings: FindingRow[] = [];

  async health(): Promise<Result<true>> {
    return ok(true);
  }

  async saveProject(project: ProjectRecord): Promise<Result<true>> {
    this.projects.set(project.id, project);
    return ok(true);
  }

  async getProject(projectId: string): Promise<Result<ProjectRecord | undefined>> {
    return ok(this.projects.get(projectId));
  }

  async listProjects(): Promise<Result<readonly ProjectRecord[]>> {
    return ok([...this.projects.values()]);
  }

  async replaceIndex(projectId: string, snapshot: IndexSnapshot): Promise<Result<true>> {
    this.indexes.set(projectId, snapshot);

    const project = this.projects.get(projectId);
    if (project) {
      this.projects.set(projectId, {
        ...project,
        lastIndexedAt: new Date().toISOString(),
        fileCount: snapshot.stats.files,
        symbolCount: snapshot.stats.symbols,
        referenceCount: snapshot.stats.references,
        resolutionRate: snapshot.stats.resolutionRate,
      });
    }

    return ok(true);
  }

  async searchSymbols(
    projectId: string,
    query: string,
    limit = 50,
  ): Promise<Result<readonly SymbolRow[]>> {
    const symbols = this.indexes.get(projectId)?.symbols ?? [];
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return ok([]);

    const matched = symbols
      .filter(
        (symbol) =>
          symbol.name.toLowerCase().includes(needle) || symbol.path.toLowerCase().includes(needle),
      )
      // Exported declarations first: a caller searching by name almost always
      // wants the public one, and Postgres ranks the same way.
      .sort(
        (left, right) =>
          Number(right.exported) - Number(left.exported) || left.name.localeCompare(right.name),
      );

    return ok(matched.slice(0, limit));
  }

  async saveApi(projectId: string, snapshot: ApiSnapshot): Promise<Result<true>> {
    const forProject = this.apis.get(projectId) ?? new Map<string, ApiSnapshot>();
    forProject.set(snapshot.api.id, snapshot);
    this.apis.set(projectId, forProject);
    return ok(true);
  }

  async listApis(projectId: string): Promise<Result<readonly ApiSnapshot[]>> {
    return ok([...(this.apis.get(projectId)?.values() ?? [])]);
  }

  async deleteApi(projectId: string, apiId: string): Promise<Result<true>> {
    this.apis.get(projectId)?.delete(apiId);
    return ok(true);
  }

  async startRun(run: RunRow): Promise<Result<true>> {
    this.runs.set(run.id, run);
    return ok(true);
  }

  async finishRun(runId: string, patch: Partial<RunRow>): Promise<Result<true>> {
    const existing = this.runs.get(runId);
    // A patch for a run that was never started is dropped rather than inserted.
    // Inventing a row from a partial would produce a run record with no task.
    if (existing) this.runs.set(runId, { ...existing, ...patch });
    return ok(true);
  }

  async listRuns(projectId: string, query: RunQuery = {}): Promise<Result<readonly RunRow[]>> {
    const rows = [...this.runs.values()]
      .filter((run) => run.projectId === projectId)
      .filter((run) => query.status === undefined || run.status === query.status)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));

    return ok(query.limit === undefined ? rows : rows.slice(0, query.limit));
  }

  async appendEvent(event: RunEventRow): Promise<Result<true>> {
    const existing = this.events.get(event.runId);
    if (existing) existing.push(event);
    else this.events.set(event.runId, [event]);
    return ok(true);
  }

  async listEvents(runId: string, sinceSeq = 0): Promise<Result<readonly RunEventRow[]>> {
    const rows = (this.events.get(runId) ?? [])
      .filter((event) => event.seq > sinceSeq)
      .sort((left, right) => left.seq - right.seq);
    return ok(rows);
  }

  async recordToolCall(call: ToolCallRow): Promise<Result<true>> {
    this.toolCalls.push(call);
    return ok(true);
  }

  async recordApproval(approval: ApprovalRow): Promise<Result<true>> {
    this.approvals.push(approval);
    return ok(true);
  }

  async recordAudit(entry: AuditRow): Promise<Result<true>> {
    this.audit.push(entry);
    return ok(true);
  }

  async recordFindings(findings: readonly FindingRow[]): Promise<Result<true>> {
    this.findings.push(...findings);
    return ok(true);
  }

  async close(): Promise<void> {
    // Nothing to release.
  }

  // Inspection, for tests and for a status command.

  get toolCallHistory(): readonly ToolCallRow[] {
    return this.toolCalls;
  }

  get approvalHistory(): readonly ApprovalRow[] {
    return this.approvals;
  }

  get auditTrail(): readonly AuditRow[] {
    return this.audit;
  }

  get findingHistory(): readonly FindingRow[] {
    return this.findings;
  }

  indexOf(projectId: string): IndexSnapshot | undefined {
    return this.indexes.get(projectId);
  }
}
