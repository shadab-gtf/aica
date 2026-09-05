import { describe, expect, it, vi } from 'vitest';

import { AgentError, ErrorCode, err, ok } from '@aica/shared';

import { RpcConnection } from './connection.js';
import type { Transport } from './connection.js';
import { MessageDecoder, encodeMessage } from './framing.js';
import { RpcErrorCode, isNotification, isRequest, isResponse, toRpcErrorCode } from './protocol.js';
import { createTransportPair } from './transport.js';

function decodeAll(decoder: MessageDecoder, chunk: Buffer): unknown[] {
  const result = decoder.push(chunk);
  if (!result.ok) throw result.error;
  return [...result.value.messages];
}

describe('framing', () => {
  it('round-trips a message', () => {
    const decoder = new MessageDecoder();
    const message = { jsonrpc: '2.0', id: 1, method: 'ping', params: { a: 1 } };

    expect(decodeAll(decoder, encodeMessage(message))).toEqual([message]);
  });

  it('reassembles a message split across chunks', () => {
    const decoder = new MessageDecoder();
    const encoded = encodeMessage({ jsonrpc: '2.0', method: 'note', params: { text: 'hello' } });

    // One byte at a time is the worst case a pipe can produce.
    const seen: unknown[] = [];
    for (const byte of encoded) seen.push(...decodeAll(decoder, Buffer.from([byte])));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'note' });
  });

  it('yields several messages arriving in one chunk', () => {
    const decoder = new MessageDecoder();
    const chunk = Buffer.concat([
      encodeMessage({ jsonrpc: '2.0', id: 1, method: 'a' }),
      encodeMessage({ jsonrpc: '2.0', id: 2, method: 'b' }),
      encodeMessage({ jsonrpc: '2.0', id: 3, method: 'c' }),
    ]);

    expect(decodeAll(decoder, chunk).map((m) => (m as { method: string }).method)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('counts bytes rather than characters', () => {
    // Four characters, ten bytes. A character-counting implementation would
    // truncate here and desynchronise everything after it.
    const decoder = new MessageDecoder();
    const text = 'á日🙂z';
    const encoded = encodeMessage({ jsonrpc: '2.0', method: 'x', params: { text } });

    const header = encoded.subarray(0, encoded.indexOf('\r\n\r\n')).toString('ascii');
    expect(header).toContain(
      `Content-Length: ${Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', method: 'x', params: { text } }), 'utf8')}`,
    );

    const [decoded] = decodeAll(decoder, encoded);
    expect((decoded as { params: { text: string } }).params.text).toBe(text);
  });

  it('reports a header with no Content-Length as unrecoverable', () => {
    const decoder = new MessageDecoder();
    const result = decoder.push(Buffer.from('Content-Type: application/json\r\n\r\n{}', 'utf8'));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.MALFORMED_RESPONSE);
  });

  it('rejects a non-decimal Content-Length rather than guessing', () => {
    const decoder = new MessageDecoder();
    // parseInt would happily read 12 out of this and lose four bytes.
    const result = decoder.push(Buffer.from('Content-Length: 12abc\r\n\r\n', 'utf8'));

    expect(result.ok).toBe(false);
  });

  it('refuses a length beyond the maximum instead of allocating for it', () => {
    const decoder = new MessageDecoder();
    const result = decoder.push(Buffer.from('Content-Length: 999999999999\r\n\r\n', 'utf8'));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.LIMIT_EXCEEDED);
  });

  it('fails a header block that never terminates', () => {
    const decoder = new MessageDecoder();
    const result = decoder.push(Buffer.from('x'.repeat(9000), 'utf8'));

    expect(result.ok).toBe(false);
  });

  it('keeps the stream when one frame body is not JSON', () => {
    const decoder = new MessageDecoder();
    const body = Buffer.from('{not json', 'utf8');
    const chunk = Buffer.concat([
      Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, 'ascii'),
      body,
      encodeMessage({ jsonrpc: '2.0', method: 'after' }),
    ]);

    const result = decoder.push(chunk);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The bad frame is reported, and the message behind it still arrives.
    expect(result.value.malformed).toHaveLength(1);
    expect(result.value.messages).toHaveLength(1);
    expect(result.value.messages[0]).toMatchObject({ method: 'after' });
  });

  it('knows when it is waiting for a body', () => {
    const decoder = new MessageDecoder();
    const encoded = encodeMessage({ jsonrpc: '2.0', method: 'partial' });
    const cut = encoded.indexOf('\r\n\r\n') + 4;

    decodeAll(decoder, encoded.subarray(0, cut));
    expect(decoder.awaitingBody).toBe(true);

    decodeAll(decoder, encoded.subarray(cut));
    expect(decoder.awaitingBody).toBe(false);
    expect(decoder.pendingBytes).toBe(0);
  });
});

