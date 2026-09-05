/**
 * Turning tool output back into structured findings.
 *
 * This is the least glamorous and most load-bearing module in the phase. The
 * compiler already knows exactly what is wrong and where; all that stands
 * between that knowledge and a targeted repair is a text format. Parse it well
 * and the repair loop makes one edit. Parse it badly and the agent is handed a
 * wall of text and starts guessing.
 *
 * Three rules:
 *
 * - **Never invent a location.** A line that does not carry `file:line` yields
 *   a finding with no location, which is honest, rather than one attributed to
 *   a plausible file, which is worse than nothing.
 * - **Never drop output.** Anything unparsed that still looks like a failure is
 *   preserved verbatim. A parser that silently swallows an unfamiliar format
 *   reports success on a broken build.
 * - **Prefer machine formats.** Where a tool can emit JSON, the pipeline asks
 *   for it and the text parser is the fallback, not the plan.
 */

import type { ValidationFinding } from './findings.js';
import { FindingSeverity } from './findings.js';

/** Cap on findings kept per check; beyond this they share a root cause. */
const MAX_FINDINGS = 200;

/**
 * `src/api/client.ts(42,17): error TS2741: Property 'amount' is missing.`
 * and the pretty variant `src/api/client.ts:42:17 - error TS2741: ...`.
 */
const TSC_PAREN = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/;
const TSC_COLON = /^(.+?):(\d+):(\d+)\s+-\s+(error|warning)\s+(TS\d+):\s+(.*)$/;

export function parseTypecheck(output: string): ValidationFinding[] {
  const findings: ValidationFinding[] = [];

  for (const line of output.split('\n')) {
    const trimmed = stripAnsi(line).trimEnd();
    if (trimmed.length === 0) continue;

    const match = TSC_PAREN.exec(trimmed) ?? TSC_COLON.exec(trimmed);
    if (match) {
      findings.push({
        check: 'typecheck',
        file: normalizePath(match[1] as string),
        line: Number(match[2]),
        column: Number(match[3]),
        severity: match[4] === 'warning' ? FindingSeverity.warning : FindingSeverity.error,
        code: match[5] as string,
        message: (match[6] as string).trim(),
      });
      continue;
    }

    // `error TS18003: No inputs were found` has no file at all — a real error
    // that a file-anchored parser would drop on the floor.
    const bare = /^\s*(error|warning)\s+(TS\d+):\s+(.*)$/.exec(trimmed);
    if (bare) {
      findings.push({
        check: 'typecheck',
        severity: bare[1] === 'warning' ? FindingSeverity.warning : FindingSeverity.error,
        code: bare[2] as string,
        message: (bare[3] as string).trim(),
      });
    }
  }

  return findings.slice(0, MAX_FINDINGS);
}

/**
 * ESLint's JSON formatter, which is what the pipeline asks for.
 *
 * Falls back to the stylish text format, because a project's own lint script
 * may already pin a formatter and the pipeline should still get findings.
 */
export function parseLint(output: string): ValidationFinding[] {
  const json = parseEslintJson(output);
  if (json) return json.slice(0, MAX_FINDINGS);
  return parseEslintText(output).slice(0, MAX_FINDINGS);
}

interface EslintMessage {
  ruleId?: string | null;
  severity?: number;
  message?: string;
  line?: number;
  column?: number;
}

interface EslintFile {
  filePath?: string;
  messages?: EslintMessage[];
}

function parseEslintJson(output: string): ValidationFinding[] | undefined {
  const start = output.indexOf('[');
  if (start === -1) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(start));
  } catch {
    return undefined;
  }

  if (!Array.isArray(parsed)) return undefined;

  const findings: ValidationFinding[] = [];
  for (const entry of parsed as EslintFile[]) {
    if (typeof entry !== 'object' || entry === null) continue;

    for (const message of entry.messages ?? []) {
      findings.push({
        check: 'lint',
        ...(entry.filePath ? { file: normalizePath(entry.filePath) } : {}),
        ...(typeof message.line === 'number' ? { line: message.line } : {}),
        ...(typeof message.column === 'number' ? { column: message.column } : {}),
        // ESLint severity 2 is an error, 1 a warning.
        severity: message.severity === 1 ? FindingSeverity.warning : FindingSeverity.error,
        ...(message.ruleId ? { code: message.ruleId } : {}),
        message: (message.message ?? 'Lint problem').trim(),
      });
    }
  }

  return findings;
}

/**
 * ESLint's default output puts the file on its own line and indents the
 * problems beneath it, so the current file is carried down the lines.
 */
function parseEslintText(output: string): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  let currentFile: string | undefined;

  for (const raw of output.split('\n')) {
    const line = stripAnsi(raw);
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    if (
      !line.startsWith(' ') &&
      /[/\\]|\.[cm]?[jt]sx?$/.test(trimmed) &&
      !/^\d+:\d+/.test(trimmed)
    ) {
      currentFile = normalizePath(trimmed);
      continue;
    }

    const problem = /^(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}([\w@/-]+))?$/.exec(trimmed);
    if (problem) {
      findings.push({
        check: 'lint',
        ...(currentFile ? { file: currentFile } : {}),
        line: Number(problem[1]),
        column: Number(problem[2]),
        severity: problem[3] === 'warning' ? FindingSeverity.warning : FindingSeverity.error,
        message: (problem[4] as string).trim(),
        ...(problem[5] ? { code: problem[5] } : {}),
      });
    }
  }

  return findings;
}

