import type { AgentErrorJSON } from './errors.js';
import type { Id } from './ids.js';

/**
 * The agent event contract (specification section 58).
 *
 * This discriminated union is the API between the agent core and every user
 * interface. The VS Code extension and the web dashboard both render from these
 * events and nothing else, which keeps the run timeline (section 28) and the
 * observability record (section 29) derived from the same source.
 *
 * Two rules govern what may appear here:
 *
 * 1. No secrets. Every payload passes through redaction before emission.
 * 2. No private chain-of-thought (section 59). Events carry concise status and
 *    tool activity, not the model's internal reasoning.
 */
export const AgentEventType = {
  AGENT_STARTED: 'AGENT_STARTED',
  API_ANALYSIS_STARTED: 'API_ANALYSIS_STARTED',
  API_ANALYSIS_COMPLETED: 'API_ANALYSIS_COMPLETED',
  CODEBASE_ANALYSIS_STARTED: 'CODEBASE_ANALYSIS_STARTED',
  CODEBASE_ANALYSIS_COMPLETED: 'CODEBASE_ANALYSIS_COMPLETED',
  TASK_CLASSIFIED: 'TASK_CLASSIFIED',
  SKILLS_SELECTED: 'SKILLS_SELECTED',
  PLAN_CREATED: 'PLAN_CREATED',
  STATUS: 'STATUS',
  ASSISTANT_MESSAGE: 'ASSISTANT_MESSAGE',
  TOOL_CALLED: 'TOOL_CALLED',
  TOOL_COMPLETED: 'TOOL_COMPLETED',
  APPROVAL_REQUESTED: 'APPROVAL_REQUESTED',
  APPROVAL_RESOLVED: 'APPROVAL_RESOLVED',
  PATCH_CREATED: 'PATCH_CREATED',
  PATCH_APPLIED: 'PATCH_APPLIED',
  PATCH_REVERTED: 'PATCH_REVERTED',
  VALIDATION_STARTED: 'VALIDATION_STARTED',
  VALIDATION_PASSED: 'VALIDATION_PASSED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  REPAIR_STARTED: 'REPAIR_STARTED',
  REPAIR_COMPLETED: 'REPAIR_COMPLETED',
  FINDING_REPORTED: 'FINDING_REPORTED',
  CONFIDENCE_ASSESSED: 'CONFIDENCE_ASSESSED',
  CLARIFICATION_REQUESTED: 'CLARIFICATION_REQUESTED',
  USAGE_RECORDED: 'USAGE_RECORDED',
  AGENT_FAILED: 'AGENT_FAILED',
  AGENT_COMPLETED: 'AGENT_COMPLETED',
} as const;

export type AgentEventType = (typeof AgentEventType)[keyof typeof AgentEventType];

/** Fields present on every event, used for correlation and ordering. */
export interface EventEnvelope {
  readonly id: Id<'evt'>;
  readonly runId: Id<'run'>;
  readonly projectId: Id<'proj'>;
  /** Monotonic per run, so a UI can order and detect gaps. */
  readonly seq: number;
  readonly at: string;
}

export type RiskLevel = 'READ_ONLY' | 'LOW_RISK_WRITE' | 'HIGH_RISK_WRITE' | 'DESTRUCTIVE';
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';
export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
export type TargetEnvironment = 'local' | 'staging' | 'production';

export type TaskKind =
  | 'API_INTEGRATION'
  | 'API_ANALYSIS'
  | 'CODE_ANALYSIS'
  | 'BUG_FIX'
  | 'FRONTEND_REVIEW'
  | 'SECURITY_REVIEW'
  | 'PERFORMANCE_REVIEW'
  | 'API_CHANGE_IMPACT'
  | 'TEST_GENERATION'
  | 'REFACTOR'
  | 'DOCUMENTATION'
  | 'MCP_TASK'
  | 'GENERAL_DEVELOPMENT';

export interface PlanStep {
  readonly index: number;
  readonly title: string;
  readonly detail?: string;
  /** Files this step is expected to touch, for review before anything is written. */
  readonly targets?: readonly string[];
}

export interface FileChangeSummary {
  readonly path: string;
  readonly kind: 'created' | 'modified' | 'deleted';
  readonly linesAdded: number;
  readonly linesRemoved: number;
}

export interface ValidationStepResult {
  readonly name: string;
  readonly command: string;
  readonly passed: boolean;
  readonly durationMs: number;
  /** Truncated and redacted; the full log lives in the run record. */
  readonly summary?: string;
}

/**
 * A single piece of evidence behind a decision. The confidence engine
 * (section 31) derives its level from counted evidence rather than asserting a
 * score, so the evidence is carried with the assessment.
 */
export interface Evidence {
  readonly kind: string;
  readonly description: string;
  readonly source?: string;
  readonly supports: boolean;
}

interface EventBase<T extends AgentEventType, P> extends EventEnvelope {
  readonly type: T;
  readonly payload: P;
}