describe('message classification', () => {
  it('separates requests, notifications and responses', () => {
    const request = { jsonrpc: '2.0', id: 1, method: 'a' };
    const notification = { jsonrpc: '2.0', method: 'a' };
    const response = { jsonrpc: '2.0', id: 1, result: null };

    expect(isRequest(request)).toBe(true);
    expect(isNotification(request)).toBe(false);
    expect(isResponse(request)).toBe(false);

    expect(isNotification(notification)).toBe(true);
    expect(isRequest(notification)).toBe(false);

    expect(isResponse(response)).toBe(true);
    expect(isRequest(response)).toBe(false);
  });

  it('rejects anything that is not JSON-RPC 2.0', () => {
    expect(isRequest({ id: 1, method: 'a' })).toBe(false);
    expect(isRequest({ jsonrpc: '1.0', id: 1, method: 'a' })).toBe(false);
    expect(isRequest(null)).toBe(false);
    expect(isRequest('a string')).toBe(false);
  });

  it('treats a null result as a response, not a missing one', () => {
    // `result: null` is the correct empty response and must not be mistaken
    // for a message carrying neither result nor error.
    expect(isResponse({ jsonrpc: '2.0', id: 7, result: null })).toBe(true);
  });
});

function connectPair(): { client: RpcConnection; server: RpcConnection } {
  const [a, b] = createTransportPair();
  return {
    client: new RpcConnection({ transport: a, requestTimeoutMs: 2000 }),
    server: new RpcConnection({ transport: b, requestTimeoutMs: 2000 }),
  };
}

