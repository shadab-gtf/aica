import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { ErrorCode, isErr, unwrap } from '@aica/shared';
import { CommandPolicy, PathPolicy, Redactor } from '@aica/security-engine';

import { CommandExecutor } from './executor.js';
import { buildCmdInvocation, escapeForCmd, isBatchShim, quoteArgvW } from './quoting.js';
import { resolveProgram } from './resolve.js';

const root = mkdtempSync(path.join(tmpdir(), 'aica-exec-'));

// A small script gives us a program that is present on every platform and whose
// behaviour we control precisely, without depending on shell builtins.
writeFileSync(
  path.join(root, 'echo-args.cjs'),
  `const args = process.argv.slice(2);
process.stdout.write(JSON.stringify(args));
if (process.env.EMIT_STDERR) process.stderr.write('stderr-line');
process.exit(Number(process.env.EXIT_CODE || 0));
`,
);
writeFileSync(
  path.join(root, 'spew.cjs'),
  `for (let i = 0; i < 200000; i += 1) process.stdout.write('0123456789');
`,
);
writeFileSync(
  path.join(root, 'hang.cjs'),
  `setInterval(() => {}, 1000);
process.stdout.write('started');
`,
);
writeFileSync(
  path.join(root, 'show-env.cjs'),
  `process.stdout.write(JSON.stringify(process.env));`,
);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const executor = (redactor?: Redactor): CommandExecutor =>
  new CommandExecutor({
    pathPolicy: new PathPolicy({ root }),
    commandPolicy: new CommandPolicy(),
    ...(redactor ? { redactor } : {}),
  });

describe('argument-vector execution', () => {
  it('passes arguments through verbatim, without shell interpretation', async () => {
    const result = unwrap(
      await executor().run({ program: 'node', args: ['echo-args.cjs', 'plain', 'with space'] }),
    );
    expect(result.ok).toBe(true);
    // argv.slice(2) in the script drops the script path itself.
    expect(JSON.parse(result.stdout)).toEqual(['plain', 'with space']);
  });

  it('treats shell metacharacters as data, not syntax', async () => {
    // If any shell were involved, these would redirect, chain, or substitute.
    const hostile = [
      'a; rm -rf /',
      'b && whoami',
      'c | cat',
      '$(id)',
      '`id`',
      'd > out.txt',
      '%PATH%',
    ];
    const result = unwrap(
      await executor().run({ program: 'node', args: ['echo-args.cjs', ...hostile] }),
    );
    expect(JSON.parse(result.stdout)).toEqual(hostile);
  });

  it('preserves quotes and backslashes exactly', async () => {
    const tricky = ['say "hi"', 'back\\slash', 'trailing\\', 'both"\\mixed'];
    const result = unwrap(
      await executor().run({ program: 'node', args: ['echo-args.cjs', ...tricky] }),
    );
    expect(JSON.parse(result.stdout)).toEqual(tricky);
  });
});

