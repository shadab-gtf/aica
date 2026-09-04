import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { ErrorCode, isErr, isOk, unwrap } from '@aica/shared';

import { PathPolicy, isBinaryPath, toPosix } from './paths.js';

// Built at module scope rather than in beforeAll, because the describe bodies
// below construct a PathPolicy during collection, which happens first.
const base = mkdtempSync(path.join(tmpdir(), 'aica-paths-'));
const root = path.join(base, 'project');
const outside = path.join(base, 'outside');

mkdirSync(path.join(root, 'src', 'lib'), { recursive: true });
mkdirSync(path.join(root, 'node_modules', 'react'), { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(path.join(root, 'src', 'app.ts'), 'export const a = 1;\n');
writeFileSync(path.join(root, '.env'), 'SECRET=value\n');
writeFileSync(path.join(root, '.env.example'), 'SECRET=\n');
writeFileSync(path.join(root, '.gitignore'), 'generated/\n*.snap\n');
writeFileSync(path.join(outside, 'secrets.txt'), 'do not read\n');

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

const policy = (): PathPolicy => new PathPolicy({ root, gitignore: 'generated/\n*.snap\n' });

describe('containment', () => {
  it('resolves a relative path inside the project', () => {
    const resolved = unwrap(policy().resolve('src/app.ts'));
    expect(resolved.relative).toBe('src/app.ts');
    expect(path.isAbsolute(resolved.absolute)).toBe(true);
  });

  it('accepts an absolute path inside the project', () => {
    const resolved = unwrap(policy().resolve(path.join(root, 'src', 'app.ts')));
    expect(resolved.relative).toBe('src/app.ts');
  });

  it('rejects traversal out of the project', () => {
    const result = policy().resolve('../outside/secrets.txt');
    expect(isErr(result) && result.error.code).toBe(ErrorCode.PERMISSION_DENIED);
  });

  it('rejects deep traversal that lands outside', () => {
    const result = policy().resolve('src/../../outside/secrets.txt');
    expect(isErr(result)).toBe(true);
  });

  it('rejects an absolute path outside the project', () => {
    const result = policy().resolve(path.join(outside, 'secrets.txt'));
    expect(isErr(result) && result.error.code).toBe(ErrorCode.PERMISSION_DENIED);
  });

  it('rejects a path containing a null byte', () => {
    const result = policy().resolve('src/app\0.ts');
    expect(isErr(result) && result.error.code).toBe(ErrorCode.INVALID_INPUT);
  });

  it('rejects an empty path', () => {
    expect(isErr(policy().resolve(''))).toBe(true);
  });

  it('permits a path whose parent exists but which does not yet exist', () => {
    const resolved = unwrap(policy().resolve('src/lib/newfile.ts'));
    expect(resolved.relative).toBe('src/lib/newfile.ts');
  });

  it('requires an absolute root', () => {
    expect(() => new PathPolicy({ root: 'relative/path' })).toThrow(/absolute/);
  });

  it('normalises the project root itself to "."', () => {
    expect(unwrap(policy().resolve('.')).relative).toBe('.');
  });
});

describe('symlink escape', () => {
  it('rejects a symlink inside the project that points outside it', () => {
    const linkPath = path.join(root, 'escape-link');
    try {
      symlinkSync(outside, linkPath, 'junction');
    } catch {
      // Creating links can require privileges; the containment logic is still
      // covered by the lexical cases above.
      return;
    }

    const result = policy().resolve('escape-link/secrets.txt');
    expect(isErr(result) && result.error.code).toBe(ErrorCode.PERMISSION_DENIED);
    rmSync(linkPath, { recursive: true, force: true });
  });
});

describe('ignore rules', () => {
  const p = policy();

  it('ignores built-in noise directories', () => {
    expect(p.isIgnored('node_modules/react/index.js')).toBe(true);
    expect(p.isIgnored('dist/bundle.js')).toBe(true);
    expect(p.isIgnored('coverage/lcov.info')).toBe(true);
    expect(p.isIgnored('.next/server/page.js')).toBe(true);
    expect(p.isIgnored('pnpm-lock.yaml')).toBe(true);
  });

  it('applies patterns from .gitignore', () => {
    expect(p.isIgnored('generated/client.ts')).toBe(true);
    expect(p.isIgnored('src/App.test.tsx.snap')).toBe(true);
  });

  it('does not ignore ordinary source', () => {
    expect(p.isIgnored('src/app.ts')).toBe(false);
    expect(p.isIgnored('src/components/CheckoutForm.tsx')).toBe(false);
  });

  it('never reports the project root as ignored', () => {
    expect(p.isIgnored('.')).toBe(false);
    expect(p.isIgnored('')).toBe(false);
  });

  it('honours extra project-configured ignores', () => {
    const custom = new PathPolicy({ root, extraIgnores: ['docs/**'] });
    expect(custom.isIgnored('docs/guide.md')).toBe(true);
  });
});

describe('secret files', () => {
  const p = policy();

  it('treats credential files as secret regardless of ignore rules', () => {
    expect(p.isSecretFile('.env')).toBe(true);
    expect(p.isSecretFile('.env.production')).toBe(true);
    expect(p.isSecretFile('certs/server.pem')).toBe(true);
    expect(p.isSecretFile('deploy/id_rsa')).toBe(true);
    expect(p.isSecretFile('service-account-prod.json')).toBe(true);
  });

  it('allows the example env file, which holds no values', () => {
    expect(p.isSecretFile('.env.example')).toBe(false);
  });

  it('refuses to read a credential file and says why', () => {
    const result = p.canRead('.env');
    expect(isErr(result) && result.error.code).toBe(ErrorCode.PERMISSION_DENIED);
    expect(isErr(result) && result.error.message).toMatch(/credential/i);
  });

  it('allows reading ordinary source', () => {
    expect(isOk(p.canRead('src/app.ts'))).toBe(true);
  });

  it('refuses to read a binary file as text', () => {
    const result = p.canRead('assets/logo.png');
    expect(isErr(result) && result.error.code).toBe(ErrorCode.UNSUPPORTED);
  });
});

describe('helpers', () => {
  it('detects binary extensions', () => {
    expect(isBinaryPath('a/b/logo.PNG')).toBe(true);
    expect(isBinaryPath('a/b/module.wasm')).toBe(true);
    expect(isBinaryPath('a/b/index.ts')).toBe(false);
  });

  it('normalises separators to POSIX for stable keys across platforms', () => {
    expect(toPosix(path.join('src', 'lib', 'client.ts'))).toBe('src/lib/client.ts');
  });
});
