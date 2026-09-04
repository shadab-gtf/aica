import { describe, expect, it } from 'vitest';
import { ErrorCode, isErr, isOk, unwrap } from '@aica/shared';

import { CommandPolicy, renderForDisplay, type CommandSpec } from './commands.js';

const policy = new CommandPolicy();

const spec = (program: string, ...args: string[]): CommandSpec => ({ program, args });

describe('allowlisting', () => {
  it('permits an allowlisted program with a permitted subcommand', () => {
    const verdict = unwrap(policy.check(spec('pnpm', 'run', 'test')));
    expect(verdict.rule.program).toBe('pnpm');
    expect(verdict.risk).toBe('LOW_RISK_WRITE');
  });

  it('refuses a program that is not allowlisted', () => {
    const result = policy.check(spec('mysterious-binary', '--help'));
    expect(isErr(result) && result.error.code).toBe(ErrorCode.PERMISSION_DENIED);
    expect(isErr(result) && result.error.message).toMatch(/allowlist/i);
  });

  it('refuses a program referenced by path, so the allowlist cannot be bypassed', () => {
    for (const program of [
      './node_modules/.bin/anything',
      '../../windows/system32/cmd.exe',
      '/usr/bin/env',
      'C:\\Windows\\System32\\cmd.exe',
    ]) {
      const result = policy.check(spec(program));
      expect(isErr(result), program).toBe(true);
      expect(isErr(result) && result.error.message).toMatch(/by name, not by path/i);
    }
  });

  it('matches a Windows .cmd shim to its base rule', () => {
    expect(isOk(policy.check(spec('npm.cmd', 'run', 'build')))).toBe(true);
    expect(isOk(policy.check(spec('PNPM.CMD', 'run', 'lint')))).toBe(true);
  });

  it('rejects an empty program name', () => {
    expect(isErr(policy.check(spec('   ')))).toBe(true);
  });

  it('rejects control characters in a program or argument', () => {
    expect(isErr(policy.check(spec('pnpm\u0000', 'run')))).toBe(true);
    const result = policy.check(spec('pnpm', 'run', 'test\u0007'));
    expect(isErr(result) && result.error.code).toBe(ErrorCode.INVALID_INPUT);
  });
});

describe('subcommand gating', () => {
  it('permits git inspection', () => {
    for (const sub of ['status', 'diff', 'log', 'rev-parse', 'branch']) {
      expect(isOk(policy.check(spec('git', sub))), sub).toBe(true);
    }
  });

  it('refuses git subcommands that rewrite history or write to a remote', () => {
    for (const sub of ['push', 'reset', 'clean', 'checkout', 'rebase', 'filter-branch']) {
      const result = policy.check(spec('git', sub));
      expect(isErr(result), sub).toBe(true);
    }
  });

  it('requires a subcommand where the rule demands one', () => {
    const result = policy.check(spec('pnpm'));
    expect(isErr(result) && result.error.message).toMatch(/requires a subcommand/i);
  });

  it('refuses a subcommand outside the allowed set', () => {
    const result = policy.check(spec('pnpm', 'publish'));
    expect(isErr(result) && result.error.message).toMatch(/not permitted/i);
  });

  it('finds the subcommand past leading flags', () => {
    expect(isOk(policy.check(spec('pnpm', '--silent', 'run', 'test')))).toBe(true);
  });
});

