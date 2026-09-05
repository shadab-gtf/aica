/**
 * The agent server.
 *
 * §3: one local process owns all state, both user interfaces are clients, and
 * this is the policy enforcement point. A UI may *request* anything; what it
 * gets is decided here. That is why, for example, `code/search` takes a query
 * and returns ranked matches rather than taking a file list and returning
 * contents — the retrieval budget (§51, §63) is enforced on this side, where a
 * client cannot opt out of it.
 *
 * Handlers are thin on purpose. Each one resolves a project, calls into an
 * engine that already exists, and maps the result through `summaries.ts`. When
 * a handler starts to contain logic, that logic belongs in a package where it
 * can be tested without a transport.
 */

import type { AIProvider } from '@aica/agent-core';
import { retrieve } from '@aica/code-intelligence';
import { analyzeImpact } from '@aica/code-graph';
import { makePatch } from '@aica/fs-engine';
import { buildPlan, matchEndpoint, parseIntent, renderBrief } from '@aica/integration-planner';
import type { RpcConnection } from '@aica/rpc';
import type { ProjectSummary } from '@aica/schemas';
import { PROTOCOL_VERSION, clientMethods, serverMethods } from '@aica/schemas';
import type { AgentEvent, Id, Logger, Result } from '@aica/shared';
import { AgentError, ErrorCode, EventBus, err, ok, silentLogger } from '@aica/shared';
import { diagnose } from '@aica/validation-engine';

import { Gateway } from './gateway.js';
import { Orchestrator } from './orchestrator.js';
import type { KeychainReader } from './project.js';
import { ProjectSession } from './project.js';
import {
  resolveImpactTarget,
  toApiSummary,
  toCodeMatches,
  toEndpointSummary,
  toImpactSummary,
  toIndexSummary,
  toPlanSummary,
  toValidationSummary,
} from './summaries.js';

export const SERVER_VERSION = '0.1.0';

export interface AgentServerOptions {
  readonly connection: RpcConnection;
  readonly logger?: Logger;
  /** Injected in tests so no Postman request ever leaves the process. */
  readonly fetchImpl?: typeof fetch;
  /**
   * Injected in tests so a whole run — planning, tool dispatch, patching,
   * validation, repair — executes with no key and no network.
   */
  readonly provider?: AIProvider;
}

interface ClientCapabilities {
  secretStorage: boolean;
  approvals: boolean;
}

export class AgentServer {
  private readonly gateway: Gateway;
  private readonly logger: Logger;
  private readonly events = new EventBus();
  private readonly projects = new Map<string, ProjectSession>();
  /**
   * One orchestrator per project. It owns that project's patch registry, so a
   * patch proposed in one project cannot be applied from another — §48's
   * isolation again, this time for something that writes.
   */
  private readonly orchestrators = new Map<string, Orchestrator>();
  private capabilities: ClientCapabilities = { secretStorage: false, approvals: false };
  private initialized = false;

  constructor(private readonly options: AgentServerOptions) {
    this.logger = (options.logger ?? silentLogger).child('server');
    this.gateway = new Gateway({ connection: options.connection, logger: this.logger });

    // Every event the core emits is forwarded to the client as a notification.
    // The UI renders from this stream and nothing else (§5.1), which is what
    // keeps the run timeline and the audit record derived from one source.
    this.events.subscribe((event) => {
      this.options.connection.notify('agent/event', toEventNotification(event));
    });

    this.registerHandlers();
  }

  get eventBus(): EventBus {
    return this.events;
  }

  /** The method table, so a second transport can reach the same handlers. */
  get methodTable(): Gateway {
    return this.gateway;
  }

