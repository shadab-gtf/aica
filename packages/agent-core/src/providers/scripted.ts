import type { Result } from '@aica/shared';

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
 * A deterministic provider that replays a fixed script.
 *
 * This exists so the entire agent loop — tool dispatch, validation failure, the
 * repair cycle, iteration limits, abort handling — is testable in CI with no
 * network, no API key, and no variance between runs. Without it, the only way
 * to exercise the loop would be against a real model, which would make the
 * golden scenarios (specification section 69) neither deterministic nor free.
 *
 * It is also useful for reproducing a reported failure: capture the turns a
 * real provider produced, replay them, and debug the deterministic half.
 */

export interface ScriptedTurn {
  /** Assistant prose for this turn. */
  readonly text?: string;
  /** Tool calls the model should request. */
  readonly toolCalls?: readonly Omit<AssistantToolCall, 'id'>[];
  readonly stopReason?: StopReason;
  /** Simulate a provider failure on this turn. */
  readonly error?: { readonly message: string; readonly retryable?: boolean };
  /** Simulate a stream that dies mid-turn, with no terminal event. */
  readonly truncate?: boolean;
}

export interface ScriptedProviderOptions {
  readonly turns: readonly ScriptedTurn[];
  readonly model?: string;
  /**
   * What to do once the script is exhausted. "end" keeps returning an empty
   * final turn, which is the safe default; "throw" surfaces a test defect where
   * the loop ran longer than the script anticipated.
   */
  readonly onExhausted?: 'end' | 'throw';
}

export class ScriptedProvider implements AIProvider {
  readonly id = 'scripted';
  readonly model: string;

  private readonly turns: readonly ScriptedTurn[];
  private readonly onExhausted: 'end' | 'throw';
  private cursor = 0;
  /** Every request received, so tests can assert on what the loop sent. */
  readonly requests: ChatRequest[] = [];

  constructor(options: ScriptedProviderOptions) {
    this.turns = options.turns;
    this.model = options.model ?? 'scripted/deterministic';
    this.onExhausted = options.onExhausted ?? 'end';
  }

  get turnsConsumed(): number {
    return this.cursor;
  }

  /** Messages the loop sent on its most recent call. */
  get lastMessages(): readonly Message[] {
    return this.requests[this.requests.length - 1]?.messages ?? [];
  }

  reset(): void {
    this.cursor = 0;
    this.requests.length = 0;
  }

  chat(request: ChatRequest): Promise<Result<ChatTurn>> {
    return collectStream(this.stream(request), request);
  }

  async *stream(request: ChatRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(request);

    if (request.signal?.aborted) {
      yield { type: 'error', message: 'The request was cancelled.', retryable: false };
      return;
    }

    const turn = this.turns[this.cursor];
    this.cursor += 1;

    if (!turn) {
      if (this.onExhausted === 'throw') {
        throw new Error(
          `ScriptedProvider ran out of turns after ${this.turns.length}. The agent loop iterated more than the script expected.`,
        );
      }
      yield { type: 'done', stopReason: 'end_turn' };
      return;
    }

    if (turn.error) {
      yield {
        type: 'error',
        message: turn.error.message,
        retryable: turn.error.retryable ?? false,
      };
      return;
    }

    if (turn.text) {
      // Chunked, so consumers that assemble deltas are exercised rather than
      // receiving one convenient whole string.
      for (const piece of chunk(turn.text, 16)) {
        yield { type: 'text-delta', text: piece };
      }
    }

    for (const [index, call] of (turn.toolCalls ?? []).entries()) {
      yield {
        type: 'tool-call',
        call: { id: `scripted_${this.cursor}_${index}`, ...call },
      };
    }

    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 50, costUsd: 0 } };

    if (turn.truncate) return;

    yield {
      type: 'done',
      stopReason: turn.stopReason ?? ((turn.toolCalls?.length ?? 0) > 0 ? 'tool_use' : 'end_turn'),
    };
  }
}

function chunk(text: string, size: number): string[] {
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += size) pieces.push(text.slice(i, i + size));
  return pieces;
}
