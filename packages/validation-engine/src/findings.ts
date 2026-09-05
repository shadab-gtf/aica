/**
 * What a validation run produces.
 *
 * These types are the currency of the repair loop, and their shape decides
 * whether repair works at all. An agent told "tests failed" flails; an agent
 * told "src/api/client.ts:42 — Property 'amount' is missing in type Refund"
 * makes one edit. So a finding carries a location and the tool's own words,
 * and the parsers exist to recover exactly that from a wall of output.
 *
 * The compiler and the test suite rank first and second in the authority order
 * (§2), above the API specification and far above the model. That is why
 * nothing here is interpreted: `message` is the tool's text, not a paraphrase,
 * and a line that could not be parsed is preserved as a finding with no
 * location rather than discarded.
 */

export const CheckKind = {
  typecheck: 'typecheck',
  lint: 'lint',
  test: 'test',
  build: 'build',
  e2e: 'e2e',
  contractTest: 'contractTest',
} as const;

export type CheckKind = (typeof CheckKind)[keyof typeof CheckKind];

/**
 * Order matters. A type error makes every later check meaningless — the tests
 * that "fail" are failing because nothing compiled — so the pipeline runs them
 * in this order and reports the first failure as the one to fix.
 */
export const CHECK_ORDER: readonly CheckKind[] = [
  CheckKind.typecheck,
  CheckKind.lint,
  CheckKind.test,
  CheckKind.build,
  CheckKind.contractTest,
  CheckKind.e2e,
];

export const FindingSeverity = {
  error: 'error',
  warning: 'warning',
} as const;

export type FindingSeverity = (typeof FindingSeverity)[keyof typeof FindingSeverity];

export interface ValidationFinding {
  /** Which check produced it. */
  readonly check: string;
  /** The tool's own message, redacted but not paraphrased. */
  readonly message: string;
  readonly severity: FindingSeverity;
  /** Workspace-relative path, when the tool reported one. */
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  /** Tool-specific code, e.g. `TS2741` or `no-unused-vars`. */
  readonly code?: string;
  /** Test name, when the finding came from a failing test. */
  readonly testName?: string;
}

/** The result of running one check. */
export interface CheckResult {
  readonly check: CheckKind;
  readonly passed: boolean;
  /** The command as displayed, with no secrets in it. */
  readonly command: string;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly findings: readonly ValidationFinding[];
  readonly timedOut: boolean;
  /** True when output hit the byte cap; findings may be incomplete. */
  readonly truncated: boolean;
  /** Set when the check could not be run at all. */
  readonly skippedReason?: string;
}

export interface ValidationReport {
  readonly passed: boolean;
  readonly results: readonly CheckResult[];
  readonly findings: readonly ValidationFinding[];
  readonly durationMs: number;
  /** The check that failed first, which is the one worth fixing. */
  readonly firstFailure?: CheckKind;
}

/** Structural view matching the coding-agent port, for delegated work. */
export interface ValidationOutcome {
  readonly passed: boolean;
  readonly findings: readonly ValidationFinding[];
}

export function errorsOf(findings: readonly ValidationFinding[]): ValidationFinding[] {
  return findings.filter((finding) => finding.severity === FindingSeverity.error);
}

/** One-line summary for a log, an event, or a UI row. */
export function describeReport(report: ValidationReport): string {
  if (report.passed) {
    return `All ${report.results.length} check(s) passed in ${report.durationMs}ms.`;
  }

  const failed = report.results.filter((result) => !result.passed);
  const counts = failed
    .map((result) => `${result.check} (${errorsOf(result.findings).length})`)
    .join(', ');

  return `Failed: ${counts}.`;
}
