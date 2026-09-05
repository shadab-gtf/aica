/**
 * Safety controls around delegating work to an external coding agent.
 *
 * Delegation crosses two boundaries at once: identifiers from this system go
 * out into someone else's URLs, and text from a remote service comes back into
 * our logs, prompts, and UI. Both directions need checking, and the checks live
 * here rather than in a provider so that adding a second provider cannot
 * accidentally ship without them.
 *
 * The threat model is concrete:
 *
 * - A repository or branch identifier interpolated into a request path can
 *   escape it (`../`), inject a query, or smuggle a header (CR/LF). These are
 *   validated by allowlist, not by escaping — the same reasoning as the command
 *   policy in §5.2: a shape that cannot express an attack beats a filter that
 *   tries to catch one.
 * - A brief is sent to a third party, so it must not carry a credential. The
 *   planner does not put secrets in briefs, but "the layer above is careful" is
 *   not a control; this checks.
 * - Everything returned by the provider is untrusted text. It reaches a log, a
 *   UI, and possibly a model prompt, so it is redacted and length-bounded on
 *   the way in — instruction-shaped text in an agent's message is data (§7).
 */

import type { Redactor } from '@aica/security-engine';
import { looksLikeCredential, looksSensitiveKey } from '@aica/security-engine';
import type { Result } from '@aica/shared';
import { err, errors, ok } from '@aica/shared';

/**
 * Provider repository identifiers.
 *
 * Google's resource names are `sources/{id}`; the id itself is restricted to
 * characters that are safe in a path segment. Slashes are permitted only as the
 * single separator of the `sources/` prefix, checked explicitly below.
 */
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$/;

/**
 * Git branch names, following the safe subset of `git check-ref-format`.
 *
 * Deliberately stricter than git itself: no leading dash (reads as a flag), no
 * `..`, no control characters, none of the characters git forbids in refs.
 */
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,254}$/;

/**
 * Characters that would let a value break out of a header or a request line.
 *
 * Matching control characters is the entire purpose here, so the rule against
 * them in a regex is disabled deliberately rather than the check weakened.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export const MAX_BRIEF_CHARS = 60_000;
export const MAX_MESSAGE_CHARS = 16_000;
/** Cap on any single piece of provider text kept in memory or shown. */
export const MAX_PROVIDER_TEXT_CHARS = 32_000;

/**
 * Validate a repository identifier before it is interpolated into a URL.
 *
 * Accepts either the bare id or the full `sources/{id}` resource name, and
 * returns the bare id so callers cannot double up the prefix.
 */
export function validateSourceId(raw: string): Result<string> {
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return err(errors.invalidInput('Repository identifier is empty.'));
  }
  if (CONTROL_CHARACTERS.test(trimmed)) {
    return err(errors.invalidInput('Repository identifier contains control characters.'));
  }

  const bare = trimmed.startsWith('sources/') ? trimmed.slice('sources/'.length) : trimmed;

  if (bare.includes('/')) {
    return err(
      errors.invalidInput(
        `Repository identifier "${bare}" contains a path separator, which could escape the request path.`,
      ),
    );
  }
  if (!SOURCE_ID_PATTERN.test(bare)) {
    return err(
      errors.invalidInput(
        `Repository identifier "${bare}" is not a valid identifier. Expected letters, digits, dots, underscores, or hyphens.`,
      ),
    );
  }

  return ok(bare);
}

/** Validate a branch name before it is sent to a provider or given to git. */
export function validateBranch(raw: string): Result<string> {
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return err(errors.invalidInput('Branch name is empty.'));
  }
  if (CONTROL_CHARACTERS.test(trimmed)) {
    return err(errors.invalidInput('Branch name contains control characters.'));
  }
  if (trimmed.includes('..') || trimmed.includes('//')) {
    return err(errors.invalidInput(`Branch name "${trimmed}" contains a path traversal sequence.`));
  }
  if (trimmed.endsWith('/') || trimmed.endsWith('.lock') || trimmed.endsWith('.')) {
    return err(errors.invalidInput(`Branch name "${trimmed}" is not a valid git ref.`));
  }
  if (!BRANCH_PATTERN.test(trimmed)) {
    return err(
      errors.invalidInput(
        `Branch name "${trimmed}" contains characters that are not valid in a git ref.`,
      ),
    );
  }

  return ok(trimmed);
}

