import type { Logger, Result } from '@aica/shared';
import { Limits, silentLogger } from '@aica/shared';

import type {
  AIProvider,
  AssistantToolCall,
  ChatRequest,
  ChatTurn,
  Message,
  ProviderEvent,
  StopReason,
} from '../provider.js';
import { collectStream } from './collect.js';

/**
 * OpenRouter adapter, the first concrete provider.
 *
 * OpenRouter exposes an OpenAI-compatible `/chat/completions` endpoint with
 * streaming and tool calling, which makes it a single integration point for
 * many models. Everything specific to that wire format is confined to this
 * file.
 *
 * The API key is supplied as a resolved value by the caller, which obtained it
 * from a secret reference. This adapter never reads the environment itself, so
 * there is one place where credentials enter the process.
 */

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

export interface OpenRouterOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly logger?: Logger;
  /** Attribution headers OpenRouter uses for ranking; optional. */
  readonly referer?: string;
  readonly appTitle?: string;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

interface WireToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface WireChoiceDelta {
  role?: string;
  content?: string | null;
  tool_calls?: WireToolCallDelta[];
}

interface WireChunk {
  choices?: Array<{ delta?: WireChoiceDelta; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_cost?: number };
  error?: { message?: string; code?: number | string };
}

export class OpenRouterProvider implements AIProvider {
  readonly id = 'openrouter';
  readonly model: string;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly referer: string | undefined;
  private readonly appTitle: string | undefined;

  constructor(options: OpenRouterOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? Limits.defaultHttpTimeoutMs * 4;
    this.logger = (options.logger ?? silentLogger).child('openrouter');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.referer = options.referer;
    this.appTitle = options.appTitle;
  }

  chat(request: ChatRequest): Promise<Result<ChatTurn>> {
    return collectStream(this.stream(request), request);
  }

  async *stream(request: ChatRequest): AsyncIterable<ProviderEvent> {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    request.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          ...(this.referer ? { 'http-referer': this.referer } : {}),
          ...(this.appTitle ? { 'x-title': this.appTitle } : {}),
        },
        body: JSON.stringify({
          model: request.model ?? this.model,
          messages: request.messages.map(toWireMessage),
          ...(request.tools?.length
            ? {
                tools: request.tools.map((tool) => ({
                  type: 'function',
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                  },
                })),
              }
            : {}),
          stream: true,
          temperature: request.temperature ?? 0,
          max_tokens: request.maxOutputTokens ?? 8_192,
          usage: { include: true },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        yield {
          type: 'error',
          message: await describeHttpFailure(response),
          // 429 and 5xx are worth retrying; 4xx generally is not.
          retryable: response.status === 429 || response.status >= 500,
        };
        return;
      }

      if (!response.body) {
        yield {
          type: 'error',
          message: 'The provider returned no response body.',
          retryable: true,
        };
        return;
      }