  private registerHandlers(): void {
    const g = this.gateway;

    g.register(clientMethods.initialize, async (params) => {
      this.capabilities = {
        secretStorage: params.capabilities.secretStorage,
        approvals: params.capabilities.approvals,
      };
      this.initialized = true;
      this.logger.info('client connected', {
        client: params.clientName,
        version: params.clientVersion,
      });

      return ok({
        serverVersion: SERVER_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        methods: [...this.gateway.methods],
      });
    });

    g.register(clientMethods.shutdown, async () => {
      this.logger.info('shutdown requested');
      return ok({ ok: true as const });
    });

    g.register(clientMethods.openProject, async (params) => {
      const session = new ProjectSession({
        root: params.root,
        ...(params.name ? { name: params.name } : {}),
        logger: this.logger,
        ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
        // Only offered when the client said it can answer. A server that calls
        // a capability the client never advertised gets a timeout, not an
        // error, which is the worst failure mode available.
        ...(this.capabilities.secretStorage ? { keychainReader: this.keychainReader() } : {}),
      });

      const opened = await session.open();
      if (!opened.ok) return opened;

      this.projects.set(session.projectId, session);
      return ok(toProjectSummary(session));
    });

    g.register(clientMethods.listProjects, async () =>
      ok({ projects: [...this.projects.values()].map(toProjectSummary) }),
    );

    g.register(clientMethods.projectStatus, async (params) => {
      const session = this.project(params.projectId);
      if (!session.ok) return session;
      const project = session.value;

      const index = project.codeIndex;

      return ok({
        project: toProjectSummary(project),
        ...(index ? { index: toIndexSummary(index.stats, index.resolutionRate) } : {}),
        apiCount: project.apiCount,
        planCount: project.planCount,
        postmanReady: project.postmanConfigured && this.capabilities.secretStorage,
      });
    });

    g.register(clientMethods.indexCode, async (params) => {
      const session = this.project(params.projectId);
      if (!session.ok) return session;

      const built = await session.value.buildIndex({
        ...(params.root ? { root: params.root } : {}),
        ...(params.maxFiles ? { maxFiles: params.maxFiles } : {}),
      });
      if (!built.ok) return built;

      return ok(toIndexSummary(built.value.stats, built.value.resolutionRate));
    });

    g.register(clientMethods.searchCode, async (params) => {
      const index = this.requireIndex(params.projectId);
      if (!index.ok) return index;

      const result = retrieve(index.value, { text: params.query, maxItems: params.limit });
      return ok({ matches: toCodeMatches(result) });
    });

    g.register(clientMethods.importApi, async (params) => {
      const session = this.project(params.projectId);
      if (!session.ok) return session;
      const project = session.value;

      const imported = await importApi(project, params.source, params.name);
      if (!imported.ok) return imported;

      return ok(toApiSummary(imported.value.spec, imported.value.format));
    });

    g.register(clientMethods.listApis, async (params) => {
      const session = this.project(params.projectId);
      if (!session.ok) return session;

      return ok({
        apis: session.value.listApis().map((api) => toApiSummary(api.spec, api.format)),
      });
    });

    g.register(clientMethods.listEndpoints, async (params) => {
      const session = this.project(params.projectId);
      if (!session.ok) return session;
      const project = session.value;

      const catalog = project.endpoints();
      const records = params.query
        ? catalog.search(params.query, { limit: params.limit }).map((hit) => hit.record)
        : catalog.all();

      const index = project.codeIndex;

      const endpoints = records
        .filter((record) => !params.apiId || record.specId === params.apiId)
        .slice(0, params.limit)
        .map((record) => {
          const spec = project.api(record.specId)?.spec;
          // Call sites come from the index when there is one. Without an index
          // the answer is "not known", which is an empty list — never a claim
          // that the endpoint is unused.
          const callSites =
            index && spec ? matchEndpoint(record.endpoint, spec, index).callSites : [];
          return toEndpointSummary(record.endpoint, record.specId, callSites);
        });

      return ok({ endpoints });
    });

    g.register(clientMethods.listPostmanWorkspaces, async (params) => {
      const client = await this.postman(params.projectId, params.refresh);
      if (!client.ok) return client;

      const workspaces = await client.value.listWorkspaces();
      if (!workspaces.ok) return workspaces;

      return ok({ workspaces: workspaces.value.map((workspace) => ({ ...workspace })) });
    });

    g.register(clientMethods.listPostmanCollections, async (params) => {
      const client = await this.postman(params.projectId, params.refresh);
      if (!client.ok) return client;

      const collections = await client.value.listCollections(params.workspaceId);
      if (!collections.ok) return collections;

      return ok({ collections: collections.value.map((collection) => ({ ...collection })) });
    });

    g.register(clientMethods.createPlan, async (params) => {
      const session = this.project(params.projectId);
      if (!session.ok) return session;
      const project = session.value;

      const index = project.codeIndex;
      if (!index) {
        return err(
          new AgentError(
            ErrorCode.PRECONDITION_FAILED,
            'The project has not been indexed yet. Run the index before planning.',
          ),
        );
      }

      const specs = params.apiId
        ? [project.api(params.apiId)?.spec].filter((spec) => spec !== undefined)
        : project.listApis().map((api) => api.spec);

      const plan = buildPlan({
        intent: parseIntent(params.message),
        code: index,
        ...(project.codeGraph ? { graph: project.codeGraph } : {}),
        specs,
      });

      const stored = project.storePlan(plan);
      return ok(toPlanSummary(stored.planId, stored.plan));
    });

    g.register(clientMethods.getPlanBrief, async (params) => {
      const session = this.project(params.projectId);
      if (!session.ok) return session;

      const stored = session.value.plan(params.planId);
      if (!stored) {
        return err(new AgentError(ErrorCode.NOT_FOUND, `No plan with id "${params.planId}".`));
      }

      return ok({ brief: renderBrief(stored.plan) });
    });

    g.register(clientMethods.runValidation, async (params, context) => {
      const session = this.project(params.projectId);
      if (!session.ok) return session;

      const pipeline = session.value.validation();
      const report = await pipeline.run({
        ...(params.only ? { only: params.only as never } : {}),
        runAll: params.runAll,
        signal: context.signal,
      });
      if (!report.ok) return report;

      return ok(toValidationSummary(report.value, diagnose(report.value)));
    });

    g.register(clientMethods.analyzeImpact, async (params) => {
      const session = this.project(params.projectId);
      if (!session.ok) return session;
      const project = session.value;

      const index = project.codeIndex;
      const graph = project.codeGraph;
      if (!index || !graph) {
        return err(
          new AgentError(
            ErrorCode.PRECONDITION_FAILED,
            'The project has not been indexed yet. Run the index before analysing impact.',
          ),
        );
      }

      const targetId = resolveImpactTarget(graph, index, params.file, params.symbol);
      if (!targetId) {
        return err(
          new AgentError(
            ErrorCode.NOT_FOUND,
            params.symbol
              ? `"${params.symbol}" is not in the index, or the name is ambiguous.`
              : `"${params.file}" is not in the index.`,
          ),
        );
      }

      const report = analyzeImpact(graph, index, targetId);
      if (!report) {
        return err(new AgentError(ErrorCode.NOT_FOUND, `"${targetId}" is not in the graph.`));
      }

      return ok(toImpactSummary(report));
    });

    g.register(clientMethods.startRun, async (params, context) => {
      const orchestrator = this.orchestrator(params.projectId);
      if (!orchestrator.ok) return orchestrator;

      const summary = await orchestrator.value.run({
        task: params.task,
        ...(params.apiId ? { apiId: params.apiId } : {}),
        signal: context.signal,
      });
      if (!summary.ok) return summary;

      return ok({
        runId: summary.value.runId,
        summary: summary.value.summary,
        iterations: summary.value.iterations,
        toolCalls: summary.value.toolCalls,
        patchesProposed: summary.value.patchesProposed,
        patchesApplied: summary.value.patchesApplied,
        filesChanged: [...summary.value.filesChanged],
        ...(summary.value.validationPassed !== undefined
          ? { validationPassed: summary.value.validationPassed }
          : {}),
        stoppedBecause: summary.value.stoppedBecause,
      });
    });

    g.register(clientMethods.cancelRun, async (params) => {
      // Any project's orchestrator may own the run; ids are unique across them.
      for (const orchestrator of this.orchestrators.values()) {
        if (orchestrator.cancel(params.runId)) return ok({ cancelled: true });
      }
      return ok({ cancelled: false });
    });

    g.register(clientMethods.listRuns, async (params) => {
      const session = this.project(params.projectId);
      if (!session.ok) return session;

      const runs = await session.value.store.listRuns(params.projectId, { limit: params.limit });
      if (!runs.ok) return runs;

      return ok({
        runs: runs.value.map((run) => ({
          id: run.id,
          task: run.task,
          provider: run.provider,
          model: run.model,
          status: run.status,
          startedAt: run.startedAt,
          ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
          ...(run.summary ? { summary: run.summary } : {}),
          toolCalls: run.toolCalls,
          filesChanged: run.filesChanged,
          ...(run.validationPassed !== undefined ? { validationPassed: run.validationPassed } : {}),
        })),
      });
    });

    g.register(clientMethods.listRunEvents, async (params) => {
      // Replay, for a UI that connected mid-run or is reopening a finished one.
      for (const session of this.projects.values()) {
        const events = await session.store.listEvents(params.runId, params.sinceSeq);
        if (events.ok && events.value.length > 0) {
          return ok({ events: events.value.map((event) => ({ ...event })) });
        }
      }
      return ok({ events: [] });
    });

    g.register(clientMethods.listPatches, async (params) => {
      const orchestrator = this.orchestrator(params.projectId);
      if (!orchestrator.ok) return orchestrator;

      return ok({
        patches: orchestrator.value.patches.list().map((staged) => ({
          patchId: staged.patch.id,
          rationale: staged.preview.rationale,
          status: staged.status,
          proposedAt: staged.proposedAt,
          files: staged.preview.files.map((file) => ({ ...file })),
        })),
      });
    });

    g.register(clientMethods.previewPatch, async (params) => {
      const staged = this.stagedPatch(params.projectId, params.patchId);
      if (!staged.ok) return staged;

      const session = this.project(params.projectId);
      if (!session.ok) return session;

      // Re-staged against the working tree as it is now, so the review shows
      // the change against what is actually there — not against a snapshot
      // taken when the agent started, which the user may have edited since.
      const contents = await session.value.patchEngine().proposedContents(staged.value.patch);
      if (!contents.ok) return contents;

      return ok({
        patchId: params.patchId,
        rationale: staged.value.preview.rationale,
        diff: staged.value.preview.diff,
        files: contents.value.map((file) => ({ ...file })),
      });
    });

    g.register(clientMethods.applyPatch, async (params) => {
      const staged = this.stagedPatch(params.projectId, params.patchId);
      if (!staged.ok) return staged;

      if (staged.value.status === 'applied') {
        return err(
          new AgentError(ErrorCode.ALREADY_EXISTS, 'That change has already been applied.'),
        );
      }

      const session = this.project(params.projectId);
      if (!session.ok) return session;

      // Captured before the write so a revert restores exactly what was there,
      // rather than inverting a diff and hoping.
      const before = await session.value.patchEngine().proposedContents(staged.value.patch);
      if (!before.ok) return before;

      const applied = await session.value.patchEngine().apply(staged.value.patch);
      if (!applied.ok) return applied;

      const orchestrator = this.orchestrator(params.projectId);
      if (orchestrator.ok) {
        orchestrator.value.patches.markApplied(params.patchId, applied.value);
        orchestrator.value.patches.rememberOriginals(
          params.patchId,
          new Map(before.value.map((file) => [file.path, file.before])),
        );
      }

      return ok({
        patchId: params.patchId,
        files: applied.value.files.map((file) => file.path),
      });
    });

    g.register(clientMethods.revertPatch, async (params) => {
      const staged = this.stagedPatch(params.projectId, params.patchId);
      if (!staged.ok) return staged;

      if (staged.value.status !== 'applied') {
        return err(
          new AgentError(
            ErrorCode.PRECONDITION_FAILED,
            'That change was never applied, so there is nothing to revert.',
          ),
        );
      }

      const originals = staged.value.revertTo;
      if (!originals) {
        return err(
          new AgentError(
            ErrorCode.PRECONDITION_FAILED,
            'The content from before this change was not recorded, so it cannot be reverted automatically. Use your version control history.',
          ),
        );
      }

      const session = this.project(params.projectId);
      if (!session.ok) return session;

      const restore = makePatch(
        `Revert: ${staged.value.preview.rationale}`,
        [...originals.entries()].map(([path, content]) => ({
          path,
          operation:
            content === undefined
              ? ({ kind: 'delete' } as const)
              : ({ kind: 'replace', content } as const),
        })),
      );

      const applied = await session.value.patchEngine().apply(restore);
      if (!applied.ok) return applied;

      const orchestrator = this.orchestrator(params.projectId);
      if (orchestrator.ok) orchestrator.value.patches.markReverted(params.patchId);

      return ok({
        patchId: params.patchId,
        files: applied.value.files.map((file) => file.path),
      });
    });

    g.register(clientMethods.discardPatch, async (params) => {
      const staged = this.stagedPatch(params.projectId, params.patchId);
      if (!staged.ok) return staged;

      if (staged.value.status === 'applied') {
        return err(
          new AgentError(
            ErrorCode.PRECONDITION_FAILED,
            'That change is already on disk. Revert it rather than discarding it.',
          ),
        );
      }

      const orchestrator = this.orchestrator(params.projectId);
      if (orchestrator.ok) orchestrator.value.patches.markDiscarded(params.patchId);
      return ok({ patchId: params.patchId, discarded: true });
    });
  }

