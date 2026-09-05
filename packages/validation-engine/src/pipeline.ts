/**
 * The validation pipeline: deciding whether a change is actually good.
 *
 * This is the authority the rest of the system defers to. Section 2 puts the
 * compiler first and the test suite second, above the API specification and far
 * above the model — so "the agent says it's done" and "Jules reported
 * COMPLETED" both mean nothing until this has run.
 *
 * Design points that matter:
 *
 * - **Checks run in dependency order and stop at the first failure.** A type
 *   error makes every later check meaningless: the tests that "fail" are
 *   failing because nothing compiled. Reporting forty test failures caused by
 *   one missing property sends an agent chasing symptoms. `runAll` exists for
 *   when a complete picture is wanted instead.
 * - **Commands come from configuration, never from a model.** They are executed
 *   through `CommandExecutor`, so the allowlist, the argument vector, the
 *   timeout, the output cap, and redaction all apply exactly as they do to any
 *   other command. There is no separate path to the shell here.
 * - **A check that cannot run is not a check that passed.** An unconfigured or
 *   unresolvable command is reported as skipped with a reason, and a pipeline
 *   where everything was skipped does not pass.
 */

import type { CommandExecutor } from '@aica/exec-engine';
import type { ValidationConfig } from '@aica/schemas';
import type { Logger, Result } from '@aica/shared';
import { ok, silentLogger } from '@aica/shared';

import type { CheckKind, CheckResult, ValidationFinding, ValidationReport } from './findings.js';
import { CHECK_ORDER, errorsOf } from './findings.js';
import { parseBuild, parseLint, parseTests, parseTypecheck, parseUnknown } from './parsers.js';

export interface PipelineOptions {
  readonly executor: CommandExecutor;
  readonly config: ValidationConfig;
  readonly logger?: Logger;
  readonly onCheckStarted?: (check: CheckKind) => void;
  readonly onCheckFinished?: (result: CheckResult) => void;
  readonly now?: () => number;
}

export interface RunOptions {
  /** Restrict the run to these checks, in the pipeline's own order. */
  readonly only?: readonly CheckKind[];
  /** Run every check even after one fails. Off by default. */
  readonly runAll?: boolean;
  readonly signal?: AbortSignal;
}

/** Extra environment each check gets, so tools behave non-interactively. */
const CHECK_ENV: Readonly<Record<string, string>> = {
  CI: '1',
  FORCE_COLOR: '0',
  NO_COLOR: '1',
};

export class ValidationPipeline {
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(private readonly options: PipelineOptions) {
    this.logger = (options.logger ?? silentLogger).child('validate');
    this.now = options.now ?? (() => Date.now());
  }

  /** Which checks this project has configured. */
  configuredChecks(): CheckKind[] {
    return CHECK_ORDER.filter((check) => (this.commandFor(check)?.length ?? 0) > 0);
  }

  async run(options: RunOptions = {}): Promise<Result<ValidationReport>> {
    const startedAt = this.now();
    const wanted = options.only ?? CHECK_ORDER;
    const checks = CHECK_ORDER.filter((check) => wanted.includes(check));

    const results: CheckResult[] = [];

    for (const check of checks) {
      const command = this.commandFor(check);

      if (!command || command.length === 0) {
        // Not configured is not failed — but it is recorded, so a report can
        // never be read as "everything passed" when nothing ran.
        results.push(this.skipped(check, 'No command is configured for this check.'));
        continue;
      }

      this.options.onCheckStarted?.(check);
      const result = await this.runCheck(check, command, options.signal);
      results.push(result);
      this.options.onCheckFinished?.(result);

      if (!result.passed && !options.runAll) {
        this.logger.debug('stopping at first failure', { check });
        break;
      }
    }

    return ok(this.report(results, this.now() - startedAt));
  }

  /** Run one check by name, for a fast inner loop. */
  async runOne(check: CheckKind, signal?: AbortSignal): Promise<Result<CheckResult>> {
    const command = this.commandFor(check);
    if (!command || command.length === 0) {
      return ok(this.skipped(check, 'No command is configured for this check.'));
    }
    return ok(await this.runCheck(check, command, signal));
  }

