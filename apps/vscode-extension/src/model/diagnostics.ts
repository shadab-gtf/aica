/**
 * Validation findings as editor diagnostics.
 *
 * Pure: these produce plain descriptors, and the thin adapter above turns them
 * into `vscode.Diagnostic`. That split exists because the interesting decisions
 * here are all about honesty, and they deserve tests that do not need an editor
 * running:
 *
 * - **A finding with no location does not get one.** Attaching an unlocated
 *   error to line 1 of some file is an invention, and the user will open that
 *   line and find nothing wrong with it. Those findings are surfaced in the
 *   problems view against the workspace instead.
 * - **A one-based tool becomes zero-based exactly once.** Every parser in the
 *   validation engine reports 1-based positions because every tool does; VS
 *   Code is 0-based. Converting in one function means it cannot be done twice
 *   or not at all.
 * - **A missing column is a whole line, not column 1.** `tsc` without a column
 *   knows the line and nothing more, and a squiggle under the first character
 *   claims precision that is not there.
 */

import type { ValidationFindingSummary } from '@aica/schemas';

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface DiagnosticDescriptor {
  /** Workspace-relative path. */
  readonly file: string;
  /** Zero-based, for the editor. */
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly source: string;
  readonly code?: string;
  /** True when the range covers the whole line because no column was reported. */
  readonly wholeLine: boolean;
}

export interface DiagnosticGrouping {
  /** Findings that name a file, grouped by that file. */
  readonly byFile: ReadonlyMap<string, readonly DiagnosticDescriptor[]>;
  /**
   * Findings with no location. Kept, never dropped: a compiler error with no
   * file is still a failing build, and losing it makes the problems view
   * disagree with the terminal.
   */
  readonly unlocated: readonly ValidationFindingSummary[];
}

/** The prefix shown in the problems view, so the producing check is visible. */
export function diagnosticSource(check: string): string {
  return `aica/${check}`;
}

export function toDiagnostics(findings: readonly ValidationFindingSummary[]): DiagnosticGrouping {
  const byFile = new Map<string, DiagnosticDescriptor[]>();
  const unlocated: ValidationFindingSummary[] = [];

  for (const finding of findings) {
    if (!finding.file || finding.line === undefined) {
      unlocated.push(finding);
      continue;
    }

    const descriptor = toDescriptor(finding, finding.file, finding.line);
    const existing = byFile.get(finding.file);
    if (existing) existing.push(descriptor);
    else byFile.set(finding.file, [descriptor]);
  }

  return { byFile, unlocated };
}

function toDescriptor(
  finding: ValidationFindingSummary,
  file: string,
  line: number,
): DiagnosticDescriptor {
  // Tools report 1-based lines. A tool reporting 0 is reporting "no line", not
  // the first line, so it is clamped rather than turned into -1.
  const startLine = Math.max(0, line - 1);
  const hasColumn = finding.column !== undefined && finding.column > 0;
  const startColumn = hasColumn ? Math.max(0, (finding.column as number) - 1) : 0;

  return {
    file,
    startLine,
    startColumn,
    endLine: startLine,
    // Without a column the range runs to a large end column, which VS Code
    // clamps to the real line length — the honest "somewhere on this line".
    endColumn: hasColumn ? startColumn + 1 : Number.MAX_SAFE_INTEGER,
    severity: finding.severity,
    message: withTestName(finding),
    source: diagnosticSource(finding.check),
    ...(finding.code !== undefined ? { code: finding.code } : {}),
    wholeLine: !hasColumn,
  };
}

/**
 * A failing test's name belongs in the message.
 *
 * "expected 2 to be 3" on line 40 of a test file is not actionable on its own
 * when the file holds twenty tests; with the test's name in front of it, it is.
 */
function withTestName(finding: ValidationFindingSummary): string {
  return finding.testName ? `${finding.testName}: ${finding.message}` : finding.message;
}

/** A one-line summary for the status bar. */
export function summarizeValidation(summary: {
  passed: boolean;
  results: readonly { check: string; passed: boolean; skippedReason?: string }[];
  findings: readonly ValidationFindingSummary[];
}): string {
  if (summary.passed) {
    const ran = summary.results.filter((result) => result.skippedReason === undefined);
    // "Passed" with nothing run is the failure mode this whole layer exists to
    // prevent, so the count is always shown.
    return ran.length === 0
      ? 'No checks are configured'
      : `Validation passed (${ran.length} check${ran.length === 1 ? '' : 's'})`;
  }

  const failed = summary.results.find((result) => !result.passed);
  const errors = summary.findings.filter((finding) => finding.severity === 'error').length;

  if (!failed) return 'Validation failed';
  if (failed.skippedReason !== undefined) return `${failed.check} could not run`;

  return errors > 0
    ? `${failed.check} failed — ${errors} error${errors === 1 ? '' : 's'}`
    : `${failed.check} failed`;
}
