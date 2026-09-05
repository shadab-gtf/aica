/**
 * Message codecs.
 *
 * Two framings, because two protocols this system speaks disagree about how a
 * JSON-RPC message is delimited on a byte stream:
 *
 * - **Length-prefixed** (`Content-Length`, LSP-style) for the agent server's
 *   own connection to the editor. Chosen there because the length is known
 *   before the body, so a short read is unambiguously incomplete.
 * - **Line-delimited** for Model Context Protocol servers over stdio, which is
 *   what that protocol specifies. It works because MCP forbids an embedded
 *   newline inside a message — a constraint `JSON.stringify` satisfies for
 *   free, since it escapes newlines inside strings.
 *
 * Making the codec injectable rather than writing a second connection class
 * means the request correlation, the cancellation, the timeout handling, and
 * the "settle everything when the pipe dies" guarantee are shared. Those are
 * the parts that are easy to get subtly wrong twice.
 */

import type { Result } from '@aica/shared';
import { AgentError, ErrorCode, err, ok } from '@aica/shared';

import type { DecodedBatch } from './framing.js';
import { MAX_MESSAGE_BYTES, MessageDecoder, encodeMessage } from './framing.js';

/** Turns bytes into messages, incrementally. */
export interface Decoder {
  push(chunk: Buffer): Result<DecodedBatch>;
}

export interface Codec {
  readonly name: string;
  encode(message: unknown): Buffer;
  createDecoder(): Decoder;
}

/** `Content-Length` framing. The agent server's own transport. */
export const lengthPrefixedCodec: Codec = {
  name: 'content-length',
  encode: encodeMessage,
  createDecoder: () => new MessageDecoder(),
};

/**
 * Newline-delimited JSON. The Model Context Protocol's stdio transport.
 *
 * Two things this has to get right, and both are about a peer we do not
 * control:
 *
 * **A line that is not JSON is not fatal.** An MCP server is a third-party
 * program, and plenty of them print a banner, a deprecation warning, or a
 * progress line to stdout before settling down. Unlike a corrupt
 * `Content-Length` header, a stray line here costs nothing: the next newline
 * resynchronises the stream. Those lines are reported and skipped, not treated
 * as a reason to kill the connection.
 *
 * **A line that never ends is fatal.** A peer streaming megabytes with no
 * newline would otherwise be an unbounded buffer, so the same size cap that
 * governs the other codec applies here.
 */
export const lineDelimitedCodec: Codec = {
  name: 'line-delimited',
  encode: (message) => Buffer.from(`${JSON.stringify(message)}\n`, 'utf8'),
  createDecoder: () => new LineDecoder(),
};

class LineDecoder implements Decoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Result<DecodedBatch> {
    this.buffer = this.buffer.byteLength === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    const messages: unknown[] = [];
    const malformed: AgentError[] = [];

    for (;;) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline === -1) break;

      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);

      // Tolerate CRLF: a server on Windows may well produce it.
      const text = line.toString('utf8').replace(/\r$/, '').trim();
      if (text.length === 0) continue;

      try {
        messages.push(JSON.parse(text) as unknown);
      } catch {
        malformed.push(
          new AgentError(
            ErrorCode.MALFORMED_RESPONSE,
            'A line on the stream was not valid JSON. It was ignored.',
            // The text is not carried into the error: an MCP server's stdout is
            // untrusted, and it may have printed something it should not have.
            { details: { bytes: line.byteLength } },
          ),
        );
      }
    }

    if (this.buffer.byteLength > MAX_MESSAGE_BYTES) {
      return err(
        new AgentError(
          ErrorCode.LIMIT_EXCEEDED,
          'A line exceeded the maximum message size without terminating.',
          { details: { bytes: this.buffer.byteLength, limit: MAX_MESSAGE_BYTES } },
        ),
      );
    }

    return ok({ messages, malformed });
  }
}
