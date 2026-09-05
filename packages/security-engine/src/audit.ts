/**
 * The audit record (§62).
 *
 * An append-only account of every decision this system made that mattered:
 * what was asked for, what the policy said, whether a human was consulted, and
 * what happened. It exists so that "what did this thing do to my repository,
 * and who said it could" is answerable after the fact, by someone who was not
 * watching at the time.
 *
 * Four properties, each of which is a thing an audit log gets wrong:
 *
 * **Append-only.** There is no method that edits or removes an entry. A log
 * that can be corrected is a log that can be laundered, and the whole value of
 * this one is that it is the account of record.
 *
 * **A denial is an entry.** Most audit logs record what happened. The
 * interesting question is usually what was *attempted* — a refused write, a
 * blocked path, a rejected MCP tool — so refusals are recorded exactly as
 * carefully as permissions.
 *
 * **Everything is redacted on the way in, not on the way out.** A secret that
 * reaches storage has leaked, whatever the reader does afterwards. Redaction
 * happens in `record`, before an entry exists.
 *
 * **Persistence never blocks or fails the action.** Writing history is not
 * allowed to be the reason work stops. Entries are held in memory and drained
 * to a sink; a sink that throws costs the entry, not the run.
 */

import type { Clock, Id, Logger, RiskLevel } from '@aica/shared';
import { newId, silentLogger, systemClock } from '@aica/shared';

import type { ActionDescriptor, PolicyDecision } from './risk.js';
import type { Redactor } from './redaction.js';

