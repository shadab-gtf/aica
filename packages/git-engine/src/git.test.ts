import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isErr, isOk, unwrap } from '@aica/shared';
import { CommandPolicy, PathPolicy } from '@aica/security-engine';
import { CommandExecutor } from '@aica/exec-engine';

import { GitEngine, parsePorcelainV2 } from './git.js';

let root: string;
let git: GitEngine;

const run = (...args: string[]): void => {
  execFileSync('git', args, { cwd: root, stdio: 'pipe' });
};

const file = (relative: string, content: string): void => {
  const absolute = path.join(root, relative);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
};

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'aica-git-'));
  run('init', '--quiet');
  run('config', 'user.email', 'agent@example.test');
  run('config', 'user.name', 'Test Agent');
  run('config', 'commit.gpgsign', 'false');

  file('src/app.ts', 'export const a = 1;\n');
  file('README.md', '# Fixture\n');
  run('add', '.');
  run('commit', '--quiet', '--message', 'initial commit');

  git = new GitEngine({
    executor: new CommandExecutor({
      pathPolicy: new PathPolicy({ root }),
      commandPolicy: new CommandPolicy(),
    }),
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('repository detection', () => {
  it('recognises a working tree', async () => {
    expect(await git.isRepository()).toBe(true);
  });

  it('reports a non-repository without failing', async () => {
    const bare = mkdtempSync(path.join(tmpdir(), 'aica-nogit-'));
    const outside = new GitEngine({
      executor: new CommandExecutor({
        pathPolicy: new PathPolicy({ root: bare }),
        commandPolicy: new CommandPolicy(),
      }),
    });
    const status = unwrap(await outside.status());
    expect(status.isRepository).toBe(false);
    expect(status.dirty).toBe(false);
    rmSync(bare, { recursive: true, force: true });
  });
});

describe('status', () => {
  it('reports a clean tree', async () => {
    const status = unwrap(await git.status());
    expect(status.dirty).toBe(false);
    expect(status.entries).toHaveLength(0);
    expect(status.branch).toBeTruthy();
  });

  it('detects an unstaged modification', async () => {
    file('src/app.ts', 'export const a = 2;\n');
    const status = unwrap(await git.status());
    expect(status.dirty).toBe(true);
    const entry = status.entries.find((e) => e.path === 'src/app.ts');
    expect(entry).toMatchObject({ status: 'modified', unstaged: true, staged: false });
  });

  it('detects a staged addition', async () => {
    file('src/new.ts', 'export const b = 1;\n');
    run('add', 'src/new.ts');
    const status = unwrap(await git.status());
    const entry = status.entries.find((e) => e.path === 'src/new.ts');
    expect(entry).toMatchObject({ status: 'added', staged: true });
  });

  it('detects an untracked file', async () => {
    file('src/scratch.ts', 'export {};\n');
    const status = unwrap(await git.status());
    expect(status.entries.find((e) => e.path === 'src/scratch.ts')?.status).toBe('untracked');
  });

  it('detects a deletion', async () => {
    rmSync(path.join(root, 'README.md'));
    const status = unwrap(await git.status());
    expect(status.entries.find((e) => e.path === 'README.md')?.status).toBe('deleted');
  });

  it('handles a path containing spaces', async () => {
    file('src/my component.tsx', 'export default null;\n');
    const status = unwrap(await git.status());
    expect(status.entries.map((e) => e.path)).toContain('src/my component.tsx');
  });
});

describe('diff', () => {
  it('returns a unified diff of unstaged work', async () => {
    file('src/app.ts', 'export const a = 42;\n');
    const diff = unwrap(await git.diff());
    expect(diff).toContain('-export const a = 1;');
    expect(diff).toContain('+export const a = 42;');
  });

  it('returns an empty diff for a clean tree', async () => {
    expect(unwrap(await git.diff()).trim()).toBe('');
  });

  it('scopes a diff to given paths', async () => {
    file('src/app.ts', 'export const a = 2;\n');
    file('README.md', '# Changed\n');
    const diff = unwrap(await git.diff({ paths: ['README.md'] }));
    expect(diff).toContain('README.md');
    expect(diff).not.toContain('src/app.ts');
  });

  it('lists changed file names for impact analysis', async () => {
    file('src/app.ts', 'export const a = 3;\n');
    expect(unwrap(await git.changedFiles())).toEqual(['src/app.ts']);
  });
});

describe('log', () => {
  it('reads commit metadata', async () => {
    const commits = unwrap(await git.log({ limit: 5 }));
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({ subject: 'initial commit', author: 'Test Agent' });
    expect(commits[0]?.hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it('parses a subject containing separators and punctuation', async () => {
    file('src/app.ts', 'export const a = 9;\n');
    run('add', 'src/app.ts');
    run('commit', '--quiet', '--message', 'fix: handle a|b, c;d and "quotes"');
    const commits = unwrap(await git.log({ limit: 1 }));
    expect(commits[0]?.subject).toBe('fix: handle a|b, c;d and "quotes"');
  });
});

describe('branches', () => {
  it('reports the current branch and lists branches', async () => {
    const current = unwrap(await git.currentBranch());
    expect(current.length).toBeGreaterThan(0);
    expect(unwrap(await git.listBranches())).toContain(current);
  });
});

describe('staging and committing', () => {
  it('stages named paths and commits them', async () => {
    file('src/app.ts', 'export const a = 7;\n');
    expect(isOk(await git.stage(['src/app.ts']))).toBe(true);

    const commit = unwrap(await git.commit('feat: bump the constant'));
    expect(commit.subject).toBe('feat: bump the constant');

    const status = unwrap(await git.status());
    expect(status.dirty).toBe(false);
  });

  it('refuses to stage everything, so unrelated work is not swept in', async () => {
    for (const argument of ['.', '-A', '--all', '*']) {
      const result = await git.stage([argument]);
      expect(isErr(result), argument).toBe(true);
      expect(isErr(result) && result.error.message).toMatch(/Refusing to stage everything/i);
    }
  });

  it('leaves an unrelated user change uncommitted when staging specific files', async () => {
    file('src/app.ts', 'export const a = 5;\n');
    file('README.md', '# User was editing this\n');

    await git.stage(['src/app.ts']);
    await git.commit('feat: only the agent change');

    const status = unwrap(await git.status());
    const readme = status.entries.find((e) => e.path === 'README.md');
    expect(readme?.status).toBe('modified');
  });

  it('rejects an empty commit message', async () => {
    expect(isErr(await git.commit('   '))).toBe(true);
  });

  it('reports that there is nothing staged rather than failing obscurely', async () => {
    const result = await git.commit('nothing here');
    expect(isErr(result) && result.error.message).toMatch(/nothing staged/i);
  });

  it('rejects an empty path list', async () => {
    expect(isErr(await git.stage([]))).toBe(true);
  });
});

describe('destructive operations are absent, not merely discouraged', () => {
  it('has no method that resets, cleans, or force-pushes', () => {
    const surface = Object.getOwnPropertyNames(GitEngine.prototype);
    for (const forbidden of ['reset', 'clean', 'push', 'forcePush', 'checkout', 'rebase']) {
      expect(surface).not.toContain(forbidden);
    }
  });

  it('blocks those commands at the executor even if something tried', async () => {
    const executor = new CommandExecutor({
      pathPolicy: new PathPolicy({ root }),
      commandPolicy: new CommandPolicy(),
    });
    for (const args of [
      ['reset', '--hard', 'HEAD'],
      ['clean', '-fd'],
      ['push', '--force'],
    ]) {
      const result = await executor.run({ program: 'git', args });
      expect(isErr(result), args.join(' ')).toBe(true);
    }
  });

  it('leaves the working tree intact after a blocked reset attempt', async () => {
    file('src/app.ts', 'export const a = 999;\n');
    const executor = new CommandExecutor({
      pathPolicy: new PathPolicy({ root }),
      commandPolicy: new CommandPolicy(),
    });
    await executor.run({ program: 'git', args: ['reset', '--hard', 'HEAD'] });

    const status = unwrap(await git.status());
    expect(status.dirty).toBe(true);
  });
});

describe('parsePorcelainV2', () => {
  it('reads branch, ahead, and behind counts', () => {
    const status = parsePorcelainV2(
      [
        '# branch.oid abc123',
        '# branch.head feature/checkout',
        '# branch.upstream origin/feature/checkout',
        '# branch.ab +2 -3',
      ].join('\n'),
    );
    expect(status.branch).toBe('feature/checkout');
    expect(status.ahead).toBe(2);
    expect(status.behind).toBe(3);
    expect(status.detached).toBe(false);
  });

  it('recognises a detached HEAD', () => {
    const status = parsePorcelainV2('# branch.head (detached)');
    expect(status.detached).toBe(true);
    expect(status.branch).toBeUndefined();
  });

  it('parses a rename with its original path', () => {
    const status = parsePorcelainV2(
      '2 R. N... 100644 100644 100644 aaa bbb R100 src/new.ts\tsrc/old.ts',
    );
    expect(status.entries[0]).toMatchObject({
      status: 'renamed',
      path: 'src/new.ts',
      originalPath: 'src/old.ts',
    });
  });

  it('flags merge conflicts', () => {
    const status = parsePorcelainV2(
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflict.ts',
    );
    expect(status.hasConflicts).toBe(true);
    expect(status.entries[0]?.status).toBe('conflicted');
  });

  it('does not treat an ignored file as dirty', () => {
    const status = parsePorcelainV2('! dist/bundle.js');
    expect(status.dirty).toBe(false);
    expect(status.entries[0]?.status).toBe('ignored');
  });
});