  /**
   * Read a secret from the editor.
   *
   * The value crosses one pipe between two processes owned by the same user and
   * is registered with the project's redactor the moment it resolves, so
   * anything that later contains it is scrubbed. It is never logged here: the
   * failure path reports only whether a value was found.
   */
  private keychainReader(): KeychainReader {
    return async (name, reason) => {
      const response = await this.options.connection.request(serverMethods.readSecret.method, {
        name,
        reason,
      });
      if (!response.ok) {
        this.logger.warn('the editor could not supply a secret', { name });
        return undefined;
      }

      const parsed = serverMethods.readSecret.result.safeParse(response.value);
      if (!parsed.success || !parsed.data.found) return undefined;
      return parsed.data.value;
    };
  }

  /** The orchestrator for a project, created on first use. */
  private orchestrator(projectId: string): Result<Orchestrator> {
    const existing = this.orchestrators.get(projectId);
    if (existing) return ok(existing);

    const session = this.project(projectId);
    if (!session.ok) return session;

    const orchestrator = new Orchestrator({
      session: session.value,
      bus: this.events,
      logger: this.logger,
      askApproval: async (request) => {
        if (!this.capabilities.approvals) return { granted: false };

        const response = await this.options.connection.request(
          serverMethods.requestApproval.method,
          {
            approvalId: request.id,
            subject: request.action.subject,
            risk: request.action.risk,
            detail: request.reason,
            ...(request.action.environment ? { environment: request.action.environment } : {}),
          },
        );
        if (!response.ok) return { granted: false };

        const parsed = serverMethods.requestApproval.result.safeParse(response.value);
        // An unparseable answer is not an answer. Failing closed is the only
        // safe reading of "the client said something we do not understand".
        if (!parsed.success) return { granted: false };
        return { granted: parsed.data.granted, remember: parsed.data.remembered };
      },
      ...(this.options.provider ? { provider: this.options.provider } : {}),
    });

    this.orchestrators.set(projectId, orchestrator);
    return ok(orchestrator);
  }

