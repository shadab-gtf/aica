import type { Result } from '@aica/shared';
import type { ToolSpec } from '@aica/tool-registry';

/**
 * The AI provider abstraction (specification section 53).
 *
 * Everything vendor-specific lives inside an adapter. The rest of the system
 * knows only these types, so swapping OpenRouter for a direct Anthropic,
 * OpenAI, or Gemini adapter changes one file and nothing else.
 *
 * The abstraction is deliberately narrow: multi-turn conversation with tool
 * calling, streamed. It does not expose embeddings, fine-tuning, or
 * vendor-specific features, because the system does not depend on them and a
 * wider interface would be harder to implement for a new provider.
 */

export interface SystemMessage {
  readonly role: 'system';
  readonly content: string;
}

export interface UserMessage {
  readonly role: 'user';
  readonly content: string;
}

export interface AssistantToolCall {
  readonly id: string;
  readonly name: string;
  /** Raw JSON text as produced by the model, parsed by the dispatcher. */
  readonly argumentsJson: string;
}

export interface AssistantMessage {
  readonly role: 'assistant';
  readonly content: string;
  readonly toolCalls?: readonly AssistantToolCall[];
}

export interface ToolResultMessage {
  readonly role: 'tool';
  readonly toolCallId: string;
  readonly name: string;
  readonly content: string;
  readonly isError?: boolean;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

export interface Usage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'refusal';

export interface ChatRequest {
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolSpec[];
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly signal?: AbortSignal;
  /** Overrides the provider's configured model for one call. */
  readonly model?: string;
}

/**
 * Streamed provider output.
 *
 * `text-delta` carries user-facing prose only. Private reasoning is not
 * surfaced (specification section 59); an adapter for a model that emits
 * reasoning tokens must discard them rather than forward them.
 */
export type ProviderEvent =
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'tool-call'; readonly call: AssistantToolCall }
  | { readonly type: 'usage'; readonly usage: Usage }
  | { readonly type: 'done'; readonly stopReason: StopReason }
  | { readonly type: 'error'; readonly message: string; readonly retryable: boolean };

export interface ChatTurn {
  readonly message: AssistantMessage;
  readonly stopReason: StopReason;
  readonly usage: Usage;
}

export interface AIProvider {
  /** Stable identifier, e.g. "openrouter". */
  readonly id: string;
  /** Model in use, for the run record. */
  readonly model: string;
  /**
   * Stream one assistant turn. Implementations must not throw: transport and
   * protocol failures are yielded as an `error` event.
   */
  stream(request: ChatRequest): AsyncIterable<ProviderEvent>;
  /** Convenience wrapper that collects a stream into one turn. */
  chat(request: ChatRequest): Promise<Result<ChatTurn>>;
}