/** What kind of thing is being recorded. */
export const AuditAction = {
  /** A policy decision about a proposed action. */
  authorize: 'authorize',
  /** A human was asked, and answered. */
  approval: 'approval',
  toolCall: 'tool_call',
  patchApplied: 'patch_applied',
  patchReverted: 'patch_reverted',
  commandRun: 'command_run',
  /** An outbound request, and how much left the machine. */
  egress: 'egress',
  secretResolved: 'secret_resolved',
  mcpConnected: 'mcp_connected',
  mcpToolCall: 'mcp_tool_call',
  configLoaded: 'config_loaded',
  limitExceeded: 'limit_exceeded',
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export const AuditDecision = {
  allowed: 'allowed',
  denied: 'denied',
  /** Allowed because a human said so. */
  approved: 'approved',
  /** Refused because a human said so. */
  declined: 'declined',
  /** It happened and it worked. */
  succeeded: 'succeeded',
  /** It happened and it did not. */
  failed: 'failed',
} as const;

export type AuditDecision = (typeof AuditDecision)[keyof typeof AuditDecision];

export interface AuditEntry {
  readonly id: Id<'evt'>;
  readonly at: string;
  readonly projectId: string;
  readonly runId?: string;
  /** Who or what initiated it: the agent, the user, or a named MCP server. */
  readonly actor: string;
  readonly action: AuditAction;
  /** Short subject, e.g. `POST /payments` or `src/api/client.ts`. */
  readonly subject: string;
  readonly decision: AuditDecision;
  readonly risk?: RiskLevel;
  /** Why, in words. The reason a reader is looking this up. */
  readonly reason?: string;
  /** Structured specifics, already redacted. */
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Where entries go once recorded. Failures here never reach the caller. */
export type AuditSink = (entry: AuditEntry) => void | Promise<void>;

export interface AuditLogOptions {
  readonly projectId: string;
  readonly redactor?: Redactor;
  readonly logger?: Logger;
  readonly clock?: Clock;
  readonly sink?: AuditSink;
  /** Entries kept in memory for querying. Older ones are dropped. */
  readonly retain?: number;
}

const DEFAULT_RETAIN = 2000;

export class AuditLog {
  private readonly entries: AuditEntry[] = [];
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly retain: number;

  constructor(private readonly options: AuditLogOptions) {
    this.logger = (options.logger ?? silentLogger).child('audit');
    this.clock = options.clock ?? systemClock;
    this.retain = options.retain ?? DEFAULT_RETAIN;
  }

  /**
   * Record something.
   *
   * Returns the entry so a caller can correlate, and never throws. The one job
   * this must not do is interrupt the thing it is recording.
   */
  record(input: {
    actor: string;
    action: AuditAction;
    subject: string;
    decision: AuditDecision;
    runId?: string;
    risk?: RiskLevel;
    reason?: string;
    details?: Readonly<Record<string, unknown>>;
  }): AuditEntry {
    const redactor = this.options.redactor;

    const entry: AuditEntry = {
      id: newId('evt'),
      at: new Date(this.clock.now()).toISOString(),
      projectId: this.options.projectId,
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      actor: input.actor,
      action: input.action,
      // Redacted here, before an entry exists. A secret that reaches storage
      // has leaked whatever a reader does with it later.
      subject: redactor ? redactor.text(input.subject) : input.subject,
      decision: input.decision,
      ...(input.risk !== undefined ? { risk: input.risk } : {}),
      ...(input.reason !== undefined
        ? { reason: redactor ? redactor.text(input.reason) : input.reason }
        : {}),
      ...(input.details !== undefined
        ? { details: redactor ? redactor.value(input.details) : input.details }
        : {}),
    };

    this.entries.push(entry);
    if (this.entries.length > this.retain) this.entries.shift();

    try {
      const written = this.options.sink?.(entry);
      // A sink that returns a promise must not be able to reject into a caller
      // that is in the middle of authorising a write.
      if (written instanceof Promise) {
        void written.catch((error: unknown) => {
          this.logger.warn('audit entry not persisted', { reason: String(error) });
        });
      }
    } catch (error) {
      this.logger.warn('audit sink threw', { reason: String(error) });
    }

    return entry;
  }

  /** Record a policy decision about an action. */
  recordAuthorization(
    action: ActionDescriptor,
    decision: PolicyDecision,
    outcome: { granted: boolean; approvalId?: string; runId?: string },
  ): AuditEntry {
    return this.record({
      actor: 'agent',
      action: AuditAction.authorize,
      subject: action.subject,
      // Four outcomes, not two: "the policy allowed it" and "a human allowed
      // it" are different facts, and so are the two ways of saying no.
      decision: outcome.granted
        ? decision.outcome === 'require_approval'
          ? AuditDecision.approved
          : AuditDecision.allowed
        : decision.outcome === 'deny'
          ? AuditDecision.denied
          : AuditDecision.declined,
      risk: action.risk,
      reason: decision.reason,
      ...(outcome.runId !== undefined ? { runId: outcome.runId } : {}),
      details: {
        kind: action.kind,
        ...(action.environment ? { environment: action.environment } : {}),
        ...(outcome.approvalId ? { approvalId: outcome.approvalId } : {}),
      },
    });
  }

  get all(): readonly AuditEntry[] {
    return this.entries;
  }

  /** Everything matching a filter, newest last. */
  query(
    filter: {
      runId?: string;
      action?: AuditAction;
      decision?: AuditDecision;
      since?: string;
      limit?: number;
    } = {},
  ): AuditEntry[] {
    const matched = this.entries.filter((entry) => {
      if (filter.runId !== undefined && entry.runId !== filter.runId) return false;
      if (filter.action !== undefined && entry.action !== filter.action) return false;
      if (filter.decision !== undefined && entry.decision !== filter.decision) return false;
      if (filter.since !== undefined && entry.at < filter.since) return false;
      return true;
    });

    return filter.limit === undefined ? matched : matched.slice(-filter.limit);
  }

  /**
   * What was refused.
   *
   * The question an audit log is usually opened to answer, and the one a
   * success-only log cannot.
   */
  get refusals(): AuditEntry[] {
    return this.entries.filter(
      (entry) =>
        entry.decision === AuditDecision.denied || entry.decision === AuditDecision.declined,
    );
  }

  /** A one-line-per-entry rendering, for a log file or a report. */
  render(limit = 100): string {
    return this.entries
      .slice(-limit)
      .map(
        (entry) =>
          `${entry.at} ${entry.actor} ${entry.action} ${entry.decision} — ${entry.subject}${
            entry.reason ? ` (${entry.reason})` : ''
          }`,
      )
      .join('\n');
  }
}
