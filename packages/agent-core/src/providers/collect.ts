import type { Result } from '@aica/shared';
import { AgentError, ErrorCode, err, errors, ok } from '@aica/shared';

import type {
  AssistantToolCall,
  ChatRequest,
  ChatTurn,
  ProviderEvent,
  StopReason,
  Usage,
} from '../provider.js';

/**
 * Collect a provider stream into a single turn.
 *
 * Shared by every adapter so that `chat()` behaves identically regardless of
 * provider, and so an `error` event becomes a structured Result rather than an
 * exception.
 */
export async function collectStream(
  stream: AsyncIterable<ProviderEvent>,
  _request: ChatRequest,
): Promise<Result<ChatTurn>> {
  let content = '';
  const toolCalls: AssistantToolCall[] = [];
  let usage: Usage = {};
  let stopReason: StopReason | undefined;

  for await (const event of stream) {
    switch (event.type) {
      case 'text-delta':
        content += event.text;
        break;
      case 'tool-call':
        toolCalls.push(event.call);
        break;
      case 'usage':
        usage = { ...usage, ...event.usage };
        break;
      case 'done':
        stopReason = event.stopReason;
        break;
      case 'error':
        // The adapter knows whether this failure is worth retrying (a 429 is, a
        // rejected credential is not), so its judgement sets the flag rather
        // than the default derived from the error code.
        return err(
          new AgentError(ErrorCode.MODEL_FAILURE, event.message, {
            retryable: event.retryable,
          }),
        );
      default:
        break;
    }
  }

  if (stopReason === undefined) {
    // A stream that ends without a terminal event means the connection dropped
    // mid-turn; treating it as a complete turn would silently truncate output.
    return err(
      errors.modelFailure('The provider stream ended without completing the turn.', {
        retryable: true,
      }),
    );
  }

  return ok({
    message: {
      role: 'assistant',
      content,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    },
    stopReason,
    usage,
  });
}
