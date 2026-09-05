/**
 * A run, from a sentence to a validated change.
 *
 * This is where the pieces built over the last five phases finally meet, and
 * the order they meet in is the design:
 *
 * 1. **Plan first, deterministically.** The integration planner reads the index
 *    and the API catalog and produces a brief. The model is given that brief,
 *    not the raw request — so the constraints, the protected files, and the
 *    open questions are in front of it before it writes anything.
 * 2. **The model works through tools only.** Context arrives by retrieval; the
 *    only route to a side effect is the registry (§5.5).
 * 3. **Validation decides whether the work was any good**, not the model. §2's
 *    authority order puts the compiler above the model, and this is the place
 *    that is enforced.
 * 4. **Repair is bounded and deterministic.** `runRepairLoop` owns the budget
 *    and the progress rule; the model is only the thing that performs an
 *    attempt.
 *
 * A run that changes nothing is a normal outcome. So is one that proposes a
 * change the user rejects. Neither is reported as success.
 */

import type { AIProvider, Message } from '@aica/agent-core';
import { AgentRuntime, OpenRouterProvider, ScriptedProvider } from '@aica/agent-core';
import { buildPlan, parseIntent, renderBrief } from '@aica/integration-planner';
import type { EventBus, Id, Logger, Result } from '@aica/shared';
import { AgentError, ErrorCode, RunEmitter, err, newId, ok, silentLogger } from '@aica/shared';
import { ApprovalGate } from '@aica/security-engine';
import type { ApprovalRequest, ApprovalResponse } from '@aica/security-engine';
import { ToolDispatcher, ToolRegistry } from '@aica/tool-registry';
import { diagnose, runRepairLoop } from '@aica/validation-engine';

import type { ProjectSession } from './project.js';
import { PatchRegistry } from './tools/patches.js';
import { buildToolset } from './tools/index.js';

/** Asks the user. Returns a denial when nobody answers. */
export type ApprovalAsker = (request: ApprovalRequest) => Promise<ApprovalResponse>;

export interface RunRequest {
  readonly task: string;
  readonly apiId?: string;
  readonly signal?: AbortSignal;
}

export interface RunSummary {
  readonly runId: Id<'run'>;
  readonly summary: string;
  readonly iterations: number;
  readonly toolCalls: number;
  readonly patchesProposed: number;
  readonly patchesApplied: number;
  readonly filesChanged: readonly string[];
  readonly validationPassed?: boolean;
  readonly stoppedBecause: string;
}

export interface OrchestratorOptions {
  readonly session: ProjectSession;
  readonly bus: EventBus;
  readonly logger?: Logger;
  readonly askApproval?: ApprovalAsker;
  /** Injected in tests so a run needs neither a key nor a network. */
  readonly provider?: AIProvider;
}

/**
 * Modes in which the agent may write on its own.
 *
 * Everything else means it proposes and the user applies. `reviewEveryPatch` is
 * the obvious one; `readOnly` and `askAlways` are here because a mode that asks
 * about everything should not hand the model a tool that writes — the prompt
 * would arrive without a diff attached, which is not a review.
 */
const SELF_APPLY_MODES: ReadonlySet<string> = new Set(['auto', 'askOnDestructive']);

export class Orchestrator {
  private readonly logger: Logger;
  private readonly running = new Map<string, AbortController>();

  constructor(private readonly options: OrchestratorOptions) {
    this.logger = (options.logger ?? silentLogger).child('run');
  }

  /** Patches proposed by the most recent run, for review in the UI. */
  readonly patches = new PatchRegistry();

  get activeRuns(): readonly string[] {
    return [...this.running.keys()];
  }

