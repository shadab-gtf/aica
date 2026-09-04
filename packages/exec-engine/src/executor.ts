import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

import type { Logger, Result } from '@aica/shared';
import { Limits, err, errors, ok, silentLogger, truncate } from '@aica/shared';
import type { CommandPolicy, CommandSpec, PathPolicy, Redactor } from '@aica/security-engine';
import { buildChildEnv, renderForDisplay } from '@aica/security-engine';

import { buildCmdInvocation, isBatchShim } from './quoting.js';
import { resolveProgram } from './resolve.js';

/**
 * Process execution (specification section 35).
 *
 * Every command the agent runs passes through here, and every command is
 * checked against the command policy first. The executor never receives a shell
 * string: a command is a program name plus an argument vector, so there is no
 * parsing step in which an argument could become a second command.
 *
 * Guarantees provided:
 *
 * - the command is allowlisted and the program is resolved to a concrete file;
 * - the working directory is inside the project;
 * - the environment is filtered rather than inherited, so credentials the
 *   developer happens to have exported are not handed to arbitrary tools;
 * - output is capped, so a runaway process cannot exhaust memory;
 * - a timeout terminates the whole process tree, not just the direct child;
 * - captured output is redacted before it is returned to a caller.
 */

export interface CommandResult {
  readonly command: string;
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  /** True when either stream hit the byte cap and was truncated. */
  readonly truncated: boolean;
  readonly ok: boolean;
}

export interface ExecOptions {
  /** Working directory relative to the project root. Defaults to the root. */
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  /** Environment variables to pass through by name. */
  readonly passthroughEnv?: readonly string[];
  /** Values injected for this command only, such as CI=1. */
  readonly injectEnv?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  /** Called with each redacted output chunk, for live UI streaming. */
  readonly onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
}