export type AgentEvent =
  | EventBase<
      typeof AgentEventType.AGENT_STARTED,
      { task: string; model: string; provider: string; mode: string }
    >
  | EventBase<typeof AgentEventType.API_ANALYSIS_STARTED, { source: string; format: string }>
  | EventBase<
      typeof AgentEventType.API_ANALYSIS_COMPLETED,
      { apiId: Id<'api'>; provider: string; endpointCount: number; conflictCount: number }
    >
  | EventBase<typeof AgentEventType.CODEBASE_ANALYSIS_STARTED, { root: string }>
  | EventBase<
      typeof AgentEventType.CODEBASE_ANALYSIS_COMPLETED,
      { fileCount: number; symbolCount: number; durationMs: number }
    >
  | EventBase<
      typeof AgentEventType.TASK_CLASSIFIED,
      { kind: TaskKind; confidence: Confidence; decidedBy: 'deterministic' | 'model' }
    >
  | EventBase<typeof AgentEventType.SKILLS_SELECTED, { skills: readonly string[]; reason: string }>
  | EventBase<
      typeof AgentEventType.PLAN_CREATED,
      { planId: Id<'plan'>; summary: string; steps: readonly PlanStep[]; risks: readonly string[] }
    >
  | EventBase<typeof AgentEventType.STATUS, { message: string }>
  | EventBase<typeof AgentEventType.ASSISTANT_MESSAGE, { text: string; final: boolean }>
  | EventBase<
      typeof AgentEventType.TOOL_CALLED,
      {
        callId: Id<'call'>;
        tool: string;
        risk: RiskLevel;
        /** Redacted and truncated for display. Never the raw argument object. */
        argsPreview: string;
      }
    >
  | EventBase<
      typeof AgentEventType.TOOL_COMPLETED,
      {
        callId: Id<'call'>;
        tool: string;
        ok: boolean;
        durationMs: number;
        resultPreview?: string;
        error?: AgentErrorJSON;
      }
    >
  | EventBase<
      typeof AgentEventType.APPROVAL_REQUESTED,
      {
        approvalId: Id<'appr'>;
        subject: string;
        risk: RiskLevel;
        environment?: TargetEnvironment;
        detail: string;
      }
    >
  | EventBase<
      typeof AgentEventType.APPROVAL_RESOLVED,
      { approvalId: Id<'appr'>; granted: boolean; remembered: boolean }
    >
  | EventBase<
      typeof AgentEventType.PATCH_CREATED,
      { patchId: Id<'patch'>; files: readonly FileChangeSummary[]; rationale: string }
    >
  | EventBase<
      typeof AgentEventType.PATCH_APPLIED,
      { patchId: Id<'patch'>; files: readonly FileChangeSummary[] }
    >
  | EventBase<typeof AgentEventType.PATCH_REVERTED, { patchId: Id<'patch'>; reason: string }>
  | EventBase<typeof AgentEventType.VALIDATION_STARTED, { steps: readonly string[] }>
  | EventBase<
      typeof AgentEventType.VALIDATION_PASSED,
      { results: readonly ValidationStepResult[]; durationMs: number }
    >
  | EventBase<
      typeof AgentEventType.VALIDATION_FAILED,
      { results: readonly ValidationStepResult[]; failedStep: string; diagnosis?: string }
    >
  | EventBase<
      typeof AgentEventType.REPAIR_STARTED,
      { attempt: number; maxAttempts: number; rootCause: string }
    >
  | EventBase<
      typeof AgentEventType.REPAIR_COMPLETED,
      { attempt: number; succeeded: boolean; explanation: string }
    >
  | EventBase<
      typeof AgentEventType.FINDING_REPORTED,
      {
        findingId: Id<'find'>;
        title: string;
        severity: Severity;
        category: string;
        file?: string;
        line?: number;
      }
    >
  | EventBase<
      typeof AgentEventType.CONFIDENCE_ASSESSED,
      { decision: string; confidence: Confidence; evidence: readonly Evidence[] }
    >
  | EventBase<
      typeof AgentEventType.CLARIFICATION_REQUESTED,
      { question: string; options?: readonly string[]; reason: string }
    >
  | EventBase<
      typeof AgentEventType.USAGE_RECORDED,
      {
        provider: string;
        model: string;
        inputTokens?: number;
        outputTokens?: number;
        costUsd?: number;
      }
    >
  | EventBase<typeof AgentEventType.AGENT_FAILED, { error: AgentErrorJSON; recoverable: boolean }>
  | EventBase<
      typeof AgentEventType.AGENT_COMPLETED,
      {
        summary: string;
        filesChanged: number;
        validationPassed: boolean;
        durationMs: number;
        toolCalls: number;
      }
    >;

/** Narrow an event to a specific type. */
export type AgentEventOf<T extends AgentEventType> = Extract<AgentEvent, { type: T }>;

export type AgentEventPayload<T extends AgentEventType> = AgentEventOf<T>['payload'];

export type EventListener = (event: AgentEvent) => void;

/**
 * Ordered, synchronous event bus.
 *
 * Sequence numbers are assigned per run so a late-joining UI can request a
 * replay and detect gaps. Listener exceptions are isolated: one broken consumer
 * must not stop an agent run or starve the other consumers.
 */
export class EventBus {
  private readonly listeners = new Set<EventListener>();
  private readonly sequences = new Map<string, number>();
  private readonly onListenerError: (error: unknown) => void;

  constructor(onListenerError?: (error: unknown) => void) {
    this.onListenerError = onListenerError ?? (() => undefined);
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Next sequence number for a run, starting at 1. */
  nextSeq(runId: Id<'run'>): number {
    const next = (this.sequences.get(runId) ?? 0) + 1;
    this.sequences.set(runId, next);
    return next;
  }

  emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.onListenerError(error);
      }
    }
  }

  /** Release sequence state once a run is finished. */
  closeRun(runId: Id<'run'>): void {
    this.sequences.delete(runId);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}
