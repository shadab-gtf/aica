#!/usr/bin/env node
/**
 * Process entry point.
 *
 * The server speaks JSON-RPC on stdin/stdout and nothing else. Two consequences
 * shape this file:
 *
 * - **Logs go to stderr.** stdout is the protocol channel; a single line
 *   written to it lands inside a frame and desynchronises the connection for
 *   good. The editor surfaces stderr in its output panel, which is where a
 *   developer looks anyway.
 * - **Exit is tied to the pipe.** When the editor goes away, stdin closes, and
 *   an agent server with no client has nothing to serve. Lingering would leave
 *   an orphaned process holding a file watch and an index.
 */

import { RpcConnection, streamTransport } from '@aica/rpc';
import { PROTOCOL_VERSION } from '@aica/schemas';
import { createLogger, parseLogLevel } from '@aica/shared';

import { AgentServer } from './server.js';

function main(): void {
  const logger = createLogger({
    level: parseLogLevel(process.env['AICA_LOG_LEVEL']) ?? 'info',
    sink: (record) => {
      process.stderr.write(`${JSON.stringify(record)}\n`);
    },
  });

  const transport = streamTransport(process.stdin, process.stdout);
  const connection = new RpcConnection({ transport, logger });
  // Constructed for its side effect: registering every method on the
  // connection. Nothing else in this process holds a reference to it.
  new AgentServer({ connection, logger });

  connection.onNotification('exit', () => {
    connection.dispose();
    process.exit(0);
  });

  transport.onClose(() => {
    logger.info('client disconnected, exiting');
    process.exit(0);
  });

  // An unhandled rejection anywhere in the process would otherwise take the
  // server down silently, leaving the editor waiting on a request that will
  // never be answered. Log it and keep serving; the request itself already
  // failed through its own error path.
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', { reason: String(reason) });
  });

  logger.info('agent server ready', { pid: process.pid, protocol: PROTOCOL_VERSION });
}

main();