export interface CommandExecutorOptions {
  readonly pathPolicy: PathPolicy;
  readonly commandPolicy: CommandPolicy;
  readonly redactor?: Redactor;
  readonly logger?: Logger;
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export class CommandExecutor {
  private readonly pathPolicy: PathPolicy;
  private readonly commandPolicy: CommandPolicy;
  private readonly redactor: Redactor | undefined;
  private readonly logger: Logger;
  private readonly platform: NodeJS.Platform;
  private readonly env: Readonly<Record<string, string | undefined>>;

  constructor(options: CommandExecutorOptions) {
    this.pathPolicy = options.pathPolicy;
    this.commandPolicy = options.commandPolicy;
    this.redactor = options.redactor;
    this.logger = (options.logger ?? silentLogger).child('exec');
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
  }

  /** Validate a command without running it, for previews and approval prompts. */
  preview(spec: CommandSpec): Result<{ display: string; risk: string }> {
    const verdict = this.commandPolicy.check(spec);
    if (!verdict.ok) return verdict;
    return ok({ display: verdict.value.display, risk: verdict.value.risk });
  }

  async run(spec: CommandSpec, options: ExecOptions = {}): Promise<Result<CommandResult>> {
    const verdict = this.commandPolicy.check(spec);
    if (!verdict.ok) return verdict;

    const cwdResolved = this.pathPolicy.resolve(options.cwd ?? '.');
    if (!cwdResolved.ok) return cwdResolved;
    const cwd = cwdResolved.value.absolute;

    const resolved = resolveProgram(spec.program, {
      root: this.pathPolicy.root,
      env: this.env,
      platform: this.platform,
    });
    if (!resolved.ok) return resolved;

    const display = renderForDisplay(spec);
    const timeoutMs = options.timeoutMs ?? Limits.defaultCommandTimeoutMs;
    const maxOutputBytes = options.maxOutputBytes ?? Limits.maxCommandOutputBytes;

    const childEnv = buildChildEnv({
      source: this.env,
      passthrough: options.passthroughEnv,
      inject: options.injectEnv,
    });
    // Project-local binaries must be reachable by anything the child spawns in
    // turn, which is how a package script that calls `tsc` resolves it.
    childEnv.PATH = prependLocalBin(
      this.pathPolicy.root,
      childEnv.PATH ?? childEnv.Path ?? '',
      this.platform,
    );

    this.logger.debug('running command', {
      command: display,
      cwd: this.pathPolicy.relativize(cwd),
    });

    return this.spawnAndCollect({
      resolvedPath: resolved.value.path,
      args: spec.args,
      display,
      cwd,
      env: childEnv,
      timeoutMs,
      maxOutputBytes,
      signal: options.signal,
      onOutput: options.onOutput,
    });
  }

  private spawnAndCollect(input: {
    resolvedPath: string;
    args: readonly string[];
    display: string;
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
    maxOutputBytes: number;
    signal?: AbortSignal;
    onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  }): Promise<Result<CommandResult>> {
    return new Promise<Result<CommandResult>>((resolve) => {
      const startedAt = Date.now();
      const isWindows = this.platform === 'win32';

      // On Windows a .cmd/.bat shim must go through cmd.exe. The command line is
      // constructed with explicit quoting rather than by handing a string to a
      // shell; see ./quoting.ts.
      const invocation =
        isWindows && isBatchShim(input.resolvedPath)
          ? buildCmdInvocation(input.resolvedPath, input.args)
          : { file: input.resolvedPath, args: [...input.args], windowsVerbatimArguments: false };

      let child: ChildProcess;
      try {
        child = spawn(invocation.file, invocation.args, {
          cwd: input.cwd,
          env: input.env,
          // No shell, ever. This is the property that makes argument content
          // inert rather than parseable.
          shell: false,
          windowsHide: true,
          windowsVerbatimArguments: invocation.windowsVerbatimArguments,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: !isWindows,
        });
      } catch (error) {
        resolve(
          err(
            errors.toolFailure(`Could not start "${input.display}"`, {
              cause: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
        return;
      }

      const stdout = new BoundedBuffer(input.maxOutputBytes);
      const stderr = new BoundedBuffer(input.maxOutputBytes);
      let timedOut = false;
      let aborted = false;
      let settled = false;

      const cleanup = (): void => {
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', onAbort);
      };

      const finish = (result: Result<CommandResult>): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        this.terminate(child);
      }, input.timeoutMs);

      const onAbort = (): void => {
        aborted = true;
        this.terminate(child);
      };
      input.signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout?.on('data', (chunk: Buffer) => {
        const text = this.redact(chunk.toString('utf8'));
        stdout.push(text);
        input.onOutput?.(text, 'stdout');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        const text = this.redact(chunk.toString('utf8'));
        stderr.push(text);
        input.onOutput?.(text, 'stderr');
      });

      child.on('error', (error) => {
        finish(
          err(
            errors.toolFailure(`"${input.display}" failed to execute`, {
              command: input.display,
              cause: error.message,
            }),
          ),
        );
      });

      child.on('close', (code, signal) => {
        const durationMs = Date.now() - startedAt;

        if (timedOut) {
          finish(
            err(
              errors.timeout(
                `"${input.display}" exceeded its ${input.timeoutMs}ms budget and was terminated.`,
                {
                  command: input.display,
                  timeoutMs: input.timeoutMs,
                  // Partial output is the most useful diagnostic here, so it is
                  // preserved on the error rather than discarded.
                  stdout: truncate(stdout.text, 2_000),
                  stderr: truncate(stderr.text, 2_000),
                },
              ),
            ),
          );
          return;
        }

        if (aborted) {
          finish(
            err(errors.aborted(`"${input.display}" was cancelled.`, { command: input.display })),
          );
          return;
        }

        // A non-zero exit is an outcome, not an executor failure: the validation
        // pipeline and the repair loop need the output in order to diagnose it.
        finish(
          ok({
            command: input.display,
            cwd: this.pathPolicy.relativize(input.cwd),
            exitCode: code,
            signal: signal ?? null,
            stdout: stdout.text,
            stderr: stderr.text,
            durationMs,
            timedOut: false,
            truncated: stdout.truncated || stderr.truncated,
            ok: code === 0,
          }),
        );
      });
    });
  }

  /**
   * Terminate the process and its descendants.
   *
   * A package script typically spawns further processes; killing only the
   * direct child would leave those running. On POSIX the child is detached into
   * its own process group so the group can be signalled; on Windows `taskkill`
   * with the tree flag is the equivalent.
   */
  private terminate(child: ChildProcess): void {
    const pid = child.pid;
    if (pid === undefined) return;

    if (this.platform === 'win32') {
      try {
        spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
          stdio: 'ignore',
          windowsHide: true,
          shell: false,
        });
      } catch {
        child.kill('SIGKILL');
      }
      return;
    }

    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }

    // Escalate if the tree ignores SIGTERM.
    const escalation = setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, 3_000);
    escalation.unref();
  }

  private redact(text: string): string {
    return this.redactor ? this.redactor.text(text) : text;
  }
}

/**
 * Ring-free bounded buffer: keeps the first N bytes and records that the rest
 * was dropped. The head of a build log holds the first error, which is what the
 * repair loop needs, so the head is what is kept.
 */
class BoundedBuffer {
  private readonly chunks: string[] = [];
  private bytes = 0;
  private didTruncate = false;

  constructor(private readonly maxBytes: number) {}

  push(text: string): void {
    if (this.didTruncate) return;
    const size = Buffer.byteLength(text, 'utf8');
    if (this.bytes + size <= this.maxBytes) {
      this.chunks.push(text);
      this.bytes += size;
      return;
    }
    const remaining = this.maxBytes - this.bytes;
    if (remaining > 0) this.chunks.push(text.slice(0, remaining));
    this.didTruncate = true;
    this.chunks.push(`\n... [output truncated at ${this.maxBytes} bytes]`);
  }

  get text(): string {
    return this.chunks.join('');
  }

  get truncated(): boolean {
    return this.didTruncate;
  }
}

function prependLocalBin(root: string, currentPath: string, platform: NodeJS.Platform): string {
  const separator = platform === 'win32' ? ';' : ':';
  const localBin = path.join(root, 'node_modules', '.bin');
  return currentPath.length > 0 ? `${localBin}${separator}${currentPath}` : localBin;
}
