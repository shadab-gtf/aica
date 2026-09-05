/**
 * Spawning and supervising the agent server.
 *
 * The server is a plain Node child process, not code loaded into the extension
 * host (§3). That is what keeps native modules off the editor's Electron ABI
 * and lets one server serve both user interfaces. It also means this file owns
 * the failure modes of running someone else's process, and there are four worth
 * naming:
 *
 * - **stdout is the protocol.** stderr is the log. They are wired to different
 *   places and never mixed.
 * - **A server that dies is reported, not silently absent.** A UI whose calls
 *   quietly stop working is indistinguishable from a UI that is broken.
 * - **A server that dies immediately and repeatedly is not restarted forever.**
 *   Restarting a process that crashes on startup is a spin loop that burns a
 *   core and fills a log.
 * - **The child does not outlive the editor.** Disposal kills it, and killing
 *   escalates: a request to stop, then a real one.
 */

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import path from 'node:path';

import type { Transport } from '@aica/rpc';
import { streamTransport } from '@aica/rpc';

export interface ServerProcessOptions {
  /** Absolute path to the server entry point. */
  readonly entry: string;
  /** Node executable. VS Code exposes its own; `process.execPath` is the default. */
  readonly execPath?: string;
  readonly cwd?: string;
  readonly logLevel?: string;
  readonly onStderr?: (chunk: string) => void;
  readonly onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  readonly spawnImpl?: typeof spawn;
}

/** How long a `SIGTERM` is given before the process is killed outright. */
const TERMINATE_GRACE_MS = 2000;

export class ServerProcess {
  private child: ChildProcess | undefined;
  private transportInstance: Transport | undefined;
  private stopping = false;

  constructor(private readonly options: ServerProcessOptions) {}

  start(): Transport {
    if (this.transportInstance) return this.transportInstance;

    const spawnFn = this.options.spawnImpl ?? spawn;

    const child = spawnFn(this.options.execPath ?? process.execPath, [this.options.entry], {
      cwd: this.options.cwd ?? path.dirname(this.options.entry),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        AICA_LOG_LEVEL: this.options.logLevel ?? 'info',
        // The server writes framed JSON to stdout, and a colour escape in the
        // middle of a frame is a corrupted frame.
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      },
      // Detaching would survive the editor and leave an orphan holding an index.
      detached: false,
      windowsHide: true,
    });

    this.child = child;

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => this.options.onStderr?.(chunk));

    child.on('exit', (code, signal) => {
      this.child = undefined;
      this.transportInstance = undefined;
      if (!this.stopping) this.options.onExit?.(code, signal);
    });

    child.on('error', (error) => {
      // Spawn failure — a missing Node, a bad path. Reported through the same
      // channel as an exit so the caller has one place to handle "no server".
      this.options.onStderr?.(`agent server could not start: ${error.message}\n`);
      this.child = undefined;
      this.transportInstance = undefined;
      if (!this.stopping) this.options.onExit?.(null, null);
    });

    if (!child.stdout || !child.stdin) {
      throw new Error('The agent server was spawned without usable stdio pipes.');
    }

    this.transportInstance = streamTransport(child.stdout, child.stdin);
    return this.transportInstance;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get running(): boolean {
    return this.child !== undefined && this.child.exitCode === null;
  }

  /** Ask the process to stop, then insist. */
  stop(): void {
    const child = this.child;
    if (!child) return;

    this.stopping = true;
    this.transportInstance?.close();
    child.kill('SIGTERM');

    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, TERMINATE_GRACE_MS);
    timer.unref?.();

    this.child = undefined;
    this.transportInstance = undefined;
  }
}

/**
 * Decide how many times a crashing server is worth restarting.
 *
 * A server that runs for a while and then dies is worth bringing back — that is
 * a bug or an out-of-memory, and the user's work should continue. A server that
 * dies within seconds of every start is misconfigured, and restarting it is a
 * spin loop. The distinction is uptime, not attempt count alone.
 */
export class RestartPolicy {
  private failures = 0;

  constructor(
    private readonly maxFailures = 3,
    private readonly healthyUptimeMs = 10_000,
  ) {}

  /** Record an exit and say whether to restart. */
  shouldRestart(uptimeMs: number): boolean {
    if (uptimeMs >= this.healthyUptimeMs) {
      // It ran long enough to be doing its job, so this is not a start-up
      // failure and the budget is not spent.
      this.failures = 0;
      return true;
    }

    this.failures += 1;
    return this.failures <= this.maxFailures;
  }

  get consecutiveFailures(): number {
    return this.failures;
  }

  reset(): void {
    this.failures = 0;
  }
}

/**
 * Where the server lives.
 *
 * A configured path wins, so a developer can point the extension at a local
 * build. Otherwise it is the copy shipped inside the extension, which is the
 * only one guaranteed to match this extension's protocol version.
 */
export function resolveServerEntry(options: {
  configured?: string;
  extensionPath: string;
}): string {
  const configured = options.configured?.trim();
  if (configured) {
    return path.isAbsolute(configured)
      ? configured
      : path.resolve(options.extensionPath, configured);
  }
  return path.join(options.extensionPath, 'dist', 'server', 'main.cjs');
}