/**
 * Refuse to send a brief that contains a credential.
 *
 * The brief goes to a third party. The planner is built not to put secrets in
 * one, but this is the boundary where it would matter, so the check happens
 * here rather than being assumed upstream. Assignment-shaped lines are examined
 * because that is how a key ends up pasted into text.
 */
export function assertBriefIsSafe(brief: string): Result<string> {
  if (brief.trim().length === 0) {
    return err(errors.invalidInput('Brief is empty; there is nothing for the agent to do.'));
  }
  if (brief.length > MAX_BRIEF_CHARS) {
    return err(
      errors.limitExceeded(
        `Brief is ${brief.length} characters, above the ${MAX_BRIEF_CHARS} limit.`,
        { length: brief.length },
      ),
    );
  }

  const finding = findCredential(brief);
  if (finding) {
    return err(
      errors.permissionDenied(
        `The brief appears to contain a credential (${finding}). Briefs are sent to an external service and must reference secrets by name only.`,
      ),
    );
  }

  return ok(brief);
}

/** Same check for a follow-up message, which travels the same path. */
export function assertMessageIsSafe(message: string): Result<string> {
  if (message.trim().length === 0) {
    return err(errors.invalidInput('Message is empty.'));
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return err(
      errors.limitExceeded(
        `Message is ${message.length} characters, above the ${MAX_MESSAGE_CHARS} limit.`,
        { length: message.length },
      ),
    );
  }

  const finding = findCredential(message);
  if (finding) {
    return err(
      errors.permissionDenied(
        `The message appears to contain a credential (${finding}). Messages are sent to an external service.`,
      ),
    );
  }

  return ok(message);
}

/**
 * Locate credential-shaped content, returning a description of *where* rather
 * than the value itself — an error message naming the secret would leak it into
 * the logs this check exists to protect.
 */
function findCredential(text: string): string | undefined {
  for (const [index, line] of text.split('\n').entries()) {
    // `KEY = value` and `"key": "value"` are how a secret gets pasted in.
    const assignment = /^\s*["']?([A-Za-z0-9_.-]+)["']?\s*[:=]\s*["']?(\S+)["']?\s*,?\s*$/.exec(
      line,
    );
    if (assignment) {
      const key = assignment[1] as string;
      const value = assignment[2] as string;
      if (looksSensitiveKey(key) && !isSecretReference(value) && value.length >= 8) {
        return `line ${index + 1}, under "${key}"`;
      }
    }

    for (const token of line.split(/\s+/)) {
      const cleaned = token.replace(/^["'`]|["'`,;]+$/g, '');
      if (isSecretReference(cleaned)) continue;
      if (looksLikeCredential(cleaned)) return `line ${index + 1}`;
    }
  }

  return undefined;
}

/** `env:NAME` and friends are references, which are exactly what we want. */
function isSecretReference(value: string): boolean {
  return /^(env|file|keychain|prompt):/.test(value);
}

/**
 * Clean text that came back from a provider.
 *
 * Redacted because a coding agent echoes environment variables and command
 * output; bounded because a runaway log would otherwise flow straight into a
 * prompt or a UI; control characters stripped because this text is rendered.
 */
export function sanitizeProviderText(
  text: unknown,
  redactor: Redactor,
  maxChars = MAX_PROVIDER_TEXT_CHARS,
): string {
  if (typeof text !== 'string') return '';

  // Same reasoning: stripping control characters is the point.
  // eslint-disable-next-line no-control-regex
  const withoutControls = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  const redacted = redactor.text(withoutControls);

  return redacted.length > maxChars ? `${redacted.slice(0, maxChars)}… [truncated]` : redacted;
}

/**
 * Bound how long a delegated session may run.
 *
 * An agent that never finishes is indistinguishable from one that failed, and
 * costs money in the meantime.
 */
export interface DurationBudget {
  readonly startedAt: number;
  readonly maxDurationMs: number;
  readonly now: () => number;
}

export function isOverBudget(budget: DurationBudget): boolean {
  return budget.now() - budget.startedAt >= budget.maxDurationMs;
}
