/**
 * Failure diagnosis: turning findings into something worth acting on.
 *
 * A failing pipeline usually reports far more than went wrong. One missing
 * property produces a type error at every call site; one broken import fails
 * every test in the file. Handing all of it to a repair loop is how an agent
 * ends up editing thirty places to fix one.
 *
 * So this does three things, all of them deterministic:
 *
 * 1. **Groups findings by shared cause** — same code, same file, same message
 *    shape — so a cascade is presented as one problem.
 * 2. **Ranks the groups** so the likely root cause leads.
 * 3. **Classifies the failure** into a category that changes what should happen
 *    next, because "your code has a type error" and "the test runner is not
 *    installed" call for completely different responses and an agent cannot
 *    tell them apart from the raw text.
 *
 * Nothing here consults a model. A diagnosis is evidence about the run, and
 * evidence produced by a model could not be used to check a model.
 */

import type { CheckKind, ValidationFinding, ValidationReport } from './findings.js';
import { errorsOf } from './findings.js';

export const FailureCategory = {
  /** A type error in the project's own code. */
  typeError: 'typeError',
  /** A module could not be resolved. */
  missingModule: 'missingModule',
  /** A test asserted something and it was not true. */
  assertionFailure: 'assertionFailure',
  /** Something threw where nothing was expected to. */
  runtimeError: 'runtimeError',
  /** A lint rule was violated. */
  styleViolation: 'styleViolation',
  /** The check itself is misconfigured — not a problem with the code. */
  toolingProblem: 'toolingProblem',
  /** The check ran out of time. */
  timeout: 'timeout',
  unknown: 'unknown',
} as const;

export type FailureCategory = (typeof FailureCategory)[keyof typeof FailureCategory];

export interface FindingGroup {
  readonly category: FailureCategory;
  /** What these findings appear to have in common. */
  readonly summary: string;
  readonly findings: readonly ValidationFinding[];
  /** Files involved, so a reviewer knows where to look. */
  readonly files: readonly string[];
  /**
   * Confidence that fixing this group fixes the run, from counted evidence:
   * how much of the failure it accounts for and how localized it is.
   */
  readonly weight: number;
}

export interface Diagnosis {
  readonly passed: boolean;
  readonly check?: CheckKind;
  readonly category: FailureCategory;
  /** Groups, most likely root cause first. */
  readonly groups: readonly FindingGroup[];
  /** One-line statement of what is wrong. */
  readonly summary: string;
  /**
   * Whether an automatic repair attempt is worth making. A tooling problem or a
   * timeout is not something an agent can edit its way out of, and trying wastes
   * an attempt from a small budget.
   */
  readonly repairable: boolean;
  /** Why repair is or is not worth attempting. */
  readonly rationale: string;
}

const MODULE_PATTERNS: readonly RegExp[] = [
  /cannot find module/i,
  /module not found/i,
  /failed to resolve/i,
  /cannot resolve/i,
  /TS2307/,
];

const TOOLING_PATTERNS: readonly RegExp[] = [
  /could not be run/i,
  /command not found/i,
  /is not recognized as an internal or external command/i,
  /ENOENT/,
  /no inputs were found/i,
  /TS18003/,
  /TS5\d{3}/,
];

const ASSERTION_PATTERNS: readonly RegExp[] = [
  /expected .* (?:to|but)/i,
  /assertion/i,
  /toBe|toEqual|toMatch|toContain|toThrow/,
  /AssertionError/,
];

const RUNTIME_PATTERNS: readonly RegExp[] = [
  /TypeError:/,
  /ReferenceError:/,
  /RangeError:/,
  /is not a function/i,
  /cannot read propert/i,
  /undefined is not/i,
];

/**
 * Diagnose a report.
 *
 * Only the first failing check is diagnosed. Later checks in a stopped pipeline
 * did not run, and in a `runAll` pipeline their failures are usually downstream
 * of the first — so leading with the first failure is what points at the cause
 * rather than the symptoms.
 */
export function diagnose(report: ValidationReport): Diagnosis {
  if (report.passed) {
    return {
      passed: true,
      category: FailureCategory.unknown,
      groups: [],
      summary: 'All configured checks passed.',
      repairable: false,
      rationale: 'Nothing to repair.',
    };
  }

  const failing = report.results.find((result) => !result.passed);
  const findings = errorsOf(failing?.findings ?? report.findings);

  if (failing?.timedOut) {
    return {
      passed: false,
      ...(failing.check ? { check: failing.check } : {}),
      category: FailureCategory.timeout,
      groups: [],
      summary: `The ${failing.check} check timed out.`,
      repairable: false,
      rationale:
        'A timeout says nothing about which code is wrong. Raise the budget or narrow the check rather than editing blindly.',
    };
  }

  if (failing?.skippedReason !== undefined && findings.length <= 1) {
    return {
      passed: false,
      ...(failing.check ? { check: failing.check } : {}),
      category: FailureCategory.toolingProblem,
      groups: [],
      summary: `The ${failing.check} check could not run: ${failing.skippedReason}`,
      repairable: false,
      rationale:
        'The check is misconfigured or its program is missing. Editing source code cannot fix that.',
    };
  }

  const groups = groupFindings(findings);
  const leading = groups[0];
  const category = leading?.category ?? FailureCategory.unknown;

  return {
    passed: false,
    ...(failing?.check ? { check: failing.check } : {}),
    category,
    groups,
    summary: leading
      ? `${failing?.check ?? 'validation'}: ${leading.summary}`
      : `${failing?.check ?? 'validation'} failed with no parseable findings.`,
    ...repairability(category, groups),
  };
}