      yield* this.readSse(response.body);
    } catch (error) {
      if (controller.signal.aborted && request.signal?.aborted) {
        yield { type: 'error', message: 'The request was cancelled.', retryable: false };
        return;
      }
      if (controller.signal.aborted) {
        yield {
          type: 'error',
          message: `The provider did not respond within ${this.timeoutMs}ms.`,
          retryable: true,
        };
        return;
      }
      yield {
        type: 'error',
        message: `Could not reach the provider: ${error instanceof Error ? error.message : String(error)}`,
        retryable: true,
      };
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Parse a server-sent-events stream.
   *
   * Tool calls arrive as deltas keyed by index, with the name in the first
   * delta and the argument JSON accumulating across later ones, so partial
   * calls are buffered and only emitted once the turn finishes.
   */
  private async *readSse(body: ReadableStream<Uint8Array>): AsyncIterable<ProviderEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const partialCalls = new Map<number, { id: string; name: string; args: string }>();
    let stopReason: StopReason = 'end_turn';
    let sawFinish = false;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by a blank line.
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');

          for (const line of rawEvent.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data.length === 0) continue;

            if (data === '[DONE]') {
              sawFinish = true;
              continue;
            }

            let chunk: WireChunk;
            try {
              chunk = JSON.parse(data) as WireChunk;
            } catch {
              // A malformed keepalive or comment line is not fatal.
              continue;
            }

            if (chunk.error?.message) {
              yield { type: 'error', message: chunk.error.message, retryable: false };
              return;
            }

            if (chunk.usage) {
              yield {
                type: 'usage',
                usage: {
                  ...(chunk.usage.prompt_tokens !== undefined
                    ? { inputTokens: chunk.usage.prompt_tokens }
                    : {}),
                  ...(chunk.usage.completion_tokens !== undefined
                    ? { outputTokens: chunk.usage.completion_tokens }
                    : {}),
                  ...(chunk.usage.total_cost !== undefined
                    ? { costUsd: chunk.usage.total_cost }
                    : {}),
                },
              };
            }

            const choice = chunk.choices?.[0];
            if (!choice) continue;

            const content = choice.delta?.content;
            if (typeof content === 'string' && content.length > 0) {
              yield { type: 'text-delta', text: content };
            }

            for (const delta of choice.delta?.tool_calls ?? []) {
              const index = delta.index ?? 0;
              const existing = partialCalls.get(index) ?? { id: '', name: '', args: '' };
              partialCalls.set(index, {
                id: delta.id ?? existing.id,
                name: delta.function?.name ?? existing.name,
                args: existing.args + (delta.function?.arguments ?? ''),
              });
            }

            if (choice.finish_reason) {
              sawFinish = true;
              stopReason = mapFinishReason(choice.finish_reason);
            }
          }
        }
      }
    } catch (error) {
      yield {
        type: 'error',
        message: `The provider stream failed: ${error instanceof Error ? error.message : String(error)}`,
        retryable: true,
      };
      return;
    } finally {
      reader.releaseLock();
    }

    for (const [index, partial] of [...partialCalls.entries()].sort((a, b) => a[0] - b[0])) {
      if (partial.name.length === 0) {
        this.logger.warn('discarding a tool call delta with no name', { index });
        continue;
      }
      const call: AssistantToolCall = {
        id: partial.id.length > 0 ? partial.id : `call_${index}`,
        name: partial.name,
        argumentsJson: partial.args.length > 0 ? partial.args : '{}',
      };
      yield { type: 'tool-call', call };
    }

    if (partialCalls.size > 0 && stopReason === 'end_turn') stopReason = 'tool_use';

    if (!sawFinish) {
      yield {
        type: 'error',
        message: 'The provider stream ended without a finish reason.',
        retryable: true,
      };
      return;
    }

    yield { type: 'done', stopReason };
  }
}

function toWireMessage(message: Message): Record<string, unknown> {
  switch (message.role) {
    case 'system':
    case 'user':
      return { role: message.role, content: message.content };
    case 'assistant':
      return {
        role: 'assistant',
        content: message.content.length > 0 ? message.content : null,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: call.argumentsJson },
              })),
            }
          : {}),
      };
    case 'tool':
      return {
        role: 'tool',
        tool_call_id: message.toolCallId,
        name: message.name,
        content: message.content,
      };
    default:
      return { role: 'user', content: '' };
  }
}

function mapFinishReason(reason: string): StopReason {
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    case 'stop':
      return 'end_turn';
    default:
      return 'end_turn';
  }
}

/**
 * Describe an HTTP failure usefully without echoing the response verbatim,
 * since an error body can contain the request, and the request can contain
 * source code.
 */
async function describeHttpFailure(response: Response): Promise<string> {
  let detail = '';
  try {
    const text = await response.text();
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    detail = parsed.error?.message ?? text.slice(0, 300);
  } catch {
    detail = '';
  }

  if (response.status === 401 || response.status === 403) {
    return `The provider rejected the credentials (HTTP ${response.status}). Check that the configured API key reference resolves to a valid key.${detail ? ` Provider said: ${detail}` : ''}`;
  }
  if (response.status === 429) {
    return `The provider rate-limited the request (HTTP 429).${detail ? ` ${detail}` : ''}`;
  }
  if (response.status === 402) {
    return `The provider reports insufficient credit (HTTP 402).${detail ? ` ${detail}` : ''}`;
  }
  return `The provider returned HTTP ${response.status}.${detail ? ` ${detail}` : ''}`;
}
