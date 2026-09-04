import type { Confidence, Evidence } from '@aica/shared';

/**
 * The confidence engine (specification section 31).
 *
 * Confidence is *derived from counted evidence*, never asserted by the model.
 * A model saying "I am 95% confident" is not evidence; finding exactly one
 * endpoint whose path and method match the request, in a codebase that already
 * has a client for that API, is.
 *
 * The output drives behaviour rather than decoration: LOW means stop and ask
 * the user (specification section 60's clarification path), HIGH means proceed.
 */

export interface Decision {
  /** What is being decided, e.g. "endpoint selection". */
  readonly subject: string;
  readonly evidence: readonly Evidence[];
}

export interface Assessment {
  readonly subject: string;
  readonly confidence: Confidence;
  readonly supporting: number;
  readonly opposing: number;
  /** Plain-language justification, shown to the user with the decision. */
  readonly rationale: string;
  readonly evidence: readonly Evidence[];
}

export function evidence(
  kind: string,
  description: string,
  supports: boolean,
  source?: string,
): Evidence {
  return { kind, description, supports, ...(source ? { source } : {}) };
}

/**
 * Assess a decision.
 *
 * The rules are intentionally simple and legible, because an opaque scoring
 * function would make the resulting confidence as unaccountable as a number the
 * model made up:
 *
 * - Any opposing evidence caps confidence at MEDIUM; contradiction is a reason
 *   to look again, not to average out.
 * - Two or more independent supporting facts and no contradiction is HIGH.
 * - A single supporting fact is MEDIUM: it might be right, but nothing
 *   corroborates it.
 * - No evidence is LOW, regardless of how plausible the conclusion seems.
 */
export function assess(decision: Decision): Assessment {
  const supporting = decision.evidence.filter((item) => item.supports);
  const opposing = decision.evidence.filter((item) => !item.supports);

  let confidence: Confidence;
  let rationale: string;

  if (supporting.length === 0) {
    confidence = 'LOW';
    rationale =
      opposing.length > 0
        ? `No evidence supports this, and ${opposing.length} fact(s) contradict it.`
        : 'There is no evidence either way.';
  } else if (opposing.length > 0) {
    confidence = 'MEDIUM';
    rationale = `${supporting.length} fact(s) support this, but ${opposing.length} contradict it: ${opposing
      .map((item) => item.description)
      .join('; ')}.`;
  } else if (supporting.length >= 2) {
    confidence = 'HIGH';
    rationale = `Corroborated by ${supporting.length} independent facts: ${supporting
      .map((item) => item.description)
      .join('; ')}.`;
  } else {
    confidence = 'MEDIUM';
    rationale = `Only one fact supports this: ${supporting[0]?.description ?? ''}. Nothing corroborates it.`;
  }

  return {
    subject: decision.subject,
    confidence,
    supporting: supporting.length,
    opposing: opposing.length,
    rationale,
    evidence: decision.evidence,
  };
}

/** True when the agent must stop and ask rather than proceed. */
export function shouldAskUser(assessment: Assessment): boolean {
  return assessment.confidence === 'LOW';
}

/**
 * Combine assessments for a multi-part decision. The result is the weakest
 * part, because a plan is only as sound as its least-supported step.
 */
export function weakest(assessments: readonly Assessment[]): Confidence {
  if (assessments.length === 0) return 'LOW';
  if (assessments.some((item) => item.confidence === 'LOW')) return 'LOW';
  if (assessments.some((item) => item.confidence === 'MEDIUM')) return 'MEDIUM';
  return 'HIGH';
}
