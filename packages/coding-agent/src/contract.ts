/**
 * The coding-agent provider contract.
 *
 * A coding agent is an *execution* provider: it is handed a brief this system
 * wrote and returns a patch this system validates. It is not the intelligence
 * of the product, and the shape of this interface is what keeps that true —
 * nothing here lets a provider decide what to build, only report on building
 * it.
 *
 * This is deliberately not `AIProvider`. That abstraction streams tokens and
 * tool calls for a conversation this system drives turn by turn. A coding agent
 * is the opposite: a long-running, out-of-process job with its own lifecycle,
 * polled rather than streamed, returning a diff rather than a message. Fusing
 * the two would give one interface where half the methods are meaningless
 * whichever implementation you pick.
 *
 * Everything crossing this boundary is provider-neutral. A `CodingSession` has
 * no vendor field a caller can branch on, states are this system's own, and no
 * provider-specific type is re-exported. Swapping the provider is meant to be a
 * configuration change, not a refactor.
 */

import type { Result } from '@aica/shared';

/**
 * The lifecycle of a delegated coding task, owned by this system.
 *
 * Providers report their own states; the adapter maps them onto these. The
 * distinction that matters most is between `completed` and `verified`: a
 * provider saying it finished means only that it stopped working. Nothing is
 * `verified` until this system's validation pipeline says so.
 */
export const CodingSessionState = {
  /** Created here, not yet acknowledged by the provider. */
  pending: 'pending',
  /** Accepted and queued by the provider. */
  queued: 'queued',
  /** The provider is deciding how to do the work. */
  planning: 'planning',
  /** The provider is waiting on a human decision before continuing. */
  awaitingApproval: 'awaitingApproval',
  /** The provider is waiting for a reply to a question it asked. */
  awaitingInput: 'awaitingInput',
  /** Work is under way. */
  running: 'running',
  /** Work is suspended and can resume. */
  paused: 'paused',
  /**
   * The provider stopped and produced a result. This is *not* success: the
   * changes have not been validated yet.
   */
  completed: 'completed',
  /** The provider failed, or was unreachable past the retry budget. */
  failed: 'failed',
  /** Cancelled by this system or by the user. */
  cancelled: 'cancelled',
} as const;

export type CodingSessionState = (typeof CodingSessionState)[keyof typeof CodingSessionState];

/** States from which no further transition happens. */
const TERMINAL_STATES: ReadonlySet<CodingSessionState> = new Set<CodingSessionState>([
  CodingSessionState.completed,
  CodingSessionState.failed,
  CodingSessionState.cancelled,
]);

export function isTerminal(state: CodingSessionState): boolean {
  return TERMINAL_STATES.has(state);
}

/** States where the provider is blocked until this system responds. */
const BLOCKED_STATES: ReadonlySet<CodingSessionState> = new Set<CodingSessionState>([
  CodingSessionState.awaitingApproval,
  CodingSessionState.awaitingInput,
]);

export function isAwaitingUs(state: CodingSessionState): boolean {
  return BLOCKED_STATES.has(state);
}

/**
 * Where the work happens.
 *
 * Identifiers are opaque to this system and validated before use — a provider
 * repository id and a branch name both end up in URLs and request bodies, so
 * neither is passed through unchecked.
 */
export interface CodingRepository {
  /** Provider-assigned identifier for the connected repository. */
  readonly sourceId: string;
  /** Branch the work starts from. */
  readonly startingBranch?: string;
}

/** The task handed to a provider: a finished brief, not a research request. */
export interface CodingTask {
  /**
   * The brief, produced by the Integration Planner. Never the raw user message:
   * a provider receives a specification derived from indexed facts.
   */
  readonly brief: string;
  /** Short human-readable title, for the provider's own UI and for ours. */
  readonly title: string;
  readonly repository: CodingRepository;
  /**
   * Require the provider to get approval before executing its plan. Defaults to
   * on: an agent editing a repository unattended is exactly what the approval
   * gate exists to prevent.
   */
  readonly requirePlanApproval?: boolean;
}

export interface CodingSession {
  /** This system's identifier for the session. */
  readonly id: string;
  /** The provider's own identifier, kept for correlation and support. */
  readonly providerSessionId: string;
  readonly state: CodingSessionState;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /**
   * A URL a human can open to watch the provider work. Safe to show: it carries
   * no credential.
   */
  readonly url?: string;
  /** Present when the session failed, explaining why in this system's terms. */
  readonly failureReason?: string;
}

