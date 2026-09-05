/**
 * Turning the event stream into something a person can read.
 *
 * The UI renders from `AgentEvent` and nothing else (§5.1), so this is where
 * events become a status line and a timeline. Two rules apply throughout:
 *
 * - **Never invent a status.** An event type this build does not recognise
 *   produces a neutral entry naming the type, rather than being dropped. A
 *   dropped event is a gap in the run timeline, and the timeline is the audit
 *   record (§28, §29).
 * - **Never render an unredacted value.** Payloads arrive already redacted by
 *   the server; this layer additionally never concatenates raw arguments or
 *   results into a label, only the previews the contract provides.
 */

import type { AgentEvent } from '@aica/shared';

export interface TimelineEntry {
  readonly seq: number;
  readonly at: string;
  readonly type: string;
  readonly label: string;
  readonly detail?: string;
  readonly icon: string;
  readonly severity: 'info' | 'warning' | 'error' | 'success';
}

export function toTimelineEntry(event: AgentEvent): TimelineEntry {
  const base = { seq: event.seq, at: event.at, type: event.type };

  switch (event.type) {
    case 'AGENT_STARTED':
      return {
        ...base,
        label: event.payload.task,
        detail: `${event.payload.provider} · ${event.payload.model}`,
        icon: 'play',
        severity: 'info',
      };

    case 'STATUS':
      return { ...base, label: event.payload.message, icon: 'sync', severity: 'info' };

    case 'ASSISTANT_MESSAGE':
      return { ...base, label: event.payload.text, icon: 'comment', severity: 'info' };

    case 'PLAN_CREATED':
      return {
        ...base,
        label: event.payload.summary,
        detail: `${event.payload.steps.length} step${event.payload.steps.length === 1 ? '' : 's'}`,
        icon: 'list-ordered',
        severity: 'info',
      };

    case 'TOOL_CALLED':
      // The preview, never the arguments. The contract guarantees the preview
      // is redacted and truncated; the raw object carries no such guarantee.
      return {
        ...base,
        label: event.payload.tool,
        detail: event.payload.argsPreview,
        icon: 'tools',
        severity: 'info',
      };

    case 'TOOL_COMPLETED':
      return {
        ...base,
        label: event.payload.tool,
        detail: event.payload.ok
          ? `${event.payload.durationMs}ms`
          : (event.payload.error?.message ?? 'failed'),
        icon: event.payload.ok ? 'check' : 'error',
        severity: event.payload.ok ? 'success' : 'error',
      };

    case 'APPROVAL_REQUESTED':
      return {
        ...base,
        label: event.payload.subject,
        detail: event.payload.risk,
        icon: 'shield',
        severity: 'warning',
      };

    case 'APPROVAL_RESOLVED':
      return {
        ...base,
        label: event.payload.granted ? 'Approved' : 'Denied',
        icon: event.payload.granted ? 'check' : 'circle-slash',
        severity: event.payload.granted ? 'info' : 'warning',
      };

    case 'PATCH_CREATED':
      return {
        ...base,
        label: `Proposed changes to ${countFiles(event.payload.files.length)}`,
        icon: 'diff',
        severity: 'info',
      };

    case 'PATCH_APPLIED':
      return {
        ...base,
        label: `Applied changes to ${countFiles(event.payload.files.length)}`,
        icon: 'check',
        severity: 'success',
      };

    case 'PATCH_REVERTED':
      return {
        ...base,
        label: 'Reverted changes',
        detail: event.payload.reason,
        icon: 'discard',
        severity: 'warning',
      };

    case 'VALIDATION_STARTED':
      return {
        ...base,
        label: `Validating: ${event.payload.steps.join(', ')}`,
        icon: 'beaker',
        severity: 'info',
      };

    case 'VALIDATION_PASSED':
      return {
        ...base,
        label: 'Validation passed',
        detail: `${event.payload.durationMs}ms`,
        icon: 'pass',
        severity: 'success',
      };

    case 'VALIDATION_FAILED':
      return {
        ...base,
        label: `Validation failed at ${event.payload.failedStep}`,
        ...(event.payload.diagnosis !== undefined ? { detail: event.payload.diagnosis } : {}),
        icon: 'error',
        severity: 'error',
      };

    case 'REPAIR_STARTED':
      return {
        ...base,
        label: `Repair attempt ${event.payload.attempt} of ${event.payload.maxAttempts}`,
        detail: event.payload.rootCause,
        icon: 'wrench',
        severity: 'warning',
      };

    case 'REPAIR_COMPLETED':
      return {
        ...base,
        label: event.payload.succeeded ? 'Repair succeeded' : 'Repair did not succeed',
        detail: event.payload.explanation,
        icon: event.payload.succeeded ? 'check' : 'error',
        severity: event.payload.succeeded ? 'success' : 'error',
      };

    case 'FINDING_REPORTED':
      return {
        ...base,
        label: event.payload.title,
        detail: event.payload.file
          ? `${event.payload.severity} · ${event.payload.file}`
          : event.payload.severity,
        icon: 'warning',
        severity: event.payload.severity === 'INFO' ? 'info' : 'warning',
      };

    case 'CONFIDENCE_ASSESSED':
      return {
        ...base,
        label: `${event.payload.decision}: ${event.payload.confidence} confidence`,
        detail: `${event.payload.evidence.length} piece(s) of evidence`,
        icon: event.payload.confidence === 'LOW' ? 'question' : 'info',
        severity: event.payload.confidence === 'LOW' ? 'warning' : 'info',
      };

    case 'CLARIFICATION_REQUESTED':
      return {
        ...base,
        label: event.payload.question,
        detail: event.payload.reason,
        icon: 'question',
        severity: 'warning',
      };

    case 'AGENT_FAILED':
      return { ...base, label: event.payload.error.message, icon: 'error', severity: 'error' };

    case 'AGENT_COMPLETED':
      return {
        ...base,
        label: event.payload.summary,
        detail: `${countFiles(event.payload.filesChanged)} · ${event.payload.validationPassed ? 'validation passed' : 'validation did not pass'}`,
        icon: event.payload.validationPassed ? 'pass' : 'warning',
        severity: event.payload.validationPassed ? 'success' : 'warning',
      };

    default:
      // An event this build has not been taught about is still part of the run.
      // Showing it as its type is strictly better than showing nothing.
      return { ...base, label: humanize(event.type), icon: 'circle-small', severity: 'info' };
  }
}

