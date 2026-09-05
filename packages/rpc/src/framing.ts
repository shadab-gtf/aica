/**
 * Message framing for the stdio transport.
 *
 * The extension host talks to the agent server over a pipe, and a pipe delivers
 * bytes, not messages. Three properties are needed and only length-prefixing
 * gives all three:
 *
 * - **A message body may contain anything.** File contents, diffs and error
 *   text all travel through here, so a newline-delimited protocol would need
 *   escaping — and any escaping bug becomes a desynchronised stream that never
 *   recovers.
 * - **A partial read must never look like a whole message.** The length is
 *   known before the body is, so a short read is unambiguously incomplete.
 * - **The length is in bytes.** Not characters. A single emoji in a file path
 *   is three bytes and one JavaScript string unit; counting the wrong one
 *   truncates every message after it.
 *
 * This is the Language Server Protocol's framing, chosen because every editor
 * integration already speaks it and its edge cases are well understood.
 */

import type { Result } from '@aica/shared';
import { AgentError, ErrorCode, err, ok } from '@aica/shared';

const HEADER_TERMINATOR = '\r\n\r\n';
const CONTENT_LENGTH = 'content-length';

/**
 * Refuse absurd frames rather than allocating for them. A corrupt or hostile
 * length header must not be able to reserve gigabytes, and a header block that
 * never terminates must not grow without bound.
 */
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const MAX_HEADER_BYTES = 8 * 1024;

/** Encode one message with its header block. */
export function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.byteLength}${HEADER_TERMINATOR}`, 'ascii');
  return Buffer.concat([header, body]);
}

/**
 * The outcome of feeding bytes to the decoder.
 *
 * `malformed` is separate from a failed `Result` on purpose. A frame whose body
 * is not JSON is one lost message: its length was known, so the boundary is
 * known and the stream is still synchronised. A bad *header* is different — the
 * two ends no longer agree where messages begin, nothing after it can be
 * trusted, and that is the only thing reported as an error.
 */
export interface DecodedBatch {
  readonly messages: readonly unknown[];
  readonly malformed: readonly AgentError[];
}

/**
 * Incremental decoder.
 *
 * Fed arbitrary chunks, it yields whole messages. It holds exactly one buffer
 * of pending bytes and never re-parses a header it has already parsed, so a
 * body arriving in a thousand small chunks costs one scan, not a thousand.
 */
export class MessageDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  /** Body length of the frame being awaited, once its header has been read. */
  private expected: number | undefined;
  /** Offset in `buffer` where that body starts. */
  private bodyStart = 0;

  /**
   * Append bytes and return every message that is now complete.
   *
   * Returns `Err` when the stream can no longer be trusted — a malformed header
   * or an impossible length. There is no recovery from that: the sender and
   * receiver disagree about where messages begin, so the caller must close the
   * connection rather than try to resynchronise.
   */
  push(chunk: Buffer): Result<DecodedBatch> {
    this.buffer = this.buffer.byteLength === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    const messages: unknown[] = [];
    const malformed: AgentError[] = [];

    for (;;) {
      if (this.expected === undefined) {
        const parsed = this.readHeader();
        if (!parsed.ok) return parsed;
        if (!parsed.value) break;
      }

      const end = this.bodyStart + (this.expected as number);
      if (this.buffer.byteLength < end) break;

      const body = this.buffer.subarray(this.bodyStart, end);
      this.buffer = this.buffer.subarray(end);
      this.expected = undefined;
      this.bodyStart = 0;

      try {
        messages.push(JSON.parse(body.toString('utf8')) as unknown);
      } catch (error) {
        malformed.push(
          new AgentError(ErrorCode.MALFORMED_RESPONSE, 'Received a frame that is not valid JSON.', {
            details: { bytes: body.byteLength, reason: (error as Error).message },
          }),
        );
      }
    }

    return ok({ messages, malformed });
  }

  /** True once a header has been read but its body has not fully arrived. */
  get awaitingBody(): boolean {
    return this.expected !== undefined;
  }

  get pendingBytes(): number {
    return this.buffer.byteLength;
  }

  /**
   * Read a header block if one is complete.
   *
   * `ok(false)` means "not yet, ask again with more bytes"; `ok(true)` means
   * `expected` and `bodyStart` are now set.
   */
  private readHeader(): Result<boolean> {
    const terminator = this.buffer.indexOf(HEADER_TERMINATOR, 0, 'ascii');

    if (terminator === -1) {
      if (this.buffer.byteLength > MAX_HEADER_BYTES) {
        return err(
          new AgentError(
            ErrorCode.MALFORMED_RESPONSE,
            'Header block exceeded the maximum size without terminating.',
            { details: { bytes: this.buffer.byteLength, limit: MAX_HEADER_BYTES } },
          ),
        );
      }
      return ok(false);
    }

    const headerText = this.buffer.subarray(0, terminator).toString('ascii');
    let length: number | undefined;

    for (const line of headerText.split('\r\n')) {
      if (line.length === 0) continue;
      const separator = line.indexOf(':');
      if (separator === -1) {
        return err(
          new AgentError(ErrorCode.MALFORMED_RESPONSE, 'Header line has no name/value separator.', {
            details: { line: line.slice(0, 80) },
          }),
        );
      }
      if (line.slice(0, separator).trim().toLowerCase() !== CONTENT_LENGTH) continue;

      // Deliberately strict. `parseInt` would accept "12abc" and "0x10", and a
      // length that is nearly right is worse than one that is obviously wrong.
      const raw = line.slice(separator + 1).trim();
      if (!/^\d+$/.test(raw)) {
        return err(
          new AgentError(ErrorCode.MALFORMED_RESPONSE, 'Content-Length is not a decimal number.', {
            details: { value: raw.slice(0, 40) },
          }),
        );
      }
      length = Number(raw);
    }

    if (length === undefined) {
      return err(
        new AgentError(ErrorCode.MALFORMED_RESPONSE, 'Frame header has no Content-Length.', {
          details: { header: headerText.slice(0, 200) },
        }),
      );
    }

    if (length > MAX_MESSAGE_BYTES) {
      return err(
        new AgentError(ErrorCode.LIMIT_EXCEEDED, 'Frame is larger than the maximum message size.', {
          details: { bytes: length, limit: MAX_MESSAGE_BYTES },
        }),
      );
    }

    this.expected = length;
    this.bodyStart = terminator + HEADER_TERMINATOR.length;
    return ok(true);
  }
}