export const CodingActivityKind = {
  /** The provider proposed a plan. */
  planProposed: 'planProposed',
  /** A plan was approved. */
  planApproved: 'planApproved',
  /** The provider said something. */
  agentMessage: 'agentMessage',
  /** This system said something. */
  userMessage: 'userMessage',
  /** A progress report. */
  progress: 'progress',
  /** The provider produced changes. */
  changes: 'changes',
  /** The provider ran a command. */
  command: 'command',
  /** The session finished. */
  completed: 'completed',
  /** The session failed. */
  failed: 'failed',
  /** Something the adapter did not recognize; preserved rather than dropped. */
  unknown: 'unknown',
} as const;

export type CodingActivityKind = (typeof CodingActivityKind)[keyof typeof CodingActivityKind];

/** A patch a provider produced, in a form this system can apply and review. */
export interface CodingChangeSet {
  /** Unified diff. This system applies it; the provider never writes locally. */
  readonly unifiedDiff: string;
  /** Commit the diff applies to, when the provider reports one. */
  readonly baseCommitId?: string;
  /** Commit message the provider suggests. Advisory only. */
  readonly suggestedCommitMessage?: string;
}

/** Output of a command the provider ran, useful when diagnosing a failure. */
export interface CodingCommandOutput {
  readonly command: string;
  readonly output: string;
  readonly exitCode?: number;
}

export interface CodingActivity {
  readonly id: string;
  readonly kind: CodingActivityKind;
  /** Human-readable description, already redacted. */
  readonly description: string;
  readonly createdAt: number;
  /** Who produced it. */
  readonly originator: 'agent' | 'user' | 'unknown';
  readonly changes?: CodingChangeSet;
  readonly command?: CodingCommandOutput;
}

/** What a finished session produced. */
export interface CodingResult {
  readonly sessionId: string;
  readonly state: CodingSessionState;
  /** Every change set the provider produced, in order. */
  readonly changeSets: readonly CodingChangeSet[];
  /** The provider's closing message, when it gave one. */
  readonly summary?: string;
  readonly failureReason?: string;
}

/** Whether a provider supports an optional capability, so callers can ask. */
export interface CodingAgentCapabilities {
  /** The provider can cancel a running session. */
  readonly cancel: boolean;
  /** The provider can accept follow-up messages mid-session. */
  readonly followUp: boolean;
  /** The provider surfaces a plan for approval before executing. */
  readonly planApproval: boolean;
  /** The provider returns changes as a unified diff. */
  readonly unifiedDiff: boolean;
}

/**
 * A coding agent this system can delegate to.
 *
 * Every method returns `Result` rather than throwing: a provider being down is
 * an ordinary condition the orchestrator handles, not an exception that ends a
 * run. That is the difference between "Jules is unavailable, falling back" and
 * a crashed task.
 */
export interface CodingAgentProvider {
  /** Stable provider name, for configuration and display. */
  readonly name: string;
  readonly capabilities: CodingAgentCapabilities;

  /** Verify configuration and reachability without starting work. */
  healthCheck(): Promise<Result<true>>;

  /** List repositories the provider can work on. */
  listRepositories(): Promise<Result<readonly CodingRepository[]>>;

  createSession(task: CodingTask): Promise<Result<CodingSession>>;
  getSession(sessionId: string): Promise<Result<CodingSession>>;
  getActivities(sessionId: string): Promise<Result<readonly CodingActivity[]>>;

  /** Send a follow-up instruction, such as a repair request. */
  sendMessage(sessionId: string, message: string): Promise<Result<void>>;

  /** Approve a plan the provider is waiting on. */
  approvePlan(sessionId: string): Promise<Result<void>>;

  getResult(sessionId: string): Promise<Result<CodingResult>>;

  /**
   * Cancel a running session.
   *
   * Providers without cancellation return `UNSUPPORTED`. That is deliberately
   * not optional-and-absent: a caller that needs to stop a session must get an
   * explicit answer, because silently doing nothing would leave an agent
   * running against a repository.
   */
  cancel(sessionId: string): Promise<Result<void>>;
}
