import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode, isErr, isOk, unwrap } from '@aica/shared';
import { PathPolicy, Redactor } from '@aica/security-engine';

import { applyUnifiedDiff, computeStat, formatUnifiedDiff, parseUnifiedDiff } from './diff.js';
import { PatchEngine, hashContent, makePatch } from './patch.js';
import { WorkspaceReader, matchesGlob } from './reader.js';

let root: string;

const file = (relative: string, content: string): void => {
  const absolute = path.join(root, relative);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
};

const read = (relative: string): string => readFileSync(path.join(root, relative), 'utf8');
const policy = (): PathPolicy => new PathPolicy({ root });
const engine = (): PatchEngine => new PatchEngine({ pathPolicy: policy() });
const reader = (redactor?: Redactor): WorkspaceReader =>
  new WorkspaceReader({ pathPolicy: policy(), ...(redactor ? { redactor } : {}) });

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'aica-fs-'));
  file('src/app.ts', 'const status = "pending";\nexport default status;\n');
  file('src/client.ts', 'export const baseUrl = "https://api.example.com";\n');
  file('.env', 'SECRET=abcdef123456\n');
  file('node_modules/react/index.js', 'module.exports = {};\n');
  file('README.md', '# Project\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('line diffing', () => {
  it('counts added and removed lines', () => {
    const stat = computeStat('a\nb\nc\n', 'a\nB\nc\nd\n');
    expect(stat).toEqual({ linesAdded: 2, linesRemoved: 1 });
  });

  it('reports no change for identical content', () => {
    expect(computeStat('a\nb\n', 'a\nb\n')).toEqual({ linesAdded: 0, linesRemoved: 0 });
    expect(formatUnifiedDiff('a\nb\n', 'a\nb\n')).toBe('');
  });

  it('produces a unified diff with conventional headers and hunks', () => {
    const diff = formatUnifiedDiff('one\ntwo\nthree\n', 'one\nTWO\nthree\n', {
      oldPath: 'a/f.ts',
      newPath: 'b/f.ts',
    });
    expect(diff).toContain('--- a/f.ts');
    expect(diff).toContain('+++ b/f.ts');
    expect(diff).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
    expect(diff).toContain('-two');
    expect(diff).toContain('+TWO');
    expect(diff).toContain(' one');
  });

  it('round-trips: a generated diff reapplies to produce the same result', () => {
    const before = 'a\nb\nc\nd\ne\nf\ng\n';
    const after = 'a\nb\nCHANGED\nd\ne\nf\nG\n';
    const diff = formatUnifiedDiff(before, after);
    const parsed = parseUnifiedDiff(diff);
    expect('hunks' in parsed).toBe(true);
    const applied = applyUnifiedDiff(before, (parsed as { hunks: never[] }).hunks);
    expect(applied.ok && applied.content).toBe(after);
  });

  it('refuses a diff whose context does not match the file', () => {
    const diff = formatUnifiedDiff('a\nb\nc\n', 'a\nB\nc\n');
    const parsed = parseUnifiedDiff(diff);
    const applied = applyUnifiedDiff(
      'completely\ndifferent\nfile\n',
      (parsed as { hunks: never[] }).hunks,
    );
    expect(applied.ok).toBe(false);
    expect(!applied.ok && applied.error).toMatch(/context mismatch/i);
  });

  it('reports a diff with no hunks rather than silently doing nothing', () => {
    const parsed = parseUnifiedDiff('not a diff at all');
    expect('error' in parsed).toBe(true);
  });

  it('handles insertion into an empty file and deletion to empty', () => {
    expect(computeStat('', 'new\n')).toEqual({ linesAdded: 1, linesRemoved: 0 });
    expect(computeStat('old\n', '')).toEqual({ linesAdded: 0, linesRemoved: 1 });
  });
});

