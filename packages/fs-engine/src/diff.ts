/**
 * Line diffing and unified-diff handling.
 *
 * The agent must show a verified diff before anything is accepted
 * (specification section 36), so diffing is a first-class deterministic
 * capability rather than something delegated to `git diff` — a patch is
 * reviewed before it touches the working tree, at which point Git has nothing
 * to compare against.
 */

export interface DiffStat {
  readonly linesAdded: number;
  readonly linesRemoved: number;
}

export interface Hunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  /** Lines prefixed with ' ', '-', or '+'. */
  readonly lines: readonly string[];
}

/** Split into lines, keeping the information needed to round-trip exactly. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  // A trailing newline produces a final empty element that is not a line.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

type Op = { kind: 'equal' | 'insert' | 'delete'; line: string };

/**
 * Longest-common-subsequence line diff.
 *
 * Guarded by size: the table is quadratic, so beyond the guard the comparison
 * degrades to a whole-file replacement rather than consuming unbounded memory.
 * Real source files are far below the guard; generated bundles are not, and
 * those are not what the agent edits.
 */
const LCS_GUARD = 4_000;

export function diffLines(before: readonly string[], after: readonly string[]): Op[] {
  if (before.length === 0 && after.length === 0) return [];
  if (before.length === 0) return after.map((line) => ({ kind: 'insert', line }));
  if (after.length === 0) return before.map((line) => ({ kind: 'delete', line }));

  if (before.length > LCS_GUARD || after.length > LCS_GUARD) {
    return [
      ...before.map((line): Op => ({ kind: 'delete', line })),
      ...after.map((line): Op => ({ kind: 'insert', line })),
    ];
  }

  // Trim the common prefix and suffix first; most edits are local, so this
  // reduces the table to a fraction of the file.
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const beforeMid = before.slice(prefix, before.length - suffix);
  const afterMid = after.slice(prefix, after.length - suffix);

  const rows = beforeMid.length;
  const cols = afterMid.length;
  const table: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(cols + 1).fill(0),
  );

  for (let i = rows - 1; i >= 0; i -= 1) {
    const row = table[i] as number[];
    const next = table[i + 1] as number[];
    for (let j = cols - 1; j >= 0; j -= 1) {
      row[j] =
        beforeMid[i] === afterMid[j]
          ? (next[j + 1] as number) + 1
          : Math.max(next[j] as number, row[j + 1] as number);
    }
  }

  const ops: Op[] = [];
  for (let k = 0; k < prefix; k += 1) ops.push({ kind: 'equal', line: before[k] as string });

  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (beforeMid[i] === afterMid[j]) {
      ops.push({ kind: 'equal', line: beforeMid[i] as string });
      i += 1;
      j += 1;
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      ops.push({ kind: 'delete', line: beforeMid[i] as string });
      i += 1;
    } else {
      ops.push({ kind: 'insert', line: afterMid[j] as string });
      j += 1;
    }
  }
  while (i < rows) {
    ops.push({ kind: 'delete', line: beforeMid[i] as string });
    i += 1;
  }
  while (j < cols) {
    ops.push({ kind: 'insert', line: afterMid[j] as string });
    j += 1;
  }

  for (let k = after.length - suffix; k < after.length; k += 1) {
    ops.push({ kind: 'equal', line: after[k] as string });
  }

  return ops;
}

export function computeStat(before: string, after: string): DiffStat {
  const ops = diffLines(splitLines(before), splitLines(after));
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const op of ops) {
    if (op.kind === 'insert') linesAdded += 1;
    else if (op.kind === 'delete') linesRemoved += 1;
  }
  return { linesAdded, linesRemoved };
}

export interface UnifiedDiffOptions {
  readonly oldPath?: string;
  readonly newPath?: string;
  readonly context?: number;
}

/**
 * Render a unified diff. This is what the user reviews, so hunk headers and
 * context match the conventional format that editors and reviewers expect.
 */
export function formatUnifiedDiff(
  before: string,
  after: string,
  options: UnifiedDiffOptions = {},
): string {
  const context = options.context ?? 3;
  const oldPath = options.oldPath ?? 'a';
  const newPath = options.newPath ?? 'b';

  if (before === after) return '';

  const ops = diffLines(splitLines(before), splitLines(after));
  const hunks = groupIntoHunks(ops, context);
  if (hunks.length === 0) return '';

  const out: string[] = [`--- ${oldPath}`, `+++ ${newPath}`];
  for (const hunk of hunks) {
    out.push(
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      ...hunk.lines,
    );
  }
  return `${out.join('\n')}\n`;
}

