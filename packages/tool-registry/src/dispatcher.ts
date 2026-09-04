import type { z } from 'zod';

import type { AgentError, Id, Logger, Result, RiskLevel } from '@aica/shared';
import {
  AgentError as AgentErrorClass,
  ErrorCode,
  Limits,
  err,
  errors,
  newId,
  previewJson,
  silentLogger,
} from '@aica/shared';
import type { ApprovalGate, Redactor } from '@aica/security-engine';

import type { AnyToolDefinition, ToolContext } from './tool.js';
import type { ToolRegistry } from './registry.js';

/**
 * Tool dispatch.
 *
 * This is the enforcement point that every side effect passes through. In
 * order, one call:
 *
 * 1. resolves the tool by name, rejecting an unknown name with the list of
 *    valid ones so the model can correct itself;
 * 2. validates arguments against the tool's Zod schema, before any side effect;
 * 3. asks the security engine whether the action is permitted, and requests
 *    human approval when policy requires it;
 * 4. executes under a timeout, converting any throw into a structured error;
 * 5. redacts the result;
 * 6. records the call for the run timeline and the audit log.
 *
 * A tool failure is returned as a value. One failing tool must never end a run
 * (specification section 64).
 */

export interface ToolCallRequest {
  /** Provider-assigned identifier, echoed back so the model can correlate. */
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

export interface ToolCallRecord {
  readonly callId: Id<'call'>;
  readonly providerCallId: string;
  readonly tool: string;
  readonly risk: RiskLevel;
  readonly subject: string;
  readonly argsPreview: string;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly ok: boolean;
  readonly resultPreview: string;
  readonly error?: AgentError;
}

export interface ToolCallOutcome {
  readonly record: ToolCallRecord;
  /** Result payload on success. */
  readonly value?: unknown;
  /**
   * Text handed back to the model. On failure this is a corrective message: it
   * states what went wrong in terms the model can act on, because the repair
   * loop depends on the model being able to fix its own call.
   */
  readonly modelVisibleText: string;
}

export interface DispatcherOptions {
  readonly registry: ToolRegistry;
  readonly approvals: ApprovalGate;
  readonly redactor?: Redactor;
  readonly logger?: Logger;
  readonly defaultTimeoutMs?: number;
  readonly onCall?: (
    record: Pick<ToolCallRecord, 'callId' | 'tool' | 'risk' | 'argsPreview'>,
  ) => void;
  readonly onComplete?: (record: ToolCallRecord) => void;
}

export class ToolDispatcher {
  private readonly registry: ToolRegistry;
  private readonly approvals: ApprovalGate;
  private readonly redactor: Redactor | undefined;
  private readonly logger: Logger;
  private readonly defaultTimeoutMs: number;
  private readonly onCall: DispatcherOptions['onCall'];
  private readonly onComplete: DispatcherOptions['onComplete'];
  private readonly history: ToolCallRecord[] = [];

  constructor(options: DispatcherOptions) {
    this.registry = options.registry;
    this.approvals = options.approvals;
    this.redactor = options.redactor;
    this.logger = (options.logger ?? silentLogger).child('tools');
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? Limits.defaultToolTimeoutMs;
    this.onCall = options.onCall;
    this.onComplete = options.onComplete;
  }

  get calls(): readonly ToolCallRecord[] {
    return this.history;
  }

  async dispatch(request: ToolCallRequest, context: ToolContext): Promise<ToolCallOutcome> {
    const startedAt = Date.now();
    const callId = newId('call');

    const tool = this.registry.get(request.name);
    if (!tool) {
      return this.fail({
        callId,
        request,
        startedAt,
        risk: 'READ_ONLY',
        subject: request.name,
        argsPreview: this.preview(request.arguments),
        error: errors.notFound(
          `There is no tool named "${request.name}". Available tools: ${this.registry.names().join(', ')}.`,
          { requested: request.name },
        ),
      });
    }

    const subject = this.describe(tool, request.arguments);
    const argsPreview = this.preview(request.arguments);

    // 2. Validate before anything can happen.
    const parsed = tool.inputSchema.safeParse(request.arguments);
    if (!parsed.success) {
      return this.fail({
        callId,
        request,
        startedAt,
        risk: tool.risk,
        subject,
        argsPreview,
        error: errors.invalidInput(
          `Arguments for "${tool.name}" are invalid: ${formatZodIssues(parsed.error)}`,
          { tool: tool.name },
        ),
      });
    }
    const input: unknown = parsed.data;
    const validatedSubject = this.describe(tool, input);

    this.onCall?.({ callId, tool: tool.name, risk: tool.risk, argsPreview });

    // 3. Policy and approval.
    const authorized = await this.approvals.authorize({
      kind: tool.actionKind,
      risk: tool.risk,
      subject: validatedSubject,
      detail: argsPreview,
      ...(context.environment ? { environment: context.environment } : {}),
      ...(tool.alwaysConfirm ? { requiresApproval: true } : {}),
    });

    if (!authorized.ok) {
      return this.fail({
        callId,
        request,
        startedAt,
        risk: tool.risk,
        subject: validatedSubject,
        argsPreview,
        error: authorized.error,
      });
    }

    // 4. Execute under a timeout, catching everything.
    const outcome = await this.execute(tool, input, context);

    const durationMs = Date.now() - startedAt;

    if (!outcome.ok) {
      return this.fail({
        callId,
        request,
        startedAt,
        risk: tool.risk,
        subject: validatedSubject,
        argsPreview,
        error: outcome.error,
      });
    }

    // 5. Redact the result before it reaches the model, the UI, or the log.
    const value = this.redactor ? this.redactor.value(outcome.value) : outcome.value;
    const resultPreview = this.preview(value);

    const record: ToolCallRecord = {
      callId,
      providerCallId: request.id,
      tool: tool.name,
      risk: tool.risk,
      subject: validatedSubject,
      argsPreview,
      startedAt,
      durationMs,
      ok: true,
      resultPreview,
    };

    this.history.push(record);
    this.onComplete?.(record);
    this.logger.debug('tool succeeded', { tool: tool.name, durationMs });

    return {
      record,
      value,
      modelVisibleText: stringifyForModel(value),
    };
  }