describe('anchored edits', () => {
  it('applies an exact anchor and reports the change', async () => {
    const patch = makePatch('align status with the API contract', [
      {
        path: 'src/app.ts',
        operation: { kind: 'edit', edits: [{ oldText: '"pending"', newText: '"processing"' }] },
      },
    ]);

    const applied = unwrap(await engine().apply(patch));
    expect(read('src/app.ts')).toContain('"processing"');
    expect(applied.files[0]).toMatchObject({ path: 'src/app.ts', kind: 'modified' });
    expect(applied.diff).toContain('+const status = "processing";');
  });

  it('refuses an anchor that is not present, and writes nothing', async () => {
    const before = read('src/app.ts');
    const result = await engine().apply(
      makePatch('bad anchor', [
        {
          path: 'src/app.ts',
          operation: { kind: 'edit', edits: [{ oldText: 'not in the file', newText: 'x' }] },
        },
      ]),
    );
    expect(isErr(result) && result.error.code).toBe(ErrorCode.PRECONDITION_FAILED);
    expect(read('src/app.ts')).toBe(before);
  });

  it('refuses an ambiguous anchor rather than guessing which occurrence was meant', async () => {
    file('src/dup.ts', 'const a = 1;\nconst b = 2;\nconst a = 1;\n');
    const result = await engine().apply(
      makePatch('ambiguous', [
        {
          path: 'src/dup.ts',
          operation: {
            kind: 'edit',
            edits: [{ oldText: 'const a = 1;', newText: 'const a = 9;' }],
          },
        },
      ]),
    );
    expect(isErr(result) && result.error.code).toBe(ErrorCode.CONFLICT);
    expect(isErr(result) && result.error.message).toMatch(/appears 2 times/);
  });

  it('replaces every occurrence when explicitly asked', async () => {
    file('src/dup.ts', 'const a = 1;\nconst b = 2;\nconst a = 1;\n');
    await engine().apply(
      makePatch('rename all', [
        {
          path: 'src/dup.ts',
          operation: {
            kind: 'edit',
            edits: [{ oldText: 'const a = 1;', newText: 'const a = 9;', replaceAll: true }],
          },
        },
      ]),
    );
    expect(read('src/dup.ts')).toBe('const a = 9;\nconst b = 2;\nconst a = 9;\n');
  });

  it('applies several sequential edits to one file', async () => {
    await engine().apply(
      makePatch('two edits', [
        {
          path: 'src/app.ts',
          operation: {
            kind: 'edit',
            edits: [
              { oldText: '"pending"', newText: '"processing"' },
              { oldText: 'export default status;', newText: 'export { status };' },
            ],
          },
        },
      ]),
    );
    const content = read('src/app.ts');
    expect(content).toContain('"processing"');
    expect(content).toContain('export { status };');
  });

  it('rejects an empty anchor and a no-op replacement', async () => {
    const empty = await engine().apply(
      makePatch('empty anchor', [
        { path: 'src/app.ts', operation: { kind: 'edit', edits: [{ oldText: '', newText: 'x' }] } },
      ]),
    );
    expect(isErr(empty) && empty.error.code).toBe(ErrorCode.INVALID_INPUT);

    const same = await engine().apply(
      makePatch('same text', [
        {
          path: 'src/app.ts',
          operation: { kind: 'edit', edits: [{ oldText: 'status', newText: 'status' }] },
        },
      ]),
    );
    expect(isErr(same)).toBe(true);
  });
});

describe('hash preconditions', () => {
  it('applies when the hash matches what was read', async () => {
    const current = unwrap(await reader().read('src/app.ts'));
    const result = await engine().apply(
      makePatch('safe edit', [
        {
          path: 'src/app.ts',
          expectedHash: current.hash,
          operation: { kind: 'edit', edits: [{ oldText: '"pending"', newText: '"done"' }] },
        },
      ]),
    );
    expect(isOk(result)).toBe(true);
  });

  it('refuses when the file changed underneath the agent, preserving user edits', async () => {
    const stale = hashContent('const status = "pending";\nexport default status;\n');
    file('src/app.ts', 'const status = "pending";\n// the user was typing here\n');

    const result = await engine().apply(
      makePatch('stale edit', [
        {
          path: 'src/app.ts',
          expectedHash: stale,
          operation: { kind: 'edit', edits: [{ oldText: '"pending"', newText: '"done"' }] },
        },
      ]),
    );

    expect(isErr(result) && result.error.code).toBe(ErrorCode.PRECONDITION_FAILED);
    expect(isErr(result) && result.error.message).toMatch(/changed since it was read/i);
    // The user's line survives untouched.
    expect(read('src/app.ts')).toContain('the user was typing here');
  });
});

describe('create, replace, delete', () => {
  it('creates a new file, including intermediate directories', async () => {
    const applied = unwrap(
      await engine().apply(
        makePatch('add a service', [
          {
            path: 'src/services/payments.ts',
            operation: { kind: 'create', content: 'export const createPayment = () => {};\n' },
          },
        ]),
      ),
    );
    expect(read('src/services/payments.ts')).toContain('createPayment');
    expect(applied.files[0]?.kind).toBe('created');
  });

  it('refuses to create over an existing file', async () => {
    const result = await engine().apply(
      makePatch('clobber', [
        { path: 'src/app.ts', operation: { kind: 'create', content: 'overwritten\n' } },
      ]),
    );
    expect(isErr(result) && result.error.code).toBe(ErrorCode.ALREADY_EXISTS);
    expect(read('src/app.ts')).toContain('pending');
  });

  it('deletes a file and reports it', async () => {
    const applied = unwrap(
      await engine().apply(
        makePatch('remove dead code', [{ path: 'README.md', operation: { kind: 'delete' } }]),
      ),
    );
    expect(applied.files[0]?.kind).toBe('deleted');
    expect(() => read('README.md')).toThrow();
  });

  it('refuses to delete something that is not there', async () => {
    const result = await engine().apply(
      makePatch('remove missing', [{ path: 'nope.md', operation: { kind: 'delete' } }]),
    );
    expect(isErr(result) && result.error.code).toBe(ErrorCode.NOT_FOUND);
  });
});