  cancel(runId: string): boolean {
    const controller = this.running.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async run(request: RunRequest): Promise<Result<RunSummary>> {
    const session = this.options.session;
    const runId = newId('run');

    const provider = await this.resolveProvider();
    if (!provider.ok) return provider;

    const controller = new AbortController();
    this.running.set(runId, controller);
    if (request.signal) {
      request.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    const emitter = new RunEmitter({
      bus: this.options.bus,
      runId,
      projectId: session.projectId,
      // Everything leaving through the bus passes redaction first (§5.1).
      sanitize: (value) => session.redactor.value(value),
    });

    const store = session.store;
    const startedAt = new Date().toISOString();

    const recorded = await store.startRun({
      id: runId,
      projectId: session.projectId,
      task: request.task,
      provider: provider.value.id,
      model: provider.value.model,
      status: 'running',
      startedAt,
      toolCalls: 0,
      filesChanged: 0,
    });
    if (!recorded.ok) this.logger.warn('could not record the run', { runId });

    // Every event is persisted as it is emitted, so the timeline survives a
    // restart and the audit record (§29) is not a UI-only artifact.
    const unsubscribe = this.options.bus.subscribe((event) => {
      if (event.runId !== runId) return;
      void store
        .appendEvent({
          id: event.id,
          runId,
          projectId: event.projectId,
          seq: event.seq,
          type: event.type,
          at: event.at,
          payload: event.payload,
        })
        .then((result) => {
          if (!result.ok) this.logger.debug('event not persisted', { seq: event.seq });
        });
    });

    try {
      return await this.execute({ runId, request, provider: provider.value, emitter, controller });
    } finally {
      unsubscribe();
      this.running.delete(runId);
      this.options.bus.closeRun(runId);
    }
  }

  private async execute(context: {
    runId: Id<'run'>;
    request: RunRequest;
    provider: AIProvider;
    emitter: RunEmitter;
    controller: AbortController;
  }): Promise<Result<RunSummary>> {
    const session = this.options.session;
    const { runId, request, provider, emitter, controller } = context;

    const index = session.codeIndex;
    if (!index) {
      const error = new AgentError(
        ErrorCode.PRECONDITION_FAILED,
        'The project has not been indexed yet. Index it before starting a run.',
      );
      emitter.emit('AGENT_FAILED', { error: error.toJSON(), recoverable: true });
      return err(error);
    }

    // Step 1: a deterministic plan. The model is handed this rather than the
    // raw sentence, so it starts from evidence instead of from a paraphrase.
    const specs = request.apiId
      ? [session.api(request.apiId)?.spec].filter((spec) => spec !== undefined)
      : session.listApis().map((api) => api.spec);

    const plan = buildPlan({
      intent: parseIntent(request.task),
      code: index,
      ...(session.codeGraph ? { graph: session.codeGraph } : {}),
      specs,
    });

    emitter.emit('PLAN_CREATED', {
      planId: session.storePlan(plan).planId,
      summary: plan.endpoint ? `${plan.endpoint.method} ${plan.endpoint.path}` : plan.intent.action,
      steps: plan.steps.map((step) => ({
        index: step.order,
        title: step.description,
        ...(step.file ? { targets: [step.file] } : {}),
      })),
      risks: [...plan.constraints],
    });

    emitter.emit('CONFIDENCE_ASSESSED', {
      decision: 'plan',
      confidence:
        plan.confidence === 'high' ? 'HIGH' : plan.confidence === 'medium' ? 'MEDIUM' : 'LOW',
      evidence: plan.evidence.map((entry) => ({
        kind: 'planner',
        description: entry,
        supports: true,
      })),
    });

    // A plan the evidence does not support is a question, not a task. Running
    // anyway would produce a confident change built on a guess.
    if (plan.confidence === 'low' && plan.openQuestions.length > 0) {
      emitter.emit('CLARIFICATION_REQUESTED', {
        question: plan.openQuestions[0] as string,
        options: plan.openQuestions.slice(1),
        reason: 'The evidence does not determine what to change.',
      });
    }

    // Step 2: the agent loop.
    const canApply = SELF_APPLY_MODES.has(session.configuration.permissions.approvalMode);
    const registry = new ToolRegistry();
    for (const tool of buildToolset({ session, patches: this.patches, canApply })) {
      registry.register(tool);
    }

    const approvals = new ApprovalGate({
      context: {
        mode: session.configuration.permissions.approvalMode,
        allowedEnvironments: session.configuration.permissions.allowedEnvironments,
        apiExecutionEnabled: session.configuration.permissions.apiExecutionEnabled,
        allowedMutationMethods: session.configuration.permissions.allowedMutationMethods,
      },
      responder: this.options.askApproval ?? (async () => ({ granted: false })),
      onRequest: (approval) =>
        emitter.emit('APPROVAL_REQUESTED', {
          approvalId: approval.id,
          subject: approval.action.subject,
          risk: approval.action.risk,
          detail: approval.reason,
        }),
      onResolved: (approval, response) => {
        emitter.emit('APPROVAL_RESOLVED', {
          approvalId: approval.id,
          granted: response.granted,
          remembered: response.remember === true,
        });
        void session.store.recordApproval({
          id: approval.id,
          projectId: session.projectId,
          runId,
          subject: approval.action.subject,
          risk: approval.action.risk,
          granted: response.granted,
          remembered: response.remember === true,
          at: new Date().toISOString(),
        });
      },
    });

    const dispatcher = new ToolDispatcher({
      registry,
      approvals,
      redactor: session.redactor,
      logger: this.logger,
      onCall: (record) =>
        emitter.emit('TOOL_CALLED', {
          callId: record.callId,
          tool: record.tool,
          risk: record.risk,
          argsPreview: record.argsPreview,
        }),
      onComplete: (record) => {
        emitter.emit('TOOL_COMPLETED', {
          callId: record.callId,
          tool: record.tool,
          ok: record.ok,
          durationMs: record.durationMs,
          resultPreview: record.resultPreview,
          ...(record.error ? { error: record.error.toJSON() } : {}),
        });
        void session.store.recordToolCall({
          id: record.callId,
          runId,
          projectId: session.projectId,
          tool: record.tool,
          risk: record.risk,
          subject: record.subject,
          argsPreview: record.argsPreview,
          resultPreview: record.resultPreview,
          ok: record.ok,
          durationMs: record.durationMs,
          ...(record.error ? { error: record.error.toJSON() } : {}),
          at: new Date().toISOString(),
        });
      },
    });

    const runtime = new AgentRuntime({ provider, registry, dispatcher, logger: this.logger });

    const before = this.patches.list().length;
    const outcome = await runtime.run({
      runId,
      projectId: session.projectId,
      systemPrompt: systemPrompt(session, canApply),
      task: renderBrief(plan),
      emitter,
      signal: controller.signal,
      environment: 'local',
    });

    if (!outcome.ok) {
      await session.store.finishRun(runId, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
      });
      return outcome;
    }

    for (const staged of this.patches.list('proposed').slice(before)) {
      emitter.emit('PATCH_CREATED', {
        patchId: staged.patch.id,
        files: staged.preview.files,
        rationale: staged.preview.rationale,
      });
    }

    // Step 3 and 4: validate what was actually written, and repair within a
    // budget. Nothing was written means nothing to validate — reporting a pass
    // there would be the false reassurance this whole layer exists to prevent.
    let validationPassed: boolean | undefined;

    if (this.patches.appliedCount > 0) {
      const repaired = await this.validateAndRepair({
        runId,
        emitter,
        runtime,
        provider,
        controller,
        history: outcome.value.messages,
      });
      validationPassed = repaired;
    }

    const filesChanged = this.patches.changedFiles();

    emitter.emit('AGENT_COMPLETED', {
      summary: outcome.value.summary,
      filesChanged: filesChanged.length,
      validationPassed: validationPassed === true,
      durationMs: outcome.value.durationMs,
      toolCalls: outcome.value.toolCalls,
    });

    await session.store.finishRun(runId, {
      status: outcome.value.stoppedBecause === 'aborted' ? 'cancelled' : 'completed',
      finishedAt: new Date().toISOString(),
      summary: outcome.value.summary,
      toolCalls: outcome.value.toolCalls,
      filesChanged: filesChanged.length,
      ...(validationPassed !== undefined ? { validationPassed } : {}),
      stoppedBecause: outcome.value.stoppedBecause,
    });

    return ok({
      runId,
      summary: outcome.value.summary,
      iterations: outcome.value.iterations,
      toolCalls: outcome.value.toolCalls,
      patchesProposed: this.patches.list().length,
      patchesApplied: this.patches.appliedCount,
      filesChanged,
      ...(validationPassed !== undefined ? { validationPassed } : {}),
      stoppedBecause: outcome.value.stoppedBecause,
    });
  }

  /**
   * Validate, and let the model try to fix what failed — under §39's rules.
   *
   * The budget, the progress requirement, and the judgement about what is even
   * worth attempting all live in `runRepairLoop`. The model is the hands, not
   * the referee: it is handed one instruction derived from the leading group of
   * findings and its work is checked again by the same pipeline.
   */
  private async validateAndRepair(context: {
    runId: Id<'run'>;
    emitter: RunEmitter;
    runtime: AgentRuntime;
    provider: AIProvider;
    controller: AbortController;
    history: readonly Message[];
  }): Promise<boolean> {
    const session = this.options.session;
    const pipeline = session.validation();
    const configured = pipeline.configuredChecks();

    if (configured.length === 0) {
      // Not a pass. "No checks are configured" is a different statement from
      // "the checks passed", and the UI must be able to tell them apart.
      this.logger.info('no checks configured; the change is unvalidated');
      return false;
    }

    context.emitter.emit('VALIDATION_STARTED', { steps: configured });

    let attempt = 0;
    const result = await runRepairLoop({
      maxAttempts: session.configuration.validation.maxRepairAttempts,
      logger: this.logger,
      signal: context.controller.signal,
      validate: () => pipeline.run({ signal: context.controller.signal }),
      repair: async (instruction, diagnosisForAttempt) => {
        attempt += 1;
        context.emitter.emit('REPAIR_STARTED', {
          attempt,
          maxAttempts: session.configuration.validation.maxRepairAttempts,
          rootCause: diagnosisForAttempt.summary,
        });

        const repaired = await context.runtime.run({
          runId: context.runId,
          projectId: session.projectId,
          systemPrompt: systemPrompt(session, true),
          task: instruction,
          emitter: context.emitter,
          signal: context.controller.signal,
          history: context.history,
          environment: 'local',
        });

        context.emitter.emit('REPAIR_COMPLETED', {
          attempt,
          succeeded: repaired.ok,
          explanation: repaired.ok ? repaired.value.summary : repaired.error.message,
        });

        return repaired.ok;
      },
    });

    if (!result.ok) {
      context.emitter.emit('VALIDATION_FAILED', {
        results: [],
        failedStep: 'validation',
        diagnosis: result.error.message,
      });
      return false;
    }

    const report = result.value.report;
    const steps = report.results.map((entry) => ({
      name: entry.check,
      command: entry.command,
      passed: entry.passed,
      durationMs: entry.durationMs,
      ...(entry.skippedReason !== undefined ? { summary: entry.skippedReason } : {}),
    }));

    if (report.passed) {
      context.emitter.emit('VALIDATION_PASSED', { results: steps, durationMs: report.durationMs });
      return true;
    }

    const finalDiagnosis = diagnose(report);
    context.emitter.emit('VALIDATION_FAILED', {
      results: steps,
      failedStep: report.results.find((entry) => !entry.passed)?.check ?? 'validation',
      diagnosis: result.value.reason,
    });

    await session.store.recordFindings(
      report.findings.slice(0, 200).map((finding) => ({
        id: newId('find'),
        projectId: session.projectId,
        runId: context.runId,
        title: finding.message,
        severity: finding.severity === 'error' ? 'HIGH' : 'MEDIUM',
        category: finalDiagnosis.category,
        ...(finding.file ? { path: finding.file } : {}),
        ...(finding.line !== undefined ? { line: finding.line } : {}),
      })),
    );

    return false;
  }

  /**
   * Pick the provider named by configuration.
   *
   * An injected provider always wins, which is how the whole loop — tool
   * dispatch, patching, a validation failure, a repair attempt — is exercised
   * in CI with no key and no network.
   */
  private async resolveProvider(): Promise<Result<AIProvider>> {
    if (this.options.provider) return ok(this.options.provider);

    const model = this.options.session.configuration.model;

    if (model.provider === 'scripted') {
      // An empty script ends the run immediately with no tool calls. Useful as
      // a dry run — the plan is still built and emitted — and never mistaken
      // for a real one, because nothing was proposed.
      return ok(new ScriptedProvider({ turns: [], model: model.model }));
    }

    if (model.provider !== 'openrouter') {
      return err(
        new AgentError(
          ErrorCode.UNSUPPORTED,
          `No adapter is implemented for the "${model.provider}" provider. Use "openrouter", or "scripted" for a dry run.`,
        ),
      );
    }

    if (!model.apiKeyRef) {
      return err(
        new AgentError(
          ErrorCode.CONFIG_ERROR,
          'No model API key is configured. Set `model.apiKeyRef` to a secret reference such as `keychain:openrouter`.',
        ),
      );
    }

    // The key is resolved here and handed to the adapter as a value. It is
    // registered with the redactor by the resolver on the way through, so
    // anything that later echoes it is scrubbed.
    const apiKey = await this.options.session.requireSecrets().resolve(model.apiKeyRef);
    if (!apiKey.ok) return apiKey;

    return ok(
      new OpenRouterProvider({
        model: model.model,
        apiKey: apiKey.value,
        logger: this.logger,
        ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
      }),
    );
  }
}

/**
 * The system prompt.
 *
 * Short, and every line is a constraint that has cost something to learn. It
 * says what the model may not do rather than describing what it is; a model
 * given a persona and no boundaries will disable a failing test to make a
 * validation step pass, and has.
 */
function systemPrompt(session: ProjectSession, canApply: boolean): string {
  const conventions = session.configuration.conventions;

  return [
    'You are a careful engineer working inside an existing codebase.',
    '',
    'Rules:',
    '- Find things with code_search before reading files. Never ask for a file you have not established is relevant.',
    '- Read a file before editing it, and pass the hash it returns as expectedHash.',
    '- Prefer anchored edits over rewriting a file.',
    '- Follow the conventions the codebase already has. Do not introduce a second HTTP client, a second state library, or a second way of doing something that is already done.',
    '- Do not modify files the plan lists as protected unless there is no alternative, and say so if you do.',
    '- Never disable, skip, weaken, or delete a test or a check to make validation pass.',
    '- Never put a credential in code. Authentication is a scheme and a reference, never a value.',
    '- If the evidence does not tell you what to change, say what is missing instead of guessing.',
    canApply
      ? '- Propose a patch, then apply it, then run validate and fix what it reports.'
      : '- Propose patches for the user to review. You cannot apply them yourself; do not claim a change has been made.',
    ...(conventions.length > 0
      ? ['', 'Project conventions:', ...conventions.map((entry) => `- ${entry}`)]
      : []),
  ].join('\n');
}