/**
 * What the status bar should say right now.
 *
 * Only events that represent a change of state update it. A tool completing is
 * timeline material; a status bar that flickers through forty tool names tells
 * the user nothing except that something is happening.
 */
export function statusBarText(event: AgentEvent): string | undefined {
  switch (event.type) {
    case 'AGENT_STARTED':
      return 'Working…';
    case 'STATUS':
      return event.payload.message;
    case 'VALIDATION_STARTED':
      return 'Validating…';
    case 'VALIDATION_PASSED':
      return 'Validation passed';
    case 'VALIDATION_FAILED':
      return `Validation failed at ${event.payload.failedStep}`;
    case 'REPAIR_STARTED':
      return `Repairing (attempt ${event.payload.attempt})…`;
    case 'CLARIFICATION_REQUESTED':
      return 'Waiting for your answer';
    case 'APPROVAL_REQUESTED':
      return 'Waiting for approval';
    case 'AGENT_FAILED':
      return 'Failed';
    case 'AGENT_COMPLETED':
      return 'Done';
    default:
      return undefined;
  }
}

/** Whether this event should pull the user's attention to a view. */
export function demandsAttention(event: AgentEvent): boolean {
  return (
    event.type === 'APPROVAL_REQUESTED' ||
    event.type === 'CLARIFICATION_REQUESTED' ||
    event.type === 'AGENT_FAILED'
  );
}

function countFiles(count: number): string {
  return `${count} file${count === 1 ? '' : 's'}`;
}

function humanize(type: string): string {
  const words = type.toLowerCase().split('_');
  const first = words[0] ?? '';
  return [first.charAt(0).toUpperCase() + first.slice(1), ...words.slice(1)].join(' ');
}
