/**
 * Transports.
 *
 * Two real ones and one for tests, all behind the same three-method interface
 * so nothing above this file knows whether it is talking to a pipe, a socket,
 * or an object in the same process.
 */

import type { Readable, Writable } from 'node:stream';

import type { Transport } from './connection.js';

/**
 * A transport over a pair of Node streams.
 *
 * On the server side these are `process.stdin` and `process.stdout`, which
 * carries one rule with it: **nothing else may write to stdout.** A stray
 * `console.log` lands in the middle of a frame and desynchronises the stream
 * permanently. Diagnostics go to stderr, which is why the server's logger is
 * wired there and `no-console` is an error in this repository.
 */
export function streamTransport(input: Readable, output: Writable): Transport {
  const dataListeners: ((chunk: Buffer) => void)[] = [];
  const closeListeners: (() => void)[] = [];
  let closed = false;

  const fireClose = (): void => {
    if (closed) return;
    closed = true;
    for (const listener of closeListeners) listener();
  };

  input.on('data', (chunk: Buffer | string) => {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    for (const listener of dataListeners) listener(buffer);
  });
  input.on('end', fireClose);
  input.on('close', fireClose);
  // A pipe whose far end vanishes emits an error before it emits close. Without
  // this the connection would sit with requests pending against a dead peer.
  input.on('error', fireClose);
  output.on('error', fireClose);

  return {
    send(data) {
      if (closed) return;
      // The return value (backpressure) is deliberately ignored. Node buffers
      // internally, messages here are bounded by MAX_MESSAGE_BYTES, and the far
      // end is a local process — pausing a protocol peer mid-conversation would
      // trade a small memory cost for a deadlock risk.
      output.write(data);
    },
    onData(listener) {
      dataListeners.push(listener);
    },
    onClose(listener) {
      if (closed) {
        listener();
        return;
      }
      closeListeners.push(listener);
    },
    close() {
      fireClose();
    },
  };
}

/**
 * Two transports wired to each other, in one process.
 *
 * This is what makes the gateway testable without spawning anything: a test
 * builds the real server on one end and a real client on the other, and every
 * byte still goes through the real framing and the real JSON-RPC layer. Only
 * the pipe is simulated.
 *
 * Delivery is deferred to the microtask queue so that a handler which replies
 * synchronously cannot re-enter its own caller before that caller has returned
 * — which a real pipe would never do, and which would otherwise let tests pass
 * against ordering that cannot happen in production.
 */
export function createTransportPair(): [Transport, Transport] {
  const left = new LoopbackEnd();
  const right = new LoopbackEnd();
  left.link(right);
  right.link(left);
  return [left, right];
}

class LoopbackEnd implements Transport {
  private readonly dataListeners: ((chunk: Buffer) => void)[] = [];
  private readonly closeListeners: (() => void)[] = [];
  private peer: LoopbackEnd | undefined;
  private closed = false;

  link(peer: LoopbackEnd): void {
    this.peer = peer;
  }

  send(data: Buffer): void {
    if (this.closed) return;
    const peer = this.peer;
    queueMicrotask(() => peer?.deliver(data));
  }

  onData(listener: (chunk: Buffer) => void): void {
    this.dataListeners.push(listener);
  }

  onClose(listener: () => void): void {
    if (this.closed) {
      listener();
      return;
    }
    this.closeListeners.push(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener();
    // Closing one end closes the conversation, exactly as a broken pipe would.
    this.peer?.close();
  }

  private deliver(data: Buffer): void {
    if (this.closed) return;
    for (const listener of this.dataListeners) listener(data);
  }
}
