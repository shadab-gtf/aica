import type { Id, Logger, Result, RunEmitter, TargetEnvironment } from '@aica/shared';
import { Limits, err, errors, ok, silentLogger } from '@aica/shared';
import type { ToolDispatcher, ToolRegistry, ToolSpec } from '@aica/tool-registry';

import type { AIProvider, AssistantToolCall, Message, Usage } from './provider.js';

/**
 * The agent runtime.
 *
 * A bounded loop: send the conversation to the provider, execute whatever tools
 * it asks for, feed the results back, repeat until the model stops asking for
 * tools or a limit is reached.
 *
 * What this loop deliberately does not do:
 *
 * - It does not assemble context by reading the repository. Context arrives
 *   through tool calls the model makes, which is what keeps a large repository
 *   from being dumped into a prompt (specification sections 51 and 63).
 * - It does not trust the model to stop. Iteration and consecutive-failure
 *   caps end a run that is looping.
 * - It does not surface private reasoning. Only prose and tool activity are
 *   emitted (specification section 59).
 */

export interface RunOptions {
  readonly runId: Id<'run'>;
  readonly projectId: Id<'proj'>;
  readonly systemPrompt: string;
  readonly task: string;
  readonly emitter: RunEmitter;
  readonly signal?: AbortSignal;
  readonly environment?: TargetEnvironment;
  /** Restrict the tools advertised for this run. */
  readonly toolFilter?: { categories?: readonly string[]; names?: readonly string[] };
  readonly maxIterations?: number;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  /** Conversation to continue, for a follow-up turn in the same session. */
  readonly history?: readonly Message[];
}

export interface RunOutcome {
  readonly runId: Id<'run'>;
  /** Final assistant prose. */
  readonly summary: string;
  readonly iterations: number;
  readonly toolCalls: number;
  readonly usage: Usage;
  readonly durationMs: number;
  /** Full conversation, so a follow-up turn can continue it. */
  readonly messages: readonly Message[];
  readonly stoppedBecause: 'completed' | 'max_iterations' | 'aborted' | 'repeated_failures';
}

export interface AgentRuntimeOptions {
  readonly provider: AIProvider;
  readonly registry: ToolRegistry;
  readonly dispatcher: ToolDispatcher;
  readonly logger?: Logger;
  /** Consecutive failing iterations tolerated before the run stops. */
  readonly maxConsecutiveFailures?: number;
}

export class AgentRuntime {
  private readonly provider: AIProvider;
  private readonly registry: ToolRegistry;
  private readonly dispatcher: ToolDispatcher;
  private readonly logger: Logger;
  private readonly maxConsecutiveFailures: number;

  constructor(options: AgentRuntimeOptions) {
    this.provider = options.provider;
    this.registry = options.registry;
    this.dispatcher = options.dispatcher;
    this.logger = (options.logger ?? silentLogger).child('runtime');
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 3;
  }

  async run(options: RunOptions): Promise<Result<RunOutcome>> {
    const startedAt = Date.now();
    const maxIterations = options.maxIterations ?? Limits.maxAgentIterations;
    const emitter = options.emitter;

    const messages: Message[] = [
      { role: 'system', content: options.systemPrompt },
      ...(options.history ?? []),
      { role: 'user', content: options.task },
    ];

    const tools: readonly ToolSpec[] = this.registry.specs(
      options.toolFilter as { categories?: never; names?: readonly string[] } | undefined,
    );

    emitter.emit('AGENT_STARTED', {
      task: options.task,
      model: this.provider.model,
      provider: this.provider.id,
      mode: 'agent',
    });

    let usage: Usage = {};
    let toolCallCount = 0;
    let consecutiveFailures = 0;
    let summary = '';
    let iterations = 0;

    for (iterations = 1; iterations <= maxIterations; iterations += 1) {
      if (options.signal?.aborted) {
        return this.finish(options, {
          summary: summary || 'Cancelled before completion.',
          iterations: iterations - 1,
          toolCalls: toolCallCount,
          usage,
          startedAt,
          messages,
          stoppedBecause: 'aborted',
        });
      }

      const turn = await this.provider.chat({
        // A snapshot, not the live array. The loop appends to `messages` as
        // soon as the turn returns, and an adapter that reads the request
        // lazily or retains it would otherwise observe a conversation that has
        // changed underneath it.
        messages: [...messages],
        tools,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.maxOutputTokens !== undefined
          ? { maxOutputTokens: options.maxOutputTokens }
          : {}),
      });

      if (!turn.ok) {
        // A provider failure ends the run: unlike a tool failure, there is no
        // one left to correct it.
        emitter.emit('AGENT_FAILED', {
          error: turn.error.toJSON(),
          recoverable: turn.error.retryable,
        });
        return err(turn.error);
      }

      usage = mergeUsage(usage, turn.value.usage);
      if (turn.value.usage.inputTokens !== undefined || turn.value.usage.costUsd !== undefined) {
        emitter.emit('USAGE_RECORDED', {
          provider: this.provider.id,
          model: this.provider.model,
          ...turn.value.usage,
        });
      }

      const assistant = turn.value.message;
      messages.push(assistant);

      const calls = assistant.toolCalls ?? [];

      if (assistant.content.trim().length > 0) {
        summary = assistant.content.trim();
        emitter.emit('ASSISTANT_MESSAGE', {
          text: summary,
          final: calls.length === 0,
        });
      }

      if (calls.length === 0) {
        return this.finish(options, {
          summary: summary || 'Finished with no output.',
          iterations,
          toolCalls: toolCallCount,
          usage,
          startedAt,
          messages,
          stoppedBecause: 'completed',
        });
      }

      let iterationHadSuccess = false;

      for (const call of calls) {
        if (options.signal?.aborted) break;

        const parsedArguments = parseArguments(call);
        toolCallCount += 1;

        if (!parsedArguments.ok) {
          // Malformed JSON from the model is corrected by telling it so, not by
          // guessing what it meant.
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: parsedArguments.message,
            isError: true,
          });
          continue;
        }

