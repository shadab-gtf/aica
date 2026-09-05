/**
 * Translating Jules into this system's terms.
 *
 * Every function here is pure and takes untrusted input. That is the point of
 * separating it from transport: state mapping and response parsing are where
 * the interesting mistakes live, and they can be tested exhaustively without a
 * server, a key, or a clock.
 *
 * Two rules:
 *
 * - **An unrecognized state is never guessed.** Jules may add states; mapping
 *   one it did not document to `running` would let a session that is actually
 *   blocked look healthy until it times out. Unknown maps to `pending` and is
 *   reported, so the caller sees an honest "I do not know what this is".
 * - **Responses are validated, not cast.** A field the docs promise can still
 *   be absent, and `as JulesSession` would turn that into a crash three layers
 *   away from the cause.
 */

import type { Redactor } from '@aica/security-engine';
import type { Result } from '@aica/shared';
import { err, errors, ok } from '@aica/shared';

import type {
  CodingActivity,
  CodingActivityKind,
  CodingChangeSet,
  CodingSession,
  CodingSessionState,
} from '../../contract.js';
import { CodingSessionState as State } from '../../contract.js';
import { sanitizeProviderText } from '../../safety.js';
import type { JulesActivity, JulesSession, JulesSource } from './types.js';

/**
 * Jules states mapped onto ours.
 *
 * `COMPLETED` becomes `completed`, never `verified`: Jules finishing means it
 * stopped working, and whether the result is any good is decided by this
 * system's validation pipeline. Conflating the two would make an unvalidated
 * patch look like a delivered feature.
 */
const STATE_MAP: Readonly<Record<string, CodingSessionState>> = {
  QUEUED: State.queued,
  PLANNING: State.planning,
  AWAITING_PLAN_APPROVAL: State.awaitingApproval,
  AWAITING_USER_FEEDBACK: State.awaitingInput,
  IN_PROGRESS: State.running,
  PAUSED: State.paused,
  COMPLETED: State.completed,
  FAILED: State.failed,
};

export interface StateMapping {
  readonly state: CodingSessionState;
  /** True when Jules reported something this adapter does not know. */
  readonly unrecognized: boolean;
}

export function mapSessionState(raw: string | undefined): StateMapping {
  if (raw === undefined || raw === 'STATE_UNSPECIFIED') {
    return { state: State.pending, unrecognized: false };
  }

  const mapped = STATE_MAP[raw];
  if (mapped) return { state: mapped, unrecognized: false };

  // An unknown state is treated as "not started as far as we can tell", which
  // keeps polling rather than declaring a result we cannot justify.
  return { state: State.pending, unrecognized: true };
}

/** Extract `{sessionId}` from `sessions/{sessionId}`, or use `id`. */
export function sessionIdOf(session: JulesSession): string | undefined {
  if (typeof session.id === 'string' && session.id.length > 0) return session.id;
  if (typeof session.name === 'string') {
    const match = /^sessions\/(.+)$/.exec(session.name);
    if (match) return match[1] as string;
  }
  return undefined;
}