  private async runCheck(
    check: CheckKind,
    command: readonly string[],
    signal?: AbortSignal,
  ): Promise<CheckResult> {
    const [program, ...args] = command;
    if (program === undefined) {
      return this.skipped(check, 'The configured command is empty.');
    }

    const started = this.now();
    const outcome = await this.options.executor.run(
      { program, args },
      {
        timeoutMs: this.options.config.timeoutMs,
        injectEnv: CHECK_ENV,
        ...(signal ? { signal } : {}),
      },
    );

    if (!outcome.ok) {
      // The command could not be run at all — blocked by policy, program not
      // found. That is a configuration problem, not a code problem, and saying
      // "lint failed" would send an agent to edit source that is fine.
      return {
        check,
        passed: false,
        command: command.join(' '),
        exitCode: null,
        durationMs: this.now() - started,
        timedOut: false,
        truncated: false,
        findings: [
          {
            check,
            severity: 'error',
            message: `The ${check} command could not be run: ${outcome.error.message}`,
          },
        ],
        skippedReason: outcome.error.message,
      };
    }

    const result = outcome.value;
    const output = `${result.stdout}\n${result.stderr}`;
    const findings = result.ok ? [] : this.parse(check, output, result.exitCode);

    if (result.timedOut) {
      findings.unshift({
        check,
        severity: 'error',
        message: `The ${check} command exceeded its ${this.options.config.timeoutMs}ms budget and was terminated.`,
      });
    }

    return {
      check,
      passed: result.ok,
      command: result.command,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      truncated: result.truncated,
      findings,
    };
  }

  /**
   * Parse a failing check's output, falling back rather than losing it.
   *
   * A recognized format yields located findings. An unrecognized one yields the
   * tail of the output verbatim — because a failure with nothing to act on is
   * the worst outcome the loop can produce.
   */
  private parse(check: CheckKind, output: string, exitCode: number | null): ValidationFinding[] {
    const parsed = this.parserFor(check)(output);
    return parsed.length > 0 ? parsed : parseUnknown(check, output, exitCode);
  }

  private parserFor(check: CheckKind): (output: string) => ValidationFinding[] {
    switch (check) {
      case 'typecheck':
        return parseTypecheck;
      case 'lint':
        return parseLint;
      case 'test':
      case 'e2e':
      case 'contractTest':
        return parseTests;
      case 'build':
        return parseBuild;
      default:
        return () => [];
    }
  }

  private commandFor(check: CheckKind): readonly string[] | undefined {
    return this.options.config[check];
  }

  private skipped(check: CheckKind, reason: string): CheckResult {
    return {
      check,
      passed: true,
      command: '',
      exitCode: null,
      durationMs: 0,
      timedOut: false,
      truncated: false,
      findings: [],
      skippedReason: reason,
    };
  }

  private report(results: readonly CheckResult[], durationMs: number): ValidationReport {
    const findings = results.flatMap((result) => result.findings);
    const failed = results.find((result) => !result.passed);

    // A pipeline where nothing actually ran has not validated anything, and
    // must not report success.
    const ran = results.filter((result) => result.skippedReason === undefined);
    const passed = failed === undefined && ran.length > 0;

    return {
      passed,
      results,
      findings,
      durationMs,
      ...(failed ? { firstFailure: failed.check } : {}),
    };
  }
}

/**
 * The pipeline as the shape a delegated coding agent's repair loop expects.
 *
 * Structurally compatible with `ValidationRunner` in `coding-agent`, so the two
 * connect without either package importing the other. The patch has already
 * been applied to the working tree by the caller: this validates the workspace
 * as it now stands, which is the only thing a compiler can actually check.
 */
export function asValidationRunner(pipeline: ValidationPipeline): {
  validate(): Promise<Result<{ passed: boolean; findings: readonly ValidationFinding[] }>>;
} {
  return {
    async validate() {
      const report = await pipeline.run();
      if (!report.ok) return report;
      return ok({
        passed: report.value.passed,
        // Only errors drive repair. Warnings are reported elsewhere; feeding
        // them into a repair loop makes an agent chase style while a type error
        // sits unfixed.
        findings: errorsOf(report.value.findings),
      });
    },
  };
}