function repairability(
  category: FailureCategory,
  groups: readonly FindingGroup[],
): { repairable: boolean; rationale: string } {
  if (groups.length === 0) {
    return {
      repairable: false,
      rationale: 'Nothing specific enough to act on was recovered from the output.',
    };
  }

  if (category === FailureCategory.toolingProblem) {
    return {
      repairable: false,
      rationale: 'The check itself is misconfigured; the code is not what is wrong.',
    };
  }

  if (category === FailureCategory.missingModule) {
    return {
      repairable: true,
      rationale:
        'A module could not be resolved. This is often a missing dependency rather than a code error, so verify before installing anything.',
    };
  }

  return {
    repairable: true,
    rationale: `${groups[0]?.findings.length ?? 0} finding(s) share a cause and name a location, which is enough to act on.`,
  };
}

/** Classify one finding by what its message and code say. */
export function categorize(finding: ValidationFinding): FailureCategory {
  const text = `${finding.code ?? ''} ${finding.message}`;

  if (TOOLING_PATTERNS.some((pattern) => pattern.test(text))) return FailureCategory.toolingProblem;
  if (MODULE_PATTERNS.some((pattern) => pattern.test(text))) return FailureCategory.missingModule;

  if (finding.check === 'lint') return FailureCategory.styleViolation;

  if (finding.check === 'typecheck' || /^TS\d+$/.test(finding.code ?? '')) {
    return FailureCategory.typeError;
  }

  if (RUNTIME_PATTERNS.some((pattern) => pattern.test(text))) return FailureCategory.runtimeError;
  if (ASSERTION_PATTERNS.some((pattern) => pattern.test(text))) {
    return FailureCategory.assertionFailure;
  }

  return FailureCategory.unknown;
}

/**
 * Group findings that share a cause.
 *
 * The key is the category plus the tool's own code where there is one — a
 * hundred `TS2741`s are one problem, and the tool already told us so. Without a
 * code, the message shape is used with numbers and quoted names removed, which
 * collapses "Property 'a' is missing" and "Property 'b' is missing".
 */
export function groupFindings(findings: readonly ValidationFinding[]): FindingGroup[] {
  const groups = new Map<string, ValidationFinding[]>();

  for (const finding of findings) {
    const key = `${categorize(finding)}|${finding.code ?? messageShape(finding.message)}`;
    const existing = groups.get(key);
    if (existing) existing.push(finding);
    else groups.set(key, [finding]);
  }

  const total = findings.length || 1;

  return [...groups.values()]
    .map((entries) => {
      const files = [
        ...new Set(entries.map((entry) => entry.file).filter((file): file is string => !!file)),
      ].sort();

      // A cause concentrated in one file is more likely the root than one
      // scattered across many, which usually means we are looking at fallout.
      const share = entries.length / total;
      const concentration = files.length <= 1 ? 1 : 1 / files.length;

      return {
        category: categorize(entries[0] as ValidationFinding),
        summary: summarize(entries),
        findings: entries,
        files,
        weight: Number((share * 0.6 + concentration * 0.4).toFixed(4)),
      };
    })
    .sort(
      (left, right) =>
        right.weight - left.weight ||
        right.findings.length - left.findings.length ||
        left.summary.localeCompare(right.summary),
    );
}

function summarize(entries: readonly ValidationFinding[]): string {
  const first = entries[0] as ValidationFinding;
  const where = first.file ? ` in ${first.file}` : '';
  const count = entries.length > 1 ? ` (${entries.length} occurrences)` : '';
  const code = first.code ? `${first.code}: ` : '';
  return `${code}${first.message.slice(0, 200)}${where}${count}`;
}

/** Reduce a message to its shape, so variants of one error group together. */
function messageShape(message: string): string {
  return message
    .replace(/'[^']*'/g, "'…'")
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\d+/g, '#')
    .slice(0, 120);
}

/**
 * Render a diagnosis as a repair instruction.
 *
 * Only the leading group is included. Sending every finding invites an agent to
 * fix symptoms; sending the group that accounts for most of the failure points
 * it at the cause. The instruction ends with the two prohibitions an agent
 * under pressure reaches for first.
 */
export function toRepairInstruction(diagnosis: Diagnosis, maxFindings = 15): string {
  if (diagnosis.passed) return '';

  const leading = diagnosis.groups[0];
  if (!leading) {
    return [
      `The ${diagnosis.check ?? 'validation'} check failed: ${diagnosis.summary}`,
      '',
      'Investigate and fix it, then run the checks again.',
    ].join('\n');
  }

  const shown = leading.findings.slice(0, maxFindings);
  const omitted = leading.findings.length - shown.length;

  const lines = shown.map((finding) => {
    const where = finding.file
      ? ` (${finding.file}${finding.line !== undefined ? `:${finding.line}` : ''})`
      : '';
    const code = finding.code ? `${finding.code} ` : '';
    const test = finding.testName ? `${finding.testName}: ` : '';
    return `- ${code}${test}${finding.message}${where}`;
  });

  const tail =
    omitted > 0
      ? `\n${omitted} further occurrence(s) of the same cause were omitted; fixing the cause should clear them.`
      : '';

  const others =
    diagnosis.groups.length > 1
      ? `\nThere ${diagnosis.groups.length === 2 ? 'is 1 other group' : `are ${diagnosis.groups.length - 1} other groups`} of findings; they may resolve once this one is fixed.`
      : '';

  return [
    `The ${diagnosis.check ?? 'validation'} check failed. The likely cause:`,
    '',
    lines.join('\n'),
    tail,
    others,
    '',
    'Fix this, then run the checks again.',
    'Do not change unrelated files, and do not disable, skip, or weaken a check to make it pass.',
  ]
    .filter((section) => section.length > 0)
    .join('\n');
}