describe('policy enforcement', () => {
  it('refuses a program that is not allowlisted, before spawning anything', async () => {
    const result = await executor().run({ program: 'whoami', args: [] });
    expect(isErr(result) && result.error.code).toBe(ErrorCode.PERMISSION_DENIED);
  });

  it('refuses a working directory outside the project', async () => {
    const result = await executor().run(
      { program: 'node', args: ['echo-args.cjs'] },
      { cwd: '../elsewhere' },
    );
    expect(isErr(result) && result.error.code).toBe(ErrorCode.PERMISSION_DENIED);
  });

  it('reports a missing program clearly rather than failing obscurely', () => {
    const result = resolveProgram('definitely-not-installed-xyz', { root });
    expect(isErr(result) && result.error.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('previews a command without running it', () => {
    const preview = unwrap(executor().preview({ program: 'git', args: ['status'] }));
    expect(preview.display).toBe('git status');
    expect(preview.risk).toBe('READ_ONLY');
  });
});

describe('exit codes and streams', () => {
  it('returns a non-zero exit as an outcome, not an executor error', async () => {
    const result = unwrap(
      await executor().run(
        { program: 'node', args: ['echo-args.cjs'] },
        { injectEnv: { EXIT_CODE: '3' } },
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
  });

  it('captures stderr separately', async () => {
    const result = unwrap(
      await executor().run(
        { program: 'node', args: ['echo-args.cjs'] },
        { injectEnv: { EMIT_STDERR: '1' } },
      ),
    );
    expect(result.stderr).toContain('stderr-line');
  });

  it('streams output chunks to a listener for live display', async () => {
    const chunks: string[] = [];
    await executor().run(
      { program: 'node', args: ['echo-args.cjs', 'streamed'] },
      { onOutput: (chunk) => chunks.push(chunk) },
    );
    expect(chunks.join('')).toContain('streamed');
  });
});

describe('resource limits', () => {
  it('caps output and marks it truncated instead of exhausting memory', async () => {
    const result = unwrap(
      await executor().run({ program: 'node', args: ['spew.cjs'] }, { maxOutputBytes: 4_096 }),
    );
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThan(10_000);
    expect(result.stdout).toContain('output truncated');
  });

  it('terminates a hanging process at the timeout and keeps partial output', async () => {
    const result = await executor().run(
      { program: 'node', args: ['hang.cjs'] },
      { timeoutMs: 700 },
    );
    expect(isErr(result) && result.error.code).toBe(ErrorCode.TIMEOUT);
    expect(isErr(result) && String(result.error.details.stdout)).toContain('started');
  });

  it('honours an external abort signal', async () => {
    const controller = new AbortController();
    const pending = executor().run(
      { program: 'node', args: ['hang.cjs'] },
      { timeoutMs: 30_000, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 200);
    const result = await pending;
    expect(isErr(result) && result.error.code).toBe(ErrorCode.ABORTED);
  });
});

describe('environment isolation', () => {
  it('does not hand the parent environment to the child', async () => {
    const exec = new CommandExecutor({
      pathPolicy: new PathPolicy({ root }),
      commandPolicy: new CommandPolicy(),
      env: {
        ...process.env,
        STRIPE_API_KEY: 'must-not-reach-the-child',
        MY_RANDOM_VAR: 'also-not',
      },
    });
    const result = unwrap(await exec.run({ program: 'node', args: ['show-env.cjs'] }));
    const childEnv = JSON.parse(result.stdout) as Record<string, string>;
    expect(childEnv.STRIPE_API_KEY).toBeUndefined();
    expect(childEnv.MY_RANDOM_VAR).toBeUndefined();
    expect(childEnv.PATH ?? childEnv.Path).toBeTruthy();
  });

  it('passes through only what was explicitly named', async () => {
    const exec = new CommandExecutor({
      pathPolicy: new PathPolicy({ root }),
      commandPolicy: new CommandPolicy(),
      env: { ...process.env, DATABASE_URL: 'postgres://localhost/test' },
    });
    const result = unwrap(
      await exec.run(
        { program: 'node', args: ['show-env.cjs'] },
        { passthroughEnv: ['DATABASE_URL'] },
      ),
    );
    const childEnv = JSON.parse(result.stdout) as Record<string, string>;
    expect(childEnv.DATABASE_URL).toBe('postgres://localhost/test');
  });

  it('puts the project node_modules/.bin on the child PATH', async () => {
    const result = unwrap(await executor().run({ program: 'node', args: ['show-env.cjs'] }));
    const childEnv = JSON.parse(result.stdout) as Record<string, string>;
    expect(childEnv.PATH ?? childEnv.Path).toContain(path.join('node_modules', '.bin'));
  });
});

describe('output redaction', () => {
  it('redacts secrets appearing in captured output', async () => {
    const redactor = new Redactor();
    redactor.registerValue('leakedtokenvalue123');
    const result = unwrap(
      await executor(redactor).run({
        program: 'node',
        args: ['echo-args.cjs', 'token=leakedtokenvalue123'],
      }),
    );
    expect(result.stdout).not.toContain('leakedtokenvalue123');
    expect(result.stdout).toContain('[REDACTED]');
  });
});

describe('Windows quoting', () => {
  it('leaves a simple argument unquoted', () => {
    expect(quoteArgvW('simple')).toBe('simple');
  });

  it('quotes an argument containing whitespace', () => {
    expect(quoteArgvW('two words')).toBe('"two words"');
  });

  it('escapes embedded quotes', () => {
    expect(quoteArgvW('say "hi"')).toBe('"say \\"hi\\""');
  });

  it('doubles backslashes only where they precede a quote', () => {
    // An argument with no whitespace and no quote needs no quoting at all, and
    // an unquoted trailing backslash is already literal to the argv parser.
    expect(quoteArgvW('a\\b')).toBe('a\\b');
    expect(quoteArgvW('trailing\\')).toBe('trailing\\');
    // Once quoting is required, a trailing backslash must be doubled so that it
    // does not escape the closing quote.
    expect(quoteArgvW('two words\\')).toBe('"two words\\\\"');
    expect(quoteArgvW('quote\\"')).toBe('"quote\\\\\\""');
  });

  it('carets cmd.exe metacharacters so they are not reinterpreted', () => {
    expect(escapeForCmd('a&b')).toBe('a^&b');
    expect(escapeForCmd('%PATH%')).toBe('^%PATH^%');
    expect(escapeForCmd('a|b')).toBe('a^|b');
    expect(escapeForCmd('(x)')).toBe('^(x^)');
  });

  it('builds a cmd invocation that disables AutoRun and takes the line verbatim', () => {
    const invocation = buildCmdInvocation('C:\\bin\\pnpm.cmd', ['run', 'test']);
    expect(invocation.args[0]).toBe('/d');
    expect(invocation.args[1]).toBe('/s');
    expect(invocation.args[2]).toBe('/c');
    expect(invocation.windowsVerbatimArguments).toBe(true);
    expect(invocation.args[3]?.startsWith('"')).toBe(true);
    expect(invocation.args[3]).toContain('run test');
  });

  it('neutralises a hostile argument inside a cmd invocation', () => {
    const invocation = buildCmdInvocation('C:\\bin\\pnpm.cmd', ['run', 'test & calc.exe']);
    // The ampersand is carets-escaped, so cmd cannot treat it as a separator.
    expect(invocation.args[3]).toContain('^&');
    expect(invocation.args[3]).not.toMatch(/[^^]& calc/);
  });

  it('detects batch shims', () => {
    expect(isBatchShim('C:\\bin\\pnpm.cmd')).toBe(true);
    expect(isBatchShim('C:\\bin\\thing.BAT')).toBe(true);
    expect(isBatchShim('/usr/bin/node')).toBe(false);
    expect(isBatchShim('C:\\bin\\node.exe')).toBe(false);
  });
});
