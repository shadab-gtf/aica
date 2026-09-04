import type { Id, Result } from '@aica/shared';
import { errors, newId, ok, err } from '@aica/shared';

import type { ActionDescriptor, PolicyContext, PolicyDecision } from './risk.js';
import { evaluatePolicy } from './risk.js';

/**
 * Approval brokering (specification section 32).
 *
 * The gate is transport-agnostic: the VS Code extension answers with a modal,
 * the web dashboard with a prompt in the run view, and tests with a scripted
 * responder. The security decision itself is made here in the server, never in
 * a UI, because a UI can be bypassed.
 */
export interface ApprovalRequest {
  readonly id: Id<'appr'>;
  readonly action: ActionDescriptor;
  readonly reason: string;
}

export interface ApprovalResponse {
  readonly granted: boolean;
  /**
   * When true, the same subject is auto-approved for the remainder of the run.
   * Scoped to the run deliberately: a standing grant must not outlive the task
   * that justified it.
   */
  readonly remember?: boolean;
}

export type ApprovalResponder = (request: ApprovalRequest) => Promise<ApprovalResponse>;

/** Denies everything. The default, so an unwired gate fails closed. */
export const denyAllResponder: ApprovalResponder = async () => ({ granted: false });

export interface ApprovalGateOptions {
  readonly context: PolicyContext;
  readonly responder?: ApprovalResponder;
  readonly onRequest?: (request: ApprovalRequest) => void;
  readonly onResolved?: (request: ApprovalRequest, response: ApprovalResponse) => void;
}

export interface AuthorizationRecord {
  readonly action: ActionDescriptor;
  readonly decision: PolicyDecision;
  readonly granted: boolean;
  readonly approvalId?: Id<'appr'>;
  readonly at: number;
}

/**
 * Evaluates policy, asks the human when the policy says to, and records every
 * decision for the audit log (specification section 62).
 */
export class ApprovalGate {
  private readonly context: PolicyContext;
  private readonly responder: ApprovalResponder;
  private readonly onRequest?: (request: ApprovalRequest) => void;
  private readonly onResolved?: (request: ApprovalRequest, response: ApprovalResponse) => void;
  private readonly remembered = new Set<string>();
  private readonly records: AuthorizationRecord[] = [];

  constructor(options: ApprovalGateOptions) {
    this.context = options.context;
    this.responder = options.responder ?? denyAllResponder;
    this.onRequest = options.onRequest;
    this.onResolved = options.onResolved;
  }

  get auditTrail(): readonly AuthorizationRecord[] {
    return this.records;
  }

  /**
   * Authorize an action.
   *
   * Returns Ok only when the action may proceed. A denial and a declined
   * approval are distinguished by error code so callers can tell "forbidden by
   * configuration" from "the user said no".
   */
  async authorize(action: ActionDescriptor): Promise<Result<AuthorizationRecord>> {
    const decision = evaluatePolicy(action, this.context);

    if (decision.outcome === 'deny') {
      this.record({ action, decision, granted: false });
      return err(
        errors.permissionDenied(decision.reason, {
          subject: action.subject,
          risk: action.risk,
          kind: action.kind,
        }),
      );
    }

    if (decision.outcome === 'allow') {
      return ok(this.record({ action, decision, granted: true }));
    }

    const key = rememberKey(action);
    if (this.remembered.has(key)) {
      return ok(
        this.record({
          action,
          decision: { outcome: 'allow', reason: 'Previously approved in this run.' },
          granted: true,
        }),
      );
    }

    const request: ApprovalRequest = {
      id: newId('appr'),
      action,
      reason: decision.reason,
    };
    this.onRequest?.(request);

    let response: ApprovalResponse;
    try {
      response = await this.responder(request);
    } catch (error) {
      // A broken or disconnected responder must fail closed, never open.
      this.record({ action, decision, granted: false, approvalId: request.id });
      return err(
        errors.approvalDenied('Approval could not be obtained; treating as denied.', {
          subject: action.subject,
          cause: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    this.onResolved?.(request, response);

    if (!response.granted) {
      this.record({ action, decision, granted: false, approvalId: request.id });
      return err(
        errors.approvalDenied(`Declined: ${action.subject}`, {
          subject: action.subject,
          risk: action.risk,
        }),
      );
    }

    // A standing grant is never extended to DESTRUCTIVE actions: each one is
    // confirmed on its own.
    if (response.remember && action.risk !== 'DESTRUCTIVE') this.remembered.add(key);

    return ok(this.record({ action, decision, granted: true, approvalId: request.id }));
  }

  private record(input: Omit<AuthorizationRecord, 'at'>): AuthorizationRecord {
    const record: AuthorizationRecord = { ...input, at: Date.now() };
    this.records.push(record);
    return record;
  }
}

function rememberKey(action: ActionDescriptor): string {
  return `${action.kind}::${action.subject}::${action.environment ?? 'local'}`;
}