  private stagedPatch(projectId: string, patchId: string) {
    const orchestrator = this.orchestrator(projectId);
    if (!orchestrator.ok) return orchestrator;

    const staged = orchestrator.value.patches.get(patchId);
    if (!staged) {
      return err(
        new AgentError(ErrorCode.NOT_FOUND, `No patch "${patchId}" was proposed in this project.`),
      );
    }
    return ok(staged);
  }

  private project(projectId: string): Result<ProjectSession> {
    const session = this.projects.get(projectId);
    if (!session) {
      return err(
        new AgentError(ErrorCode.NOT_FOUND, `No open project with id "${projectId}".`, {
          details: { projectId },
        }),
      );
    }
    return ok(session);
  }

  private requireIndex(projectId: string) {
    const session = this.project(projectId);
    if (!session.ok) return session;

    const index = session.value.codeIndex;
    if (!index) {
      return err(
        new AgentError(
          ErrorCode.PRECONDITION_FAILED,
          'The project has not been indexed yet. Run the index first.',
        ),
      );
    }
    return ok(index);
  }

  private async postman(projectId: string, refresh: boolean) {
    const session = this.project(projectId);
    if (!session.ok) return session;

    if (!this.capabilities.secretStorage) {
      return err(
        new AgentError(
          ErrorCode.PRECONDITION_FAILED,
          'This client cannot supply stored credentials, so Postman is unavailable.',
        ),
      );
    }

    const client = await session.value.postmanClient();
    if (!client.ok) return client;

    // A refresh is the user saying the cached answer is stale — usually because
    // they just created something in Postman and it is not in the list.
    if (refresh) client.value.clearCache();
    return ok(client.value);
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  /** Open projects, for tests and for a status command. */
  get openProjects(): readonly ProjectSession[] {
    return [...this.projects.values()];
  }
}

function toProjectSummary(session: ProjectSession): ProjectSummary {
  return {
    projectId: session.projectId,
    name: session.name,
    root: session.root,
    configIssues: session.issues.map((issue) => ({ path: issue.path, message: issue.message })),
    hasConfig: session.configured,
  };
}

async function importApi(
  project: ProjectSession,
  source: { kind: string; text?: string; path?: string; format?: string; collectionUid?: string },
  name?: string,
) {
  switch (source.kind) {
    case 'text':
      return project.importText(source.text ?? '', {
        ...(name ? { name } : {}),
        ...(source.format ? { format: source.format } : {}),
      });
    case 'file':
      return project.importFile(source.path ?? '', source.format);
    case 'postman':
      return project.importPostmanCollection(source.collectionUid ?? '', name);
    default:
      return err(new AgentError(ErrorCode.UNSUPPORTED, `Unknown import source "${source.kind}".`));
  }
}

function toEventNotification(event: AgentEvent): Record<string, unknown> {
  return {
    id: event.id,
    runId: event.runId,
    projectId: event.projectId,
    seq: event.seq,
    at: event.at,
    type: event.type,
    payload: event.payload,
  };
}

export type { Id };