/** Parse an RFC 3339 timestamp, falling back rather than producing NaN. */
export function parseTimestamp(value: unknown, fallback: number): number {
  if (typeof value !== 'string') return fallback;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export interface ToSessionOptions {
  readonly redactor: Redactor;
  readonly now: number;
}

/**
 * Convert a Jules session into ours, or explain why it could not be.
 *
 * A response with no identifier is unusable — there would be nothing to poll —
 * so that is the one field whose absence is an error rather than a default.
 */
export function toCodingSession(raw: unknown, options: ToSessionOptions): Result<CodingSession> {
  if (!isRecord(raw)) {
    return err(errors.malformedResponse('Jules returned a session that is not an object.'));
  }

  const session = raw as JulesSession;
  const id = sessionIdOf(session);

  if (id === undefined) {
    return err(
      errors.malformedResponse(
        'Jules returned a session without a name or id, so it cannot be tracked.',
      ),
    );
  }

  const mapping = mapSessionState(typeof session.state === 'string' ? session.state : undefined);
  const created = parseTimestamp(session.createTime, options.now);

  return ok({
    id,
    providerSessionId: id,
    state: mapping.state,
    title: sanitizeProviderText(session.title ?? 'Untitled task', options.redactor, 200),
    createdAt: created,
    updatedAt: parseTimestamp(session.updateTime, created),
    ...(isSafeUrl(session.url) ? { url: session.url } : {}),
    ...(mapping.unrecognized
      ? { failureReason: `Jules reported an unrecognized state: ${String(session.state)}` }
      : {}),
  });
}

/**
 * Only accept an `https://` URL from the provider.
 *
 * The URL is shown to a user and may be opened. A `javascript:` or `data:`
 * value arriving in a response field is exactly the sort of thing that should
 * never reach a UI.
 */
function isSafeUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Determine an activity's kind from which event field is populated.
 *
 * Jules sends no discriminant, so the shape *is* the discriminant. Checked in a
 * fixed order, and an activity matching none is `unknown` rather than dropped —
 * losing an event silently is how a session appears to stall.
 */
export function activityKindOf(activity: JulesActivity): CodingActivityKind {
  if (activity.sessionFailed) return 'failed';
  if (activity.sessionCompleted) return 'completed';
  if (activity.planGenerated) return 'planProposed';
  if (activity.planApproved) return 'planApproved';
  if (activity.agentMessaged) return 'agentMessage';
  if (activity.userMessaged) return 'userMessage';
  if (activity.progressUpdated) return 'progress';

  const artifacts = activity.artifacts ?? [];
  if (artifacts.some((artifact) => artifact.changeSet?.gitPatch?.unidiffPatch)) return 'changes';
  if (artifacts.some((artifact) => artifact.bashOutput)) return 'command';

  return 'unknown';
}

/** The human-readable text of an activity, whichever field carries it. */
function activityText(activity: JulesActivity): string {
  return (
    activity.sessionFailed?.reason ??
    activity.agentMessaged?.agentMessage ??
    activity.userMessaged?.userMessage ??
    activity.progressUpdated?.description ??
    activity.progressUpdated?.title ??
    activity.description ??
    ''
  );
}

export function toCodingActivity(
  raw: unknown,
  options: ToSessionOptions,
): CodingActivity | undefined {
  if (!isRecord(raw)) return undefined;

  const activity = raw as JulesActivity;
  const id = activity.id ?? activity.name;
  if (typeof id !== 'string' || id.length === 0) return undefined;

  const changes = firstChangeSet(activity, options.redactor);
  const command = firstCommand(activity, options.redactor);

  return {
    id,
    kind: activityKindOf(activity),
    description: sanitizeProviderText(activityText(activity), options.redactor),
    createdAt: parseTimestamp(activity.createTime, options.now),
    originator: mapOriginator(activity.originator),
    ...(changes ? { changes } : {}),
    ...(command ? { command } : {}),
  };
}

function mapOriginator(value: unknown): CodingActivity['originator'] {
  if (typeof value !== 'string') return 'unknown';
  const lower = value.toLowerCase();
  if (lower.includes('agent')) return 'agent';
  if (lower.includes('user')) return 'user';
  return 'unknown';
}

/**
 * The patch an activity carries.
 *
 * The diff itself is *not* redacted or truncated: it is applied to a working
 * tree and must survive byte-for-byte, and a truncated patch would fail to
 * apply in a confusing way. It is bounded by size instead, and rejected whole
 * if it is implausibly large.
 */
function firstChangeSet(activity: JulesActivity, redactor: Redactor): CodingChangeSet | undefined {
  for (const artifact of activity.artifacts ?? []) {
    const patch = artifact.changeSet?.gitPatch;
    const diff = patch?.unidiffPatch;

    if (typeof diff === 'string' && diff.length > 0 && diff.length <= MAX_PATCH_BYTES) {
      return {
        unifiedDiff: diff,
        ...(typeof patch?.baseCommitId === 'string' ? { baseCommitId: patch.baseCommitId } : {}),
        ...(typeof patch?.suggestedCommitMessage === 'string'
          ? {
              suggestedCommitMessage: sanitizeProviderText(
                patch.suggestedCommitMessage,
                redactor,
                500,
              ),
            }
          : {}),
      };
    }
  }

  return undefined;
}

/** A patch larger than this is not a change to review; it is a mistake. */
export const MAX_PATCH_BYTES = 4 * 1024 * 1024;

function firstCommand(activity: JulesActivity, redactor: Redactor): CodingActivity['command'] {
  for (const artifact of activity.artifacts ?? []) {
    const bash = artifact.bashOutput;
    if (bash && typeof bash.command === 'string') {
      return {
        // Command output routinely echoes environment variables.
        command: sanitizeProviderText(bash.command, redactor, 1000),
        output: sanitizeProviderText(bash.output ?? '', redactor),
        ...(typeof bash.exitCode === 'number' ? { exitCode: bash.exitCode } : {}),
      };
    }
  }
  return undefined;
}

/** Convert a Jules source into a repository reference. */
export function toRepository(raw: unknown): { sourceId: string; label: string } | undefined {
  if (!isRecord(raw)) return undefined;

  const source = raw as JulesSource;
  const id =
    source.id ??
    (typeof source.name === 'string' ? /^sources\/(.+)$/.exec(source.name)?.[1] : undefined);

  if (typeof id !== 'string' || id.length === 0) return undefined;

  const owner = source.githubRepo?.owner;
  const repo = source.githubRepo?.repo;
  const label = owner && repo ? `${owner}/${repo}` : id;

  return { sourceId: id, label };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