describe('patch safety', () => {
  it('refuses to write outside the project', async () => {
    const result = await engine().apply(
      makePatch('escape', [
        { path: '../evil.ts', operation: { kind: 'create', content: 'nope\n' } },
      ]),
    );
    expect(isErr(result) && result.error.code).toBe(ErrorCode.PERMISSION_DENIED);
  });

  it('refuses to modify a credentials file', async () => {
    const result = await engine().apply(
      makePatch('touch env', [
        { path: '.env', operation: { kind: 'replace', content: 'SECRET=other\n' } },
      ]),
    );
    expect(isErr(result) && result.error.code).toBe(ErrorCode.PERMISSION_DENIED);
  });

  it('refuses a patch that addresses the same file twice', async () => {
    const result = await engine().apply(
      makePatch('duplicate target', [
        {
          path: 'src/app.ts',
          operation: { kind: 'edit', edits: [{ oldText: '"pending"', newText: '"a"' }] },
        },
        {
          path: 'src/app.ts',
          operation: { kind: 'edit', edits: [{ oldText: 'status', newText: 'state' }] },
        },
      ]),
    );
    expect(isErr(result) && result.error.message).toMatch(/more than once/i);
  });

  it('refuses an empty patch', async () => {
    expect(isErr(await engine().apply(makePatch('nothing', [])))).toBe(true);
  });

  it('enforces a file-count limit so a patch stays reviewable', async () => {
    const small = new PatchEngine({ pathPolicy: policy(), maxFiles: 2 });
    const files = ['a.ts', 'b.ts', 'c.ts'].map((name) => ({
      path: `src/${name}`,
      operation: { kind: 'create' as const, content: 'export {};\n' },
    }));
    const result = await small.apply(makePatch('too many', files));
    expect(isErr(result) && result.error.code).toBe(ErrorCode.LIMIT_EXCEEDED);
  });
});

describe('transactional application', () => {
  it('leaves the tree untouched when a later file in the patch is invalid', async () => {
    const beforeApp = read('src/app.ts');

    const result = await engine().apply(
      makePatch('one good, one bad', [
        {
          path: 'src/app.ts',
          operation: { kind: 'edit', edits: [{ oldText: '"pending"', newText: '"processing"' }] },
        },
        {
          path: 'src/client.ts',
          operation: { kind: 'edit', edits: [{ oldText: 'anchor that is absent', newText: 'x' }] },
        },
      ]),
    );

    expect(isErr(result)).toBe(true);
    // Staging validates everything before writing anything, so the first file
    // was never modified.
    expect(read('src/app.ts')).toBe(beforeApp);
  });

  it('applies a valid multi-file patch atomically', async () => {
    const applied = unwrap(
      await engine().apply(
        makePatch('two files', [
          {
            path: 'src/app.ts',
            operation: { kind: 'edit', edits: [{ oldText: '"pending"', newText: '"processing"' }] },
          },
          {
            path: 'src/types.ts',
            operation: { kind: 'create', content: 'export type Status = "processing";\n' },
          },
        ]),
      ),
    );
    expect(applied.files).toHaveLength(2);
    expect(read('src/app.ts')).toContain('processing');
    expect(read('src/types.ts')).toContain('Status');
  });
});

describe('preview', () => {
  it('computes the diff without writing anything', async () => {
    const before = read('src/app.ts');
    const preview = unwrap(
      await engine().preview(
        makePatch('proposed', [
          {
            path: 'src/app.ts',
            operation: { kind: 'edit', edits: [{ oldText: '"pending"', newText: '"processing"' }] },
          },
        ]),
      ),
    );
    expect(preview.diff).toContain('+const status = "processing";');
    expect(preview.rationale).toBe('proposed');
    expect(read('src/app.ts')).toBe(before);
  });

  it('fails at preview time for the same reasons it would fail at apply time', async () => {
    const result = await engine().preview(
      makePatch('bad', [
        {
          path: 'src/app.ts',
          operation: { kind: 'edit', edits: [{ oldText: 'absent', newText: 'x' }] },
        },
      ]),
    );
    expect(isErr(result)).toBe(true);
  });
});