        emitter.emit('TOOL_CALLED', {
          callId: `call_${call.id}` as Id<'call'>,
          tool: call.name,
          risk: this.registry.get(call.name)?.risk ?? 'READ_ONLY',
          argsPreview: truncateArguments(call.argumentsJson),
        });

        const outcome = await this.dispatcher.dispatch(
          { id: call.id, name: call.name, arguments: parsedArguments.value },
          {
            runId: options.runId,
            projectId: options.projectId,
            signal: options.signal ?? new AbortController().signal,
            ...(options.environment ? { environment: options.environment } : {}),
          },
        );

        emitter.emit('TOOL_COMPLETED', {
          callId: outcome.record.callId,
          tool: outcome.record.tool,
          ok: outcome.record.ok,
          durationMs: outcome.record.durationMs,
          resultPreview: outcome.record.resultPreview,
          ...(outcome.record.error ? { error: outcome.record.error.toJSON() } : {}),
        });

        if (outcome.record.ok) iterationHadSuccess = true;

        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: outcome.modelVisibleText,
          ...(outcome.record.ok ? {} : { isError: true }),
        });
      }

      consecutiveFailures = iterationHadSuccess ? 0 : consecutiveFailures + 1;

      if (consecutiveFailures >= this.maxConsecutiveFailures) {
        // Every tool call has failed for several iterations running. Continuing
        // would burn tokens without progress, and the honest outcome is to stop
        // and report why (specification section 39).
        this.logger.warn('stopping after repeated tool failures', {
          runId: options.runId,
          consecutiveFailures,
        });
        return this.finish(options, {
          summary:
            summary ||
            `Stopped after ${consecutiveFailures} consecutive iterations in which every tool call failed. The most recent failure was: ${lastFailure(this.dispatcher)}`,
          iterations,
          toolCalls: toolCallCount,
          usage,
          startedAt,
          messages,
          stoppedBecause: 'repeated_failures',
        });
      }
    }

    return this.finish(options, {
      summary:
        summary ||
        `Reached the ${maxIterations}-iteration limit without completing. The task may need to be broken into smaller steps.`,
      iterations: maxIterations,
      toolCalls: toolCallCount,
      usage,
      startedAt,
      messages,
      stoppedBecause: 'max_iterations',
    });
  }

  private finish(
    options: RunOptions,
    input: Omit<RunOutcome, 'runId' | 'durationMs'> & { startedAt: number },
  ): Result<RunOutcome> {
    const durationMs = Date.now() - input.startedAt;
    const outcome: RunOutcome = {
      runId: options.runId,
      summary: input.summary,
      iterations: input.iterations,
      toolCalls: input.toolCalls,
      usage: input.usage,
      durationMs,
      messages: input.messages,
      stoppedBecause: input.stoppedBecause,
    };

    options.emitter.emit('AGENT_COMPLETED', {
      summary: outcome.summary,
      // Populated by the orchestrator, which owns patch accounting.
      filesChanged: 0,
      validationPassed: false,
      durationMs,
      toolCalls: outcome.toolCalls,
    });

    if (input.stoppedBecause === 'aborted') {
      return err(errors.aborted('The run was cancelled.', { runId: options.runId }));
    }

    return ok(outcome);
  }
}

function parseArguments(
  call: AssistantToolCall,
): { ok: true; value: unknown } | { ok: false; message: string } {
  const text = call.argumentsJson.trim();
  if (text.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return {
      ok: false,
      message: `Error (INVALID_INPUT): the arguments for "${call.name}" were not valid JSON (${
        error instanceof Error ? error.message : 'parse failed'
      }). Send the arguments again as a single well-formed JSON object.`,
    };
  }
}

function truncateArguments(json: string): string {
  return json.length > Limits.eventPreviewChars
    ? `${json.slice(0, Limits.eventPreviewChars)}...`
    : json;
}

function mergeUsage(current: Usage, incoming: Usage): Usage {
  return {
    inputTokens: (current.inputTokens ?? 0) + (incoming.inputTokens ?? 0),
    outputTokens: (current.outputTokens ?? 0) + (incoming.outputTokens ?? 0),
    costUsd: (current.costUsd ?? 0) + (incoming.costUsd ?? 0),
  };
}

function lastFailure(dispatcher: ToolDispatcher): string {
  const failed = [...dispatcher.calls].reverse().find((record) => !record.ok);
  return failed?.error?.message ?? 'unknown';
}
