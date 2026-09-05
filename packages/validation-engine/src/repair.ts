/**
 * Bounded auto-repair (§39).
 *
 * The loop is small; the constraints are the design. An agent handed "fix it
 * until the tests pass" will, given the chance, disable the test, widen a type
 * to `any`, or oscillate between two broken states forever. Every guard here
 * exists because one of those is the default behaviour without it:
 *
 * - **A hard attempt cap**, from configuration, never from the model.
 * - **Progress is required.** If an attempt does not reduce the findings, the
 *   loop stops. Repeating a prompt that already failed just spends the budget.
 * - **Identical failures end it.** The same finding set twice running means the
 *   attempt changed nothing relevant.
 * - **Not everything is worth attempting.** A misconfigured tool or a timeout is
 *   not repairable by editing source, and `diagnose` says so before an attempt
 *   is spent on it.
 * - **A regression is reported, not hidden.** An attempt that makes things worse
 *   stops the loop and says so, so the caller can revert rather than keep
 *   digging.
 *
 * The repair *action* is injected. This module decides whether to try again and
 * what to say; who performs the edit — the in-house agent loop, a delegated
 * coding agent — is the caller's business.
 */

import type { Logger, Result } from '@aica/shared';
import { ok, silentLogger } from '@aica/shared';

import type { Diagnosis } from './diagnosis.js';
import { diagnose, toRepairInstruction } from './diagnosis.js';
import type { ValidationFinding, ValidationReport } from './findings.js';
import { errorsOf } from './findings.js';

/** Performs one repair attempt. Returns false when it could not act. */
export type RepairAction = (instruction: string, diagnosis: Diagnosis) => Promise<boolean>;

/** Runs the checks and returns a fresh report. */
export type ValidateAction = () => Promise<Result<ValidationReport>>;

export const RepairOutcome = {
  /** Validation passed, either immediately or after repair. */
  passed: 'passed',
  /** The attempt budget ran out with findings remaining. */
  exhausted: 'exhausted',
  /** An attempt changed nothing, so continuing would only repeat it. */
  noProgress: 'noProgress',
  /** The failure is not the kind an edit can fix. */
  notRepairable: 'notRepairable',
  /** An attempt made things worse. */
  regressed: 'regressed',
  /** The repair action reported it could not act. */
  actionFailed: 'actionFailed',
} as const;

export type RepairOutcome = (typeof RepairOutcome)[keyof typeof RepairOutcome];

export interface RepairAttemptRecord {
  readonly attempt: number;
  readonly errorsBefore: number;
  readonly errorsAfter: number;
  readonly category: string;
  readonly summary: string;
}

export interface RepairResult {
  readonly outcome: RepairOutcome;
  readonly attempts: number;
  readonly report: ValidationReport;
  readonly diagnosis: Diagnosis;
  readonly history: readonly RepairAttemptRecord[];
  /** Why the loop stopped, in terms a user can act on. */
  readonly reason: string;
}

export interface RepairLoopOptions {
  readonly validate: ValidateAction;
  readonly repair: RepairAction;
  /** Hard cap on attempts. Zero means validate once and never repair. */
  readonly maxAttempts: number;
  readonly logger?: Logger;
  readonly onAttempt?: (record: { attempt: number; instruction: string }) => void;
  readonly signal?: AbortSignal;
}

/**
 * Validate, and repair while it is worth doing.
 *
 * Returns `Err` only when validation itself could not run. A run that failed
 * and stayed failed is an `Ok` result carrying the reason — that is an outcome
 * the caller reports, not an exception.
 */
export async function runRepairLoop(options: RepairLoopOptions): Promise<Result<RepairResult>> {
  const logger = (options.logger ?? silentLogger).child('repair');
  const history: RepairAttemptRecord[] = [];

  let current = await options.validate();
  if (!current.ok) return current;

  let report = current.value;
  let diagnosis = diagnose(report);
  let previousSignature: string | undefined;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    if (report.passed) break;

    if (options.signal?.aborted) {
      return ok(
        finish(RepairOutcome.exhausted, attempt - 1, report, diagnosis, history, 'Cancelled.'),
      );
    }

    if (!diagnosis.repairable) {
      return ok(
        finish(
          RepairOutcome.notRepairable,
          attempt - 1,
          report,
          diagnosis,
          history,
          diagnosis.rationale,
        ),
      );
    }

    const before = errorsOf(report.findings);
    const signature = signatureOf(before);

    // The same failure twice means the last attempt changed nothing relevant.
    if (signature === previousSignature) {
      return ok(
        finish(
          RepairOutcome.noProgress,
          attempt - 1,
          report,
          diagnosis,
          history,
          'The last attempt did not change the failures, so repeating it would not help.',
        ),
      );
    }
    previousSignature = signature;

    const instruction = toRepairInstruction(diagnosis);
    options.onAttempt?.({ attempt, instruction });
    logger.debug('repair attempt', { attempt, category: diagnosis.category });

    const acted = await options.repair(instruction, diagnosis);
    if (!acted) {
      return ok(
        finish(
          RepairOutcome.actionFailed,
          attempt,
          report,
          diagnosis,
          history,
          'The repair action reported that it could not make a change.',
        ),
      );
    }

    current = await options.validate();
    if (!current.ok) return current;

    const nextReport = current.value;
    const after = errorsOf(nextReport.findings);

    history.push({
      attempt,
      errorsBefore: before.length,
      errorsAfter: after.length,
      category: diagnosis.category,
      summary: diagnosis.summary,
    });

    // Worse than before: stop and let a human look, rather than digging deeper.
    if (!nextReport.passed && after.length > before.length) {
      return ok(
        finish(
          RepairOutcome.regressed,
          attempt,
          nextReport,
          diagnose(nextReport),
          history,
          `Attempt ${attempt} increased the failures from ${before.length} to ${after.length}. Stopping so the change can be reviewed or reverted.`,
        ),
      );
    }

    report = nextReport;
    diagnosis = diagnose(report);
  }

  if (report.passed) {
    return ok(
      finish(
        RepairOutcome.passed,
        history.length,
        report,
        diagnosis,
        history,
        history.length === 0
          ? 'Validation passed with no repair needed.'
          : `Validation passed after ${history.length} repair attempt(s).`,
      ),
    );
  }

  return ok(
    finish(
      RepairOutcome.exhausted,
      history.length,
      report,
      diagnosis,
      history,
      `Validation still failing after ${options.maxAttempts} attempt(s). ${diagnosis.summary}`,
    ),
  );
}

function finish(
  outcome: RepairOutcome,
  attempts: number,
  report: ValidationReport,
  diagnosis: Diagnosis,
  history: readonly RepairAttemptRecord[],
  reason: string,
): RepairResult {
  return { outcome, attempts, report, diagnosis, history: [...history], reason };
}

/**
 * A stable fingerprint of a failure set.
 *
 * Location and code, not message text: a compiler that renumbers or rewords an
 * otherwise identical error should still read as no progress.
 */
function signatureOf(findings: readonly ValidationFinding[]): string {
  return findings
    .map(
      (finding) =>
        `${finding.check}:${finding.code ?? ''}:${finding.file ?? ''}:${finding.line ?? ''}`,
    )
    .sort()
    .join('|');
}