describe('WorkspaceReader.list', () => {
  it('lists a directory and skips ignored trees', async () => {
    const listed = unwrap(await reader().list('.', { recursive: true }));
    const paths = listed.entries.map((entry) => entry.path);
    expect(paths).toContain('src/app.ts');
    expect(paths.some((p) => p.startsWith('node_modules'))).toBe(false);
  });

  it('marks a listing truncated at the entry cap', async () => {
    for (let i = 0; i < 30; i += 1) file(`src/gen/f${i}.ts`, 'export {};\n');
    const listed = unwrap(await reader().list('.', { recursive: true, maxEntries: 5 }));
    expect(listed.truncated).toBe(true);
    expect(listed.entries).toHaveLength(5);
  });

  it('reports a missing directory', async () => {
    expect(isErr(await reader().list('does/not/exist'))).toBe(true);
  });
});

describe('WorkspaceReader.read', () => {
  it('returns content, a usable hash, and line metadata', async () => {
    const result = unwrap(await reader().read('src/app.ts'));
    expect(result.content).toContain('pending');
    expect(result.hash).toBe(hashContent(read('src/app.ts')));
    expect(result.truncated).toBe(false);
  });

  it('returns a line range and marks it truncated', async () => {
    file('src/long.ts', Array.from({ length: 50 }, (_, i) => `line${i + 1}`).join('\n'));
    const result = unwrap(await reader().read('src/long.ts', { startLine: 10, maxLines: 5 }));
    expect(result.content.split('\n')).toHaveLength(5);
    expect(result.content).toContain('line10');
    expect(result.truncated).toBe(true);
    // The hash still describes the whole file, so it works as a precondition.
    expect(result.hash).toBe(hashContent(read('src/long.ts')));
  });

  it('refuses to read a credentials file', async () => {
    const result = await reader().read('.env');
    expect(isErr(result) && result.error.code).toBe(ErrorCode.PERMISSION_DENIED);
  });

  it('refuses a file above the read size limit', async () => {
    file('src/huge.ts', 'x'.repeat(600 * 1024));
    const result = await reader().read('src/huge.ts');
    expect(isErr(result) && result.error.code).toBe(ErrorCode.LIMIT_EXCEEDED);
  });

  it('redacts secrets found in ordinary source', async () => {
    file('src/leaky.ts', 'const key = "sk_live_51H8xQ2abcdefghijklmno";\n');
    const redactor = new Redactor();
    const result = unwrap(await reader(redactor).read('src/leaky.ts'));
    expect(result.content).not.toContain('sk_live_51H8xQ2abcdefghijklmno');
    expect(result.content).toContain('[REDACTED]');
  });

  it('reports a missing file', async () => {
    expect(isErr(await reader().read('src/missing.ts'))).toBe(true);
  });
});

describe('WorkspaceReader.search', () => {
  it('finds matches with file and line numbers', async () => {
    const result = unwrap(await reader().search('baseUrl'));
    expect(result.matches[0]).toMatchObject({ path: 'src/client.ts', line: 1 });
  });

  it('filters by include glob', async () => {
    file('docs/notes.md', 'baseUrl appears here too\n');
    const result = unwrap(await reader().search('baseUrl', { include: ['**/*.ts'] }));
    expect(result.matches.every((match) => match.path.endsWith('.ts'))).toBe(true);
  });

  it('never searches inside credential files', async () => {
    const result = unwrap(await reader().search('SECRET'));
    expect(result.matches.some((match) => match.path === '.env')).toBe(false);
  });

  it('caps matches and marks the result truncated', async () => {
    for (let i = 0; i < 20; i += 1) file(`src/many/f${i}.ts`, 'needle\nneedle\n');
    const result = unwrap(await reader().search('needle', { maxMatches: 5 }));
    expect(result.matches).toHaveLength(5);
    expect(result.truncated).toBe(true);
  });

  it('reports an invalid regular expression instead of throwing', async () => {
    const result = await reader().search('([unclosed');
    expect(isErr(result) && result.error.code).toBe(ErrorCode.INVALID_INPUT);
  });
});

describe('glob matching', () => {
  it.each([
    ['src/app.ts', '**/*.ts', true],
    ['app.ts', '**/*.ts', true],
    ['src/a/b/c.tsx', '**/*.{ts,tsx}', true],
    ['src/app.js', '**/*.ts', false],
    ['src/app.ts', 'src/*.ts', true],
    ['src/a/app.ts', 'src/*.ts', false],
    ['src/ap.ts', 'src/a?.ts', true],
  ])('%s against %s is %s', (filePath, pattern, expected) => {
    expect(matchesGlob(filePath, pattern)).toBe(expected);
  });
});
