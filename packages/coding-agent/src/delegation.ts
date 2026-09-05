/**
 * Delegation: driving a coding-agent provider through to a verified result.
 *
 * This owns the loop the product's value depends on. A provider reporting
 * "completed" is a claim, not a result; this is where the claim gets checked,
 * and where a failed check turns into a precise repair instruction rather than
 * a shrug.
 *
 *   delegate → poll → completed → validate → verified
 *                                     ↓ failed
 *                                  repair → back to poll
 *
 * Every loop in here is bounded, because all three of them are places an agent
 * could otherwise spin forever: polling has an attempt cap *and* a wall-clock
 * budget, repair has an attempt cap, and a repair that produces no new patch
 * stops rather than asking again.
 *
 * The validation step is a port, not an implementation. This system's real
 * validation pipeline — typecheck, lint, tests, build, contract checks — is
 * `validation-engine`'s job; wiring a second one in here would duplicate it and
 * guarantee the two drift. Until it lands, any `ValidationRunner` satisfies the
 * contract, which is also what makes the repair loop testable without running a
 * build.
 */

import type { Redactor } from '@aica/security-engine';
import type { Logger, Result } from '@aica/shared';
import { err, errors, ok, silentLogger } from '@aica/shared';

import type {
  CodingAgentProvider,
  CodingChangeSet,
  CodingSession,
  CodingSessionState,
  CodingTask,
} from './contract.js';
import { isAwaitingUs, isTerminal, CodingSessionState as State } from './contract.js';
import { sanitizeProviderText } from './safety.js';

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Observability for a delegated task.
 *
 * Names are provider-neutral on purpose: a dashboard filtering on
 * `coding_agent.session.completed` keeps working when the provider changes.
 * No payload carries a credential — the fields are ids, states, counts, and
 * text that has already been through the redactor.
 */
export const CodingAgentEvent = {
  sessionCreated: 'coding_agent.session.created',
  sessionStarted: 'coding_agent.session.started',
  sessionProgress: 'coding_agent.session.progress',
  sessionCompleted: 'coding_agent.session.completed',
  sessionFailed: 'coding_agent.session.failed',
  validationStarted: 'coding_agent.validation.started',
  validationFailed: 'coding_agent.validation.failed',
  validationPassed: 'coding_agent.validation.passed',
  repairStarted: 'coding_agent.repair.started',
  repairExhausted: 'coding_agent.repair.exhausted',
} as const;

export type CodingAgentEvent = (typeof CodingAgentEvent)[keyof typeof CodingAgentEvent];

export interface DelegationEvent {
  readonly type: CodingAgentEvent;
  readonly at: number;
  readonly provider: string;
  readonly sessionId?: string;
  readonly state?: CodingSessionState;
  /** Already redacted and bounded. */
  readonly message?: string;
  readonly attempt?: number;
  readonly filesChanged?: number;
}

export type DelegationListener = (event: DelegationEvent) => void;

// ---------------------------------------------------------------------------
// Validation port
// ---------------------------------------------------------------------------

export interface ValidationFinding {
  /** `typecheck`, `lint`, `test`, `build`, `contract`, `security`. */
  readonly check: string;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
}

export interface ValidationOutcome {
  readonly passed: boolean;
  readonly findings: readonly ValidationFinding[];
}

/**
 * Runs this system's validation pipeline over a candidate change.
 *
 * Implemented by `validation-engine` (Phase 5). Kept as a port so that the loop
 * around it can be built, tested, and reasoned about now, and so a caller can
 * substitute a narrower pipeline — a fast typecheck-only pass for an
 * inner loop, say — without this module knowing.
 */