describe('destructive intent', () => {
  it('refuses recursive deletion in any flag spelling', () => {
    for (const args of [
      ['-rf', '/'],
      ['-fr', 'src'],
      ['-r', 'dist'],
      ['/s', 'C:\\'],
    ]) {
      const result = policy.check({ program: 'rm', args });
      expect(isErr(result), args.join(' ')).toBe(true);
      expect(isErr(result) && result.error.message).toMatch(/recursive deletion|allowlist/i);
    }
  });

  it('refuses disk and partition tools', () => {
    for (const program of ['mkfs', 'mkfs.ext4', 'format', 'diskpart', 'fdisk', 'dd']) {
      expect(isErr(policy.check(spec(program))), program).toBe(true);
    }
  });

  it('refuses privilege escalation', () => {
    for (const program of ['sudo', 'su', 'doas', 'runas', 'pkexec']) {
      const result = policy.check(spec(program, 'pnpm', 'test'));
      expect(isErr(result), program).toBe(true);
      expect(isErr(result) && result.error.message).toMatch(/privilege escalation/i);
    }
  });

  it('refuses a shell interpreter, which would reintroduce shell-string execution', () => {
    for (const program of ['sh', 'bash', 'zsh', 'cmd', 'cmd.exe', 'powershell', 'pwsh']) {
      const result = policy.check(spec(program, '-c', 'echo hi'));
      expect(isErr(result), program).toBe(true);
      expect(isErr(result) && result.error.message).toMatch(/shell/i);
    }
  });

  it('refuses git reset --hard, clean -fd, and force push by name', () => {
    const hard = policy.check(spec('git', 'reset', '--hard', 'HEAD'));
    expect(isErr(hard) && hard.error.message).toMatch(/destroy/i);

    const clean = policy.check(spec('git', 'clean', '-fd'));
    expect(isErr(clean)).toBe(true);

    const force = policy.check(spec('git', 'push', '--force'));
    expect(isErr(force)).toBe(true);
  });

  it('refuses credential store access', () => {
    for (const program of ['security', 'cmdkey', 'vaultcmd', 'procdump']) {
      expect(isErr(policy.check(spec(program, 'dump'))), program).toBe(true);
    }
  });

  it('refuses download-and-run patterns', () => {
    expect(isErr(policy.check(spec('curl', '-o', 'x.sh', 'https://example.com/x.sh')))).toBe(true);
    expect(isErr(policy.check(spec('wget', '-O', '-', 'https://example.com/x.sh')))).toBe(true);
  });

  it('refuses system power operations and broad process kills', () => {
    expect(isErr(policy.check(spec('shutdown', '/s')))).toBe(true);
    expect(isErr(policy.check(spec('taskkill', '/f', '/im', 'node.exe')))).toBe(true);
    expect(isErr(policy.check(spec('pkill', '-9', 'node')))).toBe(true);
  });

  it('refuses broad permission changes', () => {
    expect(isErr(policy.check(spec('chmod', '-R', '777', '.')))).toBe(true);
  });
});

describe('shell metacharacters are inert data', () => {
  it('accepts an argument containing shell syntax, because no shell is used', () => {
    // This is the point of the argument-vector design: the string below is a
    // legitimate test-name filter, and it cannot become a second command.
    const verdict = policy.check(spec('pnpm', 'run', 'test', '--', '-t', 'handles a; b && c | d'));
    expect(isOk(verdict)).toBe(true);
  });

  it('accepts a path with spaces without quoting games', () => {
    expect(isOk(policy.check(spec('tsc', '-p', 'my project/tsconfig.json')))).toBe(true);
  });
});

describe('policy configuration', () => {
  it('honours additional project rules', () => {
    const extended = new CommandPolicy({
      additionalRules: [{ program: 'deno', risk: 'LOW_RISK_WRITE', description: 'Deno tasks' }],
    });
    expect(isOk(extended.check(spec('deno', 'task', 'test')))).toBe(true);
  });

  it('honours a blocklist that removes a default program', () => {
    const restricted = new CommandPolicy({ blockedPrograms: ['npx'] });
    expect(isErr(restricted.check(spec('npx', 'tsc')))).toBe(true);
    expect(restricted.allowedPrograms).not.toContain('npx');
  });

  it('reports the effective allowlist', () => {
    expect(policy.allowedPrograms).toContain('pnpm');
    expect(policy.allowedPrograms).toContain('git');
    expect(policy.describe().length).toBeGreaterThan(5);
  });
});

describe('renderForDisplay', () => {
  it('quotes only what needs quoting, for logs and prompts', () => {
    expect(renderForDisplay(spec('pnpm', 'run', 'test'))).toBe('pnpm run test');
    expect(renderForDisplay(spec('tsc', '-p', 'my project/tsconfig.json'))).toContain(
      '"my project',
    );
  });
});
