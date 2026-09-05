#!/usr/bin/env node
/**
 * Process entry point.
 *
 * The server speaks JSON-RPC on stdin/stdout, and optionally HTTP on loopback
 * for the web dashboard. §3 makes this one process the owner of all state, with
 * both user interfaces as clients of it.
 *
 * Three consequences shape this file:
 *
 * - **Logs go to stderr.** stdout is the protocol channel; a single line
 *   written to it lands inside a frame and desynchronises the connection for
 *   good. The editor surfaces stderr in its output panel, which is where a
 *   developer looks anyway.
 * - **The HTTP listener is opt-in.** Every editor window that opens a folder
 *   starts one of these. Opening a port on each of them, for a dashboard the
 *   user may never run, would be handing out a capability nobody asked for — so
 *   it happens only when `AICA_HTTP_PORT` says to.
 * - **Exit is tied to the pipe.** When the editor goes away, stdin closes, and
 *   an agent server with no client has nothing to serve. Lingering would leave
 *   an orphaned process holding a file watch and an index.
 */

import { RpcConnection, streamTransport } from '@aica/rpc';
import { PROTOCOL_VERSION } from '@aica/schemas';
import { createLogger, parseLogLevel } from '@aica/shared';

import { HttpGateway } from './http.js';
import { AgentServer } from './server.js';

/**
 * Load an environment file, if one was named.
 *
 * Only when `AICA_ENV_FILE` points at it. Deliberately *not* the `.env` sitting
 * in whatever directory this process happens to start in — that directory is
 * the project being analysed, and quietly pulling a user's project secrets into
 * this process's environment is not a convenience, it is a surprise.
 *
 * Named explicitly, it is exactly the convenience it looks like. Node reads it
 * natively, so this costs no dependency, and it does not overwrite a variable
 * that is already set — so a real environment variable beats the file, which is
 * the precedence anyone debugging one would assume.
 *
 * A missing or malformed file is reported and ignored: a server that refuses to
 * start because an optional file is absent is worse than one that starts
 * without the variables it would have set, because the second failure names the
 * variable that is missing.
 *
 * Returns a problem rather than logging one, because this has to run *before*
 * the logger exists — the file is allowed to set `AICA_LOG_LEVEL`, and a logger
 * built first would have already read the old value.
 */
function loadEnvFile(): { file: string; reason: string } | undefined {
  const file = process.env['AICA_ENV_FILE'];
  if (!file) return undefined;

  try {
    process.loadEnvFile(file);
    return undefined;
  } catch (error) {
    return { file, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function main(): Promise<void> {
  // First, so that a file naming `AICA_LOG_LEVEL` sets the level it is then
  // reported at. A logger built beforehand would already have read the old one.
  const envProblem = loadEnvFile();

  const logger = createLogger({
    level: parseLogLevel(process.env['AICA_LOG_LEVEL']) ?? 'info',
    sink: (record) => {
      process.stderr.write(`${JSON.stringify(record)}\n`);
    },
  });

  if (envProblem) logger.warn('AICA_ENV_FILE could not be read', { ...envProblem });

  const transport = streamTransport(process.stdin, process.stdout);
  const connection = new RpcConnection({ transport, logger });
  const server = new AgentServer({ connection, logger });

  let http: HttpGateway | undefined;
  const httpPort = process.env['AICA_HTTP_PORT'];

  if (httpPort !== undefined) {
    http = new HttpGateway({
      gateway: server.methodTable,
      bus: server.eventBus,
      logger,
      port: Number(httpPort),
      // Supplied only by a harness that needs a known value. Left unset in
      // normal use, the token is generated per process, so it cannot be read
      // out of a configuration file somebody committed.
      ...(process.env['AICA_HTTP_TOKEN'] ? { token: process.env['AICA_HTTP_TOKEN'] } : {}),
    });

    const address = await http.listen();

    // On stderr, which is the log channel — not stdout, which is the protocol.
    // The dashboard needs this token, and printing it is how a user gets it
    // without it being written anywhere durable.
    logger.info('dashboard transport ready', { url: address.url });
    process.stderr.write(`AICA_SERVER_URL=${address.url}\nAICA_SERVER_TOKEN=${address.token}\n`);
  }

  const shutdown = (): void => {
    void http?.close();
    connection.dispose();
    process.exit(0);
  };

  connection.onNotification('exit', shutdown);

  transport.onClose(() => {
    logger.info('client disconnected, exiting');
    shutdown();
  });

  // An unhandled rejection anywhere in the process would otherwise take the
  // server down silently, leaving the editor waiting on a request that will
  // never be answered. Log it and keep serving; the request itself already
  // failed through its own error path.
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', { reason: String(reason) });
  });

  logger.info('agent server ready', {
    pid: process.pid,
    protocol: PROTOCOL_VERSION,
    http: http !== undefined,
  });
}

void main();