  private async execute(
    tool: AnyToolDefinition,
    input: unknown,
    context: ToolContext,
  ): Promise<Result<unknown>> {
    const timeoutMs = tool.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();

    const onOuterAbort = (): void => controller.abort();
    if (context.signal.aborted) return err(errors.aborted(`"${tool.name}" aborted before start`));
    context.signal.addEventListener('abort', onOuterAbort, { once: true });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const scoped: ToolContext = { ...context, signal: controller.signal };
      // A handler may return a Result synchronously or asynchronously; both are
      // awaited uniformly so a synchronous throw is caught here too.
      const result = await Promise.resolve(tool.handler(input, scoped));
      if (timedOut) {
        return err(
          errors.timeout(`"${tool.name}" exceeded its ${timeoutMs}ms budget`, {
            tool: tool.name,
            timeoutMs,
          }),
        );
      }
      return result;
    } catch (error) {
      if (timedOut) {
        return err(
          errors.timeout(`"${tool.name}" exceeded its ${timeoutMs}ms budget`, {
            tool: tool.name,
            timeoutMs,
          }),
        );
      }
      if (context.signal.aborted) return err(errors.aborted(`"${tool.name}" was cancelled`));
      // A handler that throws is a defect in that handler, not a reason to end
      // the run; it is converted and reported like any other tool failure.
      return err(AgentErrorClass.from(error, ErrorCode.TOOL_FAILURE));
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', onOuterAbort);
    }
  }

  private fail(input: {
    callId: Id<'call'>;
    request: ToolCallRequest;
    startedAt: number;
    risk: RiskLevel;
    subject: string;
    argsPreview: string;
    error: AgentError;
  }): ToolCallOutcome {
    const record: ToolCallRecord = {
      callId: input.callId,
      providerCallId: input.request.id,
      tool: input.request.name,
      risk: input.risk,
      subject: input.subject,
      argsPreview: input.argsPreview,
      startedAt: input.startedAt,
      durationMs: Date.now() - input.startedAt,
      ok: false,
      resultPreview: input.error.message,
      error: input.error,
    };

    this.history.push(record);
    this.onComplete?.(record);
    this.logger.warn('tool failed', {
      tool: input.request.name,
      code: input.error.code,
      message: input.error.message,
    });

    return {
      record,
      modelVisibleText: formatErrorForModel(input.error),
    };
  }

  private describe(tool: AnyToolDefinition, input: unknown): string {
    if (!tool.describeCall) return tool.name;
    try {
      return tool.describeCall(input);
    } catch {
      // A describeCall that throws on unvalidated input must not break dispatch.
      return tool.name;
    }
  }

  private preview(value: unknown): string {
    const redacted = this.redactor ? this.redactor.value(value) : value;
    return previewJson(redacted);
  }
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${where}: ${issue.message}`;
    })
    .join('; ');
}

/**
 * Render a failure for the model.
 *
 * Phrased as a correction rather than a stack trace, because the next thing
 * the model does with this text is decide whether to retry, adjust arguments,
 * or stop. Whether a retry can help is stated explicitly.
 */
function formatErrorForModel(error: AgentError): string {
  const lines = [`Error (${error.code}): ${error.message}`];

  if (error.code === ErrorCode.APPROVAL_DENIED) {
    lines.push(
      'The user declined this action. Do not retry it; choose a different approach or ask what they would prefer.',
    );
  } else if (error.code === ErrorCode.PERMISSION_DENIED) {
    lines.push('This is forbidden by project policy. Retrying will fail identically.');
  } else if (error.code === ErrorCode.PRECONDITION_FAILED) {
    lines.push('Re-read the file and rebuild the edit from its current contents.');
  } else if (error.retryable) {
    lines.push('This failure may be transient; one retry is reasonable.');
  }

  const detailKeys = Object.keys(error.details);
  if (detailKeys.length > 0) {
    lines.push(`Details: ${previewJson(error.details, 600)}`);
  }

  return lines.join('\n');
}

function stringifyForModel(value: unknown): string {
  if (value === undefined || value === null) return 'Done.';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