function groupIntoHunks(ops: readonly Op[], context: number): Hunk[] {
  const changedIndices = ops
    .map((op, index) => (op.kind === 'equal' ? -1 : index))
    .filter((index) => index >= 0);
  if (changedIndices.length === 0) return [];

  // Group changes that are within 2*context of each other into one hunk.
  const groups: Array<{ start: number; end: number }> = [];
  for (const index of changedIndices) {
    const last = groups[groups.length - 1];
    if (last && index - last.end <= context * 2) last.end = index;
    else groups.push({ start: index, end: index });
  }

  const hunks: Hunk[] = [];
  let oldLine = 1;
  let newLine = 1;
  let cursor = 0;

  for (const group of groups) {
    const from = Math.max(0, group.start - context);
    const to = Math.min(ops.length - 1, group.end + context);

    // Advance line counters over everything before this hunk.
    for (; cursor < from; cursor += 1) {
      const op = ops[cursor] as Op;
      if (op.kind !== 'insert') oldLine += 1;
      if (op.kind !== 'delete') newLine += 1;
    }

    const lines: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    for (let index = from; index <= to; index += 1) {
      const op = ops[index] as Op;
      if (op.kind === 'equal') {
        lines.push(` ${op.line}`);
        oldCount += 1;
        newCount += 1;
      } else if (op.kind === 'delete') {
        lines.push(`-${op.line}`);
        oldCount += 1;
      } else {
        lines.push(`+${op.line}`);
        newCount += 1;
      }
    }

    hunks.push({
      oldStart: oldCount === 0 ? oldLine - 1 : oldLine,
      oldLines: oldCount,
      newStart: newCount === 0 ? newLine - 1 : newLine,
      newLines: newCount,
      lines,
    });

    for (; cursor <= to; cursor += 1) {
      const op = ops[cursor] as Op;
      if (op.kind !== 'insert') oldLine += 1;
      if (op.kind !== 'delete') newLine += 1;
    }
  }

  return hunks;
}

export interface ParsedUnifiedDiff {
  readonly hunks: readonly Hunk[];
}

/**
 * Parse a unified diff body. Only hunks are interpreted; file headers are
 * ignored because the target path is supplied explicitly by the caller rather
 * than trusted from inside the diff text.
 */
export function parseUnifiedDiff(diff: string): ParsedUnifiedDiff | { error: string } {
  const lines = diff.split('\n');
  // A well-formed diff ends with a newline, which leaves a trailing empty
  // element. It is a line terminator, not a content line, and treating it as
  // one would append a phantom context line to the final hunk.
  if (lines[lines.length - 1] === '') lines.pop();

  const hunks: Hunk[] = [];
  let current: { header: RegExpExecArray; lines: string[] } | undefined;

  const flush = (): void => {
    if (!current) return;
    const [, oldStart, oldLines, newStart, newLines] = current.header;
    hunks.push({
      oldStart: Number(oldStart),
      oldLines: oldLines === undefined ? 1 : Number(oldLines),
      newStart: Number(newStart),
      newLines: newLines === undefined ? 1 : Number(newLines),
      lines: current.lines,
    });
    current = undefined;
  };

  for (const line of lines) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      flush();
      current = { header, lines: [] };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff ')) continue;
    if (line === '\\ No newline at end of file') continue;
    if (line === '') {
      // A bare empty line inside a hunk is an unchanged empty line.
      current.lines.push(' ');
      continue;
    }
    if (/^[ +-]/.test(line)) current.lines.push(line);
  }
  flush();

  if (hunks.length === 0) return { error: 'No hunks found in the diff.' };
  return { hunks };
}

/**
 * Apply a parsed unified diff to content.
 *
 * Context lines are verified rather than assumed: if the file does not match
 * the diff's context, the application fails instead of writing something the
 * diff did not describe. That check is what makes an LLM-produced diff safe to
 * apply at all.
 */
export function applyUnifiedDiff(
  content: string,
  hunks: readonly Hunk[],
): { ok: true; content: string } | { ok: false; error: string } {
  const original = splitLines(content);
  const out: string[] = [];
  let cursor = 0;

  for (const hunk of hunks) {
    const target = hunk.oldStart - 1;
    if (target < cursor) {
      return { ok: false, error: `Hunk at line ${hunk.oldStart} overlaps a previous hunk.` };
    }
    if (target > original.length) {
      return {
        ok: false,
        error: `Hunk starts at line ${hunk.oldStart}, past the end of a ${original.length}-line file.`,
      };
    }

    out.push(...original.slice(cursor, target));
    cursor = target;

    for (const line of hunk.lines) {
      const marker = line[0];
      const text = line.slice(1);

      if (marker === '+') {
        out.push(text);
        continue;
      }

      const actual = original[cursor];
      if (actual === undefined) {
        return {
          ok: false,
          error: `Hunk expected "${text}" at line ${cursor + 1} but the file ends there.`,
        };
      }
      if (actual !== text) {
        return {
          ok: false,
          error: `Context mismatch at line ${cursor + 1}: expected "${text}", found "${actual}". The file has changed since the diff was produced.`,
        };
      }

      if (marker === ' ') out.push(actual);
      cursor += 1;
    }
  }

  out.push(...original.slice(cursor));
  const endsWithNewline = content === '' || content.endsWith('\n');
  return {
    ok: true,
    content: out.length === 0 ? '' : out.join('\n') + (endsWithNewline ? '\n' : ''),
  };
}