describe('RpcConnection', () => {
  it('carries a request to a handler and the result back', async () => {
    const { client, server } = connectPair();
    server.onRequest('sum', async (params) => {
      const { a, b } = params as { a: number; b: number };
      return ok(a + b);
    });

    await expect(client.request('sum', { a: 2, b: 3 })).resolves.toEqual(ok(5));
    client.dispose();
  });

  it('works in both directions over one connection', async () => {
    const { client, server } = connectPair();

    // The reverse direction is the whole reason for JSON-RPC here: the server
    // asks the editor for something only the editor has.
    client.onRequest('client/readSecret', async () => ok({ found: true, value: 'from-editor' }));
    server.onRequest('ping', async () => ok('pong'));

    await expect(server.request('client/readSecret', { name: 'postman' })).resolves.toEqual(
      ok({ found: true, value: 'from-editor' }),
    );
    await expect(client.request('ping')).resolves.toEqual(ok('pong'));
    client.dispose();
  });

  it('returns a handler error as a structured error, preserving the code', async () => {
    const { client, server } = connectPair();
    server.onRequest('fail', async () =>
      err(new AgentError(ErrorCode.NOT_FOUND, 'no such project')),
    );

    const result = await client.request('fail');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.NOT_FOUND);
    expect(result.error.message).toBe('no such project');
    client.dispose();
  });

  it('turns a thrown handler into an error response and stays usable', async () => {
    const { client, server } = connectPair();
    server.onRequest('boom', async () => {
      throw new Error('handler bug');
    });
    server.onRequest('ok', async () => ok('still here'));

    const failed = await client.request('boom');
    expect(failed.ok).toBe(false);

    // The connection survived: one bad handler must not end the session.
    await expect(client.request('ok')).resolves.toEqual(ok('still here'));
    expect(client.isClosed).toBe(false);
    client.dispose();
  });

  it('reports an unknown method rather than hanging', async () => {
    const { client } = connectPair();

    const result = await client.request('nope');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.UNSUPPORTED);
    client.dispose();
  });

  it('settles every pending request when the transport closes', async () => {
    const { client, server } = connectPair();
    server.onRequest('never', () => new Promise(() => undefined));

    const pending = client.request('never');
    client.dispose();

    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.ABORTED);
  });

  it('cancels a request and aborts the handler signal', async () => {
    const { client, server } = connectPair();
    const aborted = vi.fn();

    server.onRequest('slow', async (_params, context) => {
      context.signal.addEventListener('abort', aborted);
      await new Promise((resolve) => setTimeout(resolve, 50));
      // The handler still answers, so the caller never has to guess whether a
      // cancelled request is finished or merely silent.
      return context.signal.aborted
        ? err(new AgentError(ErrorCode.ABORTED, 'cancelled'))
        : ok('done');
    });

    const controller = new AbortController();
    const pending = client.request('slow', {}, controller.signal);
    controller.abort();

    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.ABORTED);

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(aborted).toHaveBeenCalled();
    client.dispose();
  });

  it('times out a request that is never answered', async () => {
    const [a, b] = createTransportPair();
    const client = new RpcConnection({ transport: a, requestTimeoutMs: 30 });
    const server = new RpcConnection({ transport: b, requestTimeoutMs: 30 });
    server.onRequest('silent', () => new Promise(() => undefined));

    const result = await client.request('silent');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.TIMEOUT);
    client.dispose();
  });

  it('delivers notifications and ignores unknown ones', async () => {
    const { client, server } = connectPair();
    const received = vi.fn();
    server.onNotification('agent/event', received);

    client.notify('agent/event', { seq: 1 });
    client.notify('agent/unknown', {});
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(received).toHaveBeenCalledWith({ seq: 1 });
    expect(server.isClosed).toBe(false);
    client.dispose();
  });

  it('survives a notification handler that throws', async () => {
    const { client, server } = connectPair();
    server.onNotification('bad', () => {
      throw new Error('listener bug');
    });

    client.notify('bad', {});
    await new Promise((resolve) => setTimeout(resolve, 10));

    server.onRequest('ok', async () => ok(1));
    await expect(client.request('ok')).resolves.toEqual(ok(1));
    client.dispose();
  });

  it('closes the connection when framing desynchronises', async () => {
    const listeners: ((chunk: Buffer) => void)[] = [];
    const closes: (() => void)[] = [];
    const transport: Transport = {
      send: () => undefined,
      onData: (listener) => listeners.push(listener),
      onClose: (listener) => closes.push(listener),
      close: () => undefined,
    };
    const connection = new RpcConnection({ transport });

    // Garbage on the pipe — the realistic cause is a stray write to stdout.
    for (const listener of listeners) listener(Buffer.from('not a frame at all\r\n\r\n', 'utf8'));

    expect(connection.isClosed).toBe(true);
  });

  it('refuses to send once closed', async () => {
    const { client } = connectPair();
    client.dispose();

    const result = await client.request('anything');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.ABORTED);
  });

  it('lists the methods it answers', () => {
    const { server } = connectPair();
    server.onRequest('b', async () => ok(1));
    server.onRequest('a', async () => ok(1));

    expect(server.methods).toEqual(['a', 'b']);
    server.dispose();
  });
});

describe('error code mapping', () => {
  it('maps invalid input to invalidParams and unknown methods to methodNotFound', () => {
    expect(toRpcErrorCode(new AgentError(ErrorCode.INVALID_INPUT, 'x'))).toBe(
      RpcErrorCode.invalidParams,
    );
    expect(toRpcErrorCode(new AgentError(ErrorCode.UNSUPPORTED, 'x'))).toBe(
      RpcErrorCode.methodNotFound,
    );
    expect(toRpcErrorCode(new AgentError(ErrorCode.ABORTED, 'x'))).toBe(
      RpcErrorCode.requestCancelled,
    );
  });

  it('does not report an application failure as an internal error', () => {
    // `internalError` should mean "this server has a bug". A denied approval or
    // a missing project is neither internal nor a bug.
    expect(toRpcErrorCode(new AgentError(ErrorCode.APPROVAL_DENIED, 'x'))).toBe(
      RpcErrorCode.applicationError,
    );
    expect(toRpcErrorCode(new AgentError(ErrorCode.NOT_FOUND, 'x'))).toBe(
      RpcErrorCode.applicationError,
    );
  });

  it('rebuilds an unknown error code as internal rather than trusting it', () => {
    const rebuilt = AgentError.fromJSON({
      code: 'SOMETHING_FROM_THE_FUTURE' as never,
      message: 'x',
      retryable: true,
    });

    expect(rebuilt.code).toBe(ErrorCode.INTERNAL);
  });
});