/**
 * Vitest and Jest output.
 *
 * Both print a failure header naming the test, then an error line, then a stack
 * whose first project frame carries the location. The test *name* matters as
 * much as the location: "should reject an expired token" tells an agent what
 * behaviour broke, which the file and line alone do not.
 */
export function parseTests(output: string): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const lines = output.split('\n').map(stripAnsi);

  for (const [index, line] of lines.entries()) {
    const failure =
      /^\s*(?:FAIL|×|✕|✗)\s+(.+?)(?:\s+\d+ms)?$/.exec(line) ?? /^\s*●\s+(.+)$/.exec(line);
    if (!failure) continue;

    const label = (failure[1] as string).trim();
    if (label.length === 0) continue;

    const detail = nextMeaningfulLine(lines, index + 1);
    const location = findLocation(lines, index + 1);

    findings.push({
      check: 'test',
      severity: FindingSeverity.error,
      testName: label,
      message: detail ?? `Test failed: ${label}`,
      ...(location ?? {}),
    });
  }

  // A run can fail without naming a test — a suite that threw on import, say.
  if (findings.length === 0) {
    const summary = /(\d+) failed/i.exec(output);
    if (summary) {
      findings.push({
        check: 'test',
        severity: FindingSeverity.error,
        message: `${summary[1]} test(s) failed, but no individual failure could be parsed from the output.`,
      });
    }
  }

  return findings.slice(0, MAX_FINDINGS);
}

/** The first line after a failure header that carries the assertion. */
function nextMeaningfulLine(lines: readonly string[], from: number): string | undefined {
  for (let index = from; index < Math.min(from + 6, lines.length); index += 1) {
    const trimmed = (lines[index] ?? '').trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('at ')) continue;
    if (/^[-+]/.test(trimmed)) continue;
    return trimmed.slice(0, 400);
  }
  return undefined;
}

/** The first stack frame pointing into the project rather than a dependency. */
function findLocation(
  lines: readonly string[],
  from: number,
): { file: string; line: number; column?: number } | undefined {
  for (let index = from; index < Math.min(from + 25, lines.length); index += 1) {
    const line = lines[index] ?? '';
    if (line.includes('node_modules')) continue;

    const match =
      /(?:at\s+.*?\(|at\s+)?((?:[A-Za-z]:)?[^\s():]+\.[cm]?[jt]sx?):(\d+)(?::(\d+))?/.exec(line);
    if (!match) continue;

    return {
      file: normalizePath(match[1] as string),
      line: Number(match[2]),
      ...(match[3] ? { column: Number(match[3]) } : {}),
    };
  }
  return undefined;
}

/**
 * Build output, which has no single format.
 *
 * Type errors are recognized because a TypeScript build emits them; anything
 * else that says "error" is kept verbatim. Guessing a structure for an unknown
 * bundler would produce confident nonsense, so this deliberately does less.
 */
export function parseBuild(output: string): ValidationFinding[] {
  const typeErrors = parseTypecheck(output).map((finding) => ({ ...finding, check: 'build' }));
  if (typeErrors.length > 0) return typeErrors;

  const findings: ValidationFinding[] = [];
  for (const raw of output.split('\n')) {
    const line = stripAnsi(raw).trim();
    if (line.length === 0) continue;
    if (!/\b(error|failed|cannot find|unresolved)\b/i.test(line)) continue;
    // A summary line is noise beside the error it summarizes.
    if (/^\d+ errors?$/i.test(line)) continue;

    findings.push({ check: 'build', severity: FindingSeverity.error, message: line.slice(0, 400) });
  }

  return findings.slice(0, MAX_FINDINGS);
}

/**
 * Last resort: a check failed and nothing recognized its output.
 *
 * Returning no findings here would let the pipeline report a failure with
 * nothing to act on, which is the worst possible outcome — so the tail of the
 * output is preserved, where the actual error almost always is.
 */
export function parseUnknown(
  check: string,
  output: string,
  exitCode: number | null,
): ValidationFinding[] {
  const lines = output
    .split('\n')
    .map(stripAnsi)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  const tail = lines.slice(-20).join('\n');

  return [
    {
      check,
      severity: FindingSeverity.error,
      message:
        tail.length > 0
          ? `The ${check} check failed (exit ${exitCode ?? 'null'}). Output:\n${tail.slice(0, 2000)}`
          : `The ${check} check failed with exit ${exitCode ?? 'null'} and produced no output.`,
    },
  ];
}

/** Strip ANSI colour, which every one of these tools emits by default. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

/** Normalize a reported path to workspace-relative POSIX form. */
export function normalizePath(filePath: string): string {
  return filePath
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^[A-Za-z]:\/.*?\/(?=(?:src|packages|apps|test|tests)\/)/, '');
}