export interface ValidationRunner {
  validate(changeSet: CodingChangeSet): Promise<Result<ValidationOutcome>>;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface DelegationOptions {
  readonly provider: CodingAgentProvider;
  readonly validation?: ValidationRunner;
  readonly redactor: Redactor;
  readonly logger?: Logger;
  readonly onEvent?: DelegationListener;

  /** Wall-clock budget for the whole delegation. */
  readonly maxDurationMs?: number;
  /** Cap on polls, so a stuck session cannot poll forever inside the budget. */
  readonly maxPolls?: number;
  readonly pollIntervalMs?: number;
  /** Cap on automatic repair rounds. */
  readonly maxRepairAttempts?: number;

  /**
   * Approve a plan the provider is waiting on. Absent means plans are never
   * auto-approved and the delegation stops to ask — which is the safe default
   * for an agent that is about to edit a repository.
   */
  readonly approvePlan?: (session: CodingSession) => Promise<boolean>;

  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_DURATION_MS = 30 * 60 * 1000;
const DEFAULT_MAX_POLLS = 240;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_REPAIR_ATTEMPTS = 3;

export const DelegationStatus = {
  /** Validated and accepted. */
  verified: 'verified',
  /** The provider produced changes but validation was not run. */
  unvalidated: 'unvalidated',
  /** Validation kept failing until the repair budget ran out. */
  repairExhausted: 'repairExhausted',
  /** The provider failed, timed out, or was unreachable. */
  failed: 'failed',
  /** Stopped because a decision is needed from a human. */
  awaitingDecision: 'awaitingDecision',
} as const;

export type DelegationStatus = (typeof DelegationStatus)[keyof typeof DelegationStatus];

export interface DelegationOutcome {
  readonly status: DelegationStatus;
  readonly session: CodingSession;
  readonly changeSet?: CodingChangeSet;
  readonly findings: readonly ValidationFinding[];
  readonly repairAttempts: number;
  readonly durationMs: number;
  readonly message?: string;
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export class Delegator {
  private readonly provider: CodingAgentProvider;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: DelegationOptions) {
    this.provider = options.provider;
    this.logger = (options.logger ?? silentLogger).child('delegate');
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Run a task to a verified result, or to an honest account of why not.
   *
   * Returns `Err` only when the delegation could not be *attempted* — bad
   * configuration, an unreachable provider. A session that ran and failed
   * validation is an `Ok` outcome with a status saying so, because that is a
   * result the orchestrator acts on rather than an exception.
   */
  async run(task: CodingTask): Promise<Result<DelegationOutcome>> {
    const startedAt = this.now();

    const created = await this.provider.createSession(task);
    if (!created.ok) {
      this.emit({ type: CodingAgentEvent.sessionFailed, message: created.error.message });
      return created;
    }

    let session = created.value;
    this.emit({
      type: CodingAgentEvent.sessionCreated,
      sessionId: session.id,
      state: session.state,
    });

    let repairAttempts = 0;
    const findings: ValidationFinding[] = [];

    // Each pass: wait for the provider to stop, then validate what it produced.
    // A failed validation feeds one repair instruction back and goes round
    // again, up to the repair budget.
    for (;;) {
      const settled = await this.pollUntilSettled(session, startedAt);
      if (!settled.ok) return settled;
      session = settled.value;

      if (session.state === State.awaitingApproval || session.state === State.awaitingInput) {
        return ok(
          this.outcome(DelegationStatus.awaitingDecision, session, startedAt, {
            repairAttempts,
            findings,
            message: 'The coding agent is waiting for a decision before it can continue.',
          }),
        );
      }

      if (session.state !== State.completed) {
        this.emit({
          type: CodingAgentEvent.sessionFailed,
          sessionId: session.id,
          state: session.state,
          ...(session.failureReason ? { message: session.failureReason } : {}),
        });
        return ok(
          this.outcome(DelegationStatus.failed, session, startedAt, {
            repairAttempts,
            findings,
            ...(session.failureReason ? { message: session.failureReason } : {}),
          }),
        );
      }

      const result = await this.provider.getResult(session.id);
      if (!result.ok) return result;

      const changeSet = result.value.changeSets.at(-1);
      this.emit({
        type: CodingAgentEvent.sessionCompleted,
        sessionId: session.id,
        state: session.state,
        filesChanged: changeSet ? countChangedFiles(changeSet.unifiedDiff) : 0,
      });

      if (!changeSet) {
        return ok(
          this.outcome(DelegationStatus.failed, session, startedAt, {
            repairAttempts,
            findings,
            message: 'The coding agent finished without producing any changes.',
          }),
        );
      }

      // Without a validation pipeline the changes are returned unvalidated and
      // clearly labelled. Silently calling them verified is the one thing this
      // must never do.
      if (!this.options.validation) {
        return ok(
          this.outcome(DelegationStatus.unvalidated, session, startedAt, {
            repairAttempts,
            findings,
            changeSet,
            message: 'No validation pipeline is configured; the changes have not been checked.',
          }),
        );
      }

      this.emit({ type: CodingAgentEvent.validationStarted, sessionId: session.id });
      const outcome = await this.options.validation.validate(changeSet);
      if (!outcome.ok) return outcome;

      if (outcome.value.passed) {
        this.emit({ type: CodingAgentEvent.validationPassed, sessionId: session.id });
        return ok(
          this.outcome(DelegationStatus.verified, session, startedAt, {
            repairAttempts,
            findings: [],
            changeSet,
          }),
        );
      }

      findings.length = 0;
      findings.push(...outcome.value.findings);

      this.emit({
        type: CodingAgentEvent.validationFailed,
        sessionId: session.id,
        message: summarizeFindings(outcome.value.findings),
      });

      const budget = this.options.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS;
      if (repairAttempts >= budget) {
        this.emit({
          type: CodingAgentEvent.repairExhausted,
          sessionId: session.id,
          attempt: repairAttempts,
        });
        return ok(
          this.outcome(DelegationStatus.repairExhausted, session, startedAt, {
            repairAttempts,
            findings,
            changeSet,
            message: `Validation still failing after ${repairAttempts} repair attempt(s).`,
          }),
        );
      }

      repairAttempts += 1;
      this.emit({
        type: CodingAgentEvent.repairStarted,
        sessionId: session.id,
        attempt: repairAttempts,
      });

      const instruction = buildRepairInstruction(outcome.value.findings);
      const sent = await this.provider.sendMessage(session.id, instruction);
      if (!sent.ok) return sent;
    }
  }

  /**
   * Poll until the session stops or needs us, bounded twice over.
   *
   * The attempt cap and the wall-clock budget catch different failures: a
   * provider answering instantly with the same state would exhaust the former,
   * and one that is merely very slow the latter.
   */
  private async pollUntilSettled(
    initial: CodingSession,
    startedAt: number,
  ): Promise<Result<CodingSession>> {
    const maxPolls = this.options.maxPolls ?? DEFAULT_MAX_POLLS;
    const interval = this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const budget = this.options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;

    let session = initial;
    let lastState: CodingSessionState | undefined;

    for (let poll = 0; poll < maxPolls; poll += 1) {
      if (isTerminal(session.state)) return ok(session);

      if (session.state === State.awaitingApproval) {
        const approved = await this.tryApprove(session);
        if (!approved.ok) return approved;
        // Not approved: the caller has to decide, so stop here rather than
        // spinning against a session that cannot progress.
        if (!approved.value) return ok(session);
      } else if (isAwaitingUs(session.state)) {
        return ok(session);
      }

      if (this.now() - startedAt >= budget) {
        return err(
          errors.timeout(`The coding agent did not finish within ${Math.round(budget / 1000)}s.`, {
            sessionId: session.id,
            state: session.state,
          }),
        );
      }

      await this.sleep(interval);

      const refreshed = await this.provider.getSession(session.id);
      if (!refreshed.ok) return refreshed;
      session = refreshed.value;

      if (session.state !== lastState) {
        lastState = session.state;
        if (session.state === State.running) {
          this.emit({
            type: CodingAgentEvent.sessionStarted,
            sessionId: session.id,
            state: session.state,
          });
        } else {
          this.emit({
            type: CodingAgentEvent.sessionProgress,
            sessionId: session.id,
            state: session.state,
          });
        }
      }
    }

    return err(
      errors.timeout(`The coding agent was still running after ${maxPolls} status checks.`, {
        sessionId: session.id,
        state: session.state,
      }),
    );
  }

  /** Ask the configured approver, if there is one. */
  private async tryApprove(session: CodingSession): Promise<Result<boolean>> {
    if (!this.options.approvePlan) return ok(false);

    const approved = await this.options.approvePlan(session);
    if (!approved) return ok(false);

    const sent = await this.provider.approvePlan(session.id);
    return sent.ok ? ok(true) : err(sent.error);
  }

  private outcome(
    status: DelegationStatus,
    session: CodingSession,
    startedAt: number,
    rest: {
      repairAttempts: number;
      findings: readonly ValidationFinding[];
      changeSet?: CodingChangeSet;
      message?: string;
    },
  ): DelegationOutcome {
    return {
      status,
      session,
      findings: [...rest.findings],
      repairAttempts: rest.repairAttempts,
      durationMs: this.now() - startedAt,
      ...(rest.changeSet ? { changeSet: rest.changeSet } : {}),
      ...(rest.message ? { message: rest.message } : {}),
    };
  }

  private emit(event: Omit<DelegationEvent, 'at' | 'provider'>): void {
    const full: DelegationEvent = {
      ...event,
      at: this.now(),
      provider: this.provider.name,
      ...(event.message
        ? { message: sanitizeProviderText(event.message, this.options.redactor, 2000) }
        : {}),
    };

    this.logger.debug(full.type, { sessionId: full.sessionId, state: full.state });
    this.options.onEvent?.(full);
  }
}

// ---------------------------------------------------------------------------
// Repair instructions
// ---------------------------------------------------------------------------

const MAX_FINDINGS_IN_INSTRUCTION = 20;

/**
 * Turn validation failures into an instruction the agent can act on.
 *
 * Specific and bounded. "Tests are failing, please fix" produces flailing; the
 * actual compiler message with its file and line produces a targeted edit. The
 * list is capped because a hundred cascading type errors usually share one
 * cause, and pasting all of them buries it.
 */
export function buildRepairInstruction(findings: readonly ValidationFinding[]): string {
  const shown = findings.slice(0, MAX_FINDINGS_IN_INSTRUCTION);
  const omitted = findings.length - shown.length;

  const lines = shown.map((finding) => {
    const where = finding.file
      ? ` (${finding.file}${finding.line !== undefined ? `:${finding.line}` : ''})`
      : '';
    return `- [${finding.check}]${where} ${finding.message}`;
  });

  const tail =
    omitted > 0 ? `\n\n${omitted} further finding(s) were omitted; they may share a cause.` : '';

  return [
    'The changes did not pass validation. Fix the following, then run the checks again:',
    '',
    lines.join('\n'),
    tail,
    '',
    'Do not change unrelated files, and do not disable or skip a check to make it pass.',
  ].join('\n');
}

function summarizeFindings(findings: readonly ValidationFinding[]): string {
  const byCheck = new Map<string, number>();
  for (const finding of findings) {
    byCheck.set(finding.check, (byCheck.get(finding.check) ?? 0) + 1);
  }
  return [...byCheck.entries()].map(([check, count]) => `${check}: ${count}`).join(', ');
}

/** Count the files a unified diff touches, for progress reporting. */
export function countChangedFiles(unifiedDiff: string): number {
  const files = new Set<string>();
  for (const line of unifiedDiff.split('\n')) {
    const match = /^\+\+\+ [ab]\/(.+)$/.exec(line);
    if (match) files.add(match[1] as string);
  }
  return files.size;
}
