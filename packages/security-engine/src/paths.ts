import { realpathSync } from 'node:fs';
import path from 'node:path';

import type { Result } from '@aica/shared';
import { err, errors, ok } from '@aica/shared';
import ignore, { type Ignore } from 'ignore';

/**
 * Path containment and ignore rules (specification sections 36 and 50).
 *
 * Two separate concerns, deliberately not conflated:
 *
 * - **Containment** is a security control. A resolved path must lie inside the
 *   project root. This is checked on the real path, after symlink resolution,
 *   because a symlink inside the workspace pointing at `/etc` would otherwise
 *   pass a purely lexical check.
 * - **Ignore rules** are a relevance and cost control. They keep the indexer
 *   out of `node_modules`, build output, and binaries. They are not a security
 *   boundary: an ignored path is still inside the workspace.
 */

/**
 * Directories and files never indexed, per specification section 50. These are
 * applied in addition to `.gitignore`, since a repository may well commit its
 * build output.
 */
export const BUILTIN_IGNORE_PATTERNS: readonly string[] = [
  'node_modules/',
  '.git/',
  '.hg/',
  '.svn/',
  'dist/',
  'build/',
  'out/',
  'coverage/',
  '.next/',
  '.nuxt/',
  '.svelte-kit/',
  '.turbo/',
  '.cache/',
  '.parcel-cache/',
  '.vite/',
  'target/',
  'vendor/',
  '__pycache__/',
  '.venv/',
  '.pytest_cache/',
  '.gradle/',
  '.idea/',
  '.vscode-test/',
  '*.tsbuildinfo',
  '*.log',
  '*.lock',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  '*.min.js',
  '*.map',
];

/**
 * Files excluded from anything sent to a model, independent of ignore rules
 * (specification section 63). A `.env` file is inside the workspace and not
 * gitignored in every repository, but must never reach a provider.
 */
export const SECRET_FILE_PATTERNS: readonly string[] = [
  '.env',
  '.env.*',
  '!.env.example',
  '!.env.sample',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.keystore',
  'id_rsa',
  'id_ed25519',
  '*.jks',
  '.npmrc',
  '.netrc',
  '_netrc',
  '.pypirc',
  '.git-credentials',
  'credentials.json',
  'service-account*.json',
  '.aws/credentials',
  '.ssh/**',
];

/** Extensions treated as binary and never read as text. */
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.ico',
  '.webp',
  '.avif',
  '.tiff',
  '.mp3',
  '.mp4',
  '.wav',
  '.ogg',
  '.webm',
  '.avi',
  '.mov',
  '.mkv',
  '.flac',
  '.pdf',
  '.zip',
  '.tar',
  '.gz',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.node',
  '.wasm',
  '.class',
  '.jar',
  '.db',
  '.sqlite',
  '.sqlite3',
  '.pyc',
  '.pyo',
  '.bin',
  '.dat',
  '.iso',
  '.psd',
  '.ai',
  '.sketch',
  '.fig',
  '.blend',
]);

export function isBinaryPath(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export interface PathPolicyOptions {
  /** Absolute path to the project root. All access is confined to this tree. */
  readonly root: string;
  /** Contents of `.gitignore`, if present. */
  readonly gitignore?: string;
  /** Extra project-configured ignore patterns. */
  readonly extraIgnores?: readonly string[];
  /** Set false to skip the built-in ignore list (used by explicit reads). */
  readonly useBuiltinIgnores?: boolean;
  /**
   * Resolve symlinks before the containment check. Default true. Only disabled
   * in tests on platforms where creating symlinks needs privileges.
   */
  readonly followSymlinks?: boolean;
}

/**
 * Resolves, validates, and filters paths for one project.
 *
 * Every filesystem tool routes through an instance of this class; there is no
 * other path into the filesystem, which is what makes containment enforceable.
 */
export class PathPolicy {
  readonly root: string;
  private readonly ignorer: Ignore;
  private readonly secretIgnorer: Ignore;
  private readonly followSymlinks: boolean;

  constructor(options: PathPolicyOptions) {
    if (!path.isAbsolute(options.root)) {
      throw new Error(`PathPolicy root must be absolute, received "${options.root}"`);
    }
    this.root = normalizeRoot(options.root, options.followSymlinks ?? true);
    this.followSymlinks = options.followSymlinks ?? true;

    this.ignorer = ignore();
    if (options.useBuiltinIgnores !== false) this.ignorer.add([...BUILTIN_IGNORE_PATTERNS]);
    if (options.gitignore) this.ignorer.add(options.gitignore);
    if (options.extraIgnores?.length) this.ignorer.add([...options.extraIgnores]);

    this.secretIgnorer = ignore().add([...SECRET_FILE_PATTERNS]);
  }

  /**
   * Resolve a candidate path and prove it is inside the project.
   *
   * Accepts absolute paths and paths relative to the root. Returns the absolute
   * path plus the POSIX-style relative path used as the canonical key in the
   * index, in events, and in the UI, so that a project behaves identically on
   * Windows and on POSIX.
   */
  resolve(candidate: string): Result<{ absolute: string; relative: string }> {
    if (candidate.length === 0) return err(errors.invalidInput('Empty path'));
    if (candidate.includes('\0')) {
      return err(errors.invalidInput('Path contains a null byte', { path: candidate }));
    }

    const absolute = path.resolve(this.root, candidate);
    const real = this.followSymlinks ? resolveExistingReal(absolute) : absolute;

    if (!isInside(this.root, real)) {
      return err(
        errors.permissionDenied('Path escapes the project root', {
          path: candidate,
          resolved: real,
          root: this.root,
        }),
      );
    }

    return ok({
      absolute: real,
      relative: toPosix(path.relative(this.root, real)) || '.',
    });
  }

  /** Relative POSIX path for display and indexing. */
  relativize(absolute: string): string {
    return toPosix(path.relative(this.root, absolute)) || '.';
  }

  /** True when ignore rules exclude this path from indexing and search. */
  isIgnored(relativePath: string, isDirectory = false): boolean {
    const key = normalizeForIgnore(relativePath, isDirectory);
    if (key === '' || key === '.') return false;
    return this.ignorer.ignores(key);
  }

  /**
   * True when the path must never be read into model context, regardless of
   * ignore rules. Checked independently so that lifting an ignore rule cannot
   * accidentally expose a credential file.
   */
  isSecretFile(relativePath: string): boolean {
    const key = normalizeForIgnore(relativePath, false);
    if (key === '' || key === '.') return false;
    return this.secretIgnorer.ignores(key);
  }

  /** Combined gate used by read tools: contained, not ignored, not secret, not binary. */
  canRead(relativePath: string): Result<true> {
    const resolved = this.resolve(relativePath);
    if (!resolved.ok) return resolved;
    if (this.isSecretFile(resolved.value.relative)) {
      return err(
        errors.permissionDenied(
          'This file is excluded because it holds credentials. Reference the secret by name instead of reading it.',
          { path: resolved.value.relative },
        ),
      );
    }
    if (isBinaryPath(resolved.value.relative)) {
      return err(
        errors.unsupported('Binary files are not read as text', { path: resolved.value.relative }),
      );
    }
    return ok(true);
  }
}

function normalizeRoot(root: string, followSymlinks: boolean): string {
  const resolved = path.resolve(root);
  if (!followSymlinks) return resolved;
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Resolve the real path of the nearest existing ancestor, then re-append the
 * missing tail. A file being created does not exist yet, so `realpath` on it
 * would fail; its parent directory is what must be proven to be inside the
 * project.
 */
function resolveExistingReal(absolute: string): string {
  let current = absolute;
  const tail: string[] = [];

  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const real = realpathSync.native(current);
      return tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      tail.push(path.basename(current));
      current = parent;
    }
  }

  return absolute;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  if (relative === '') return true;
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function normalizeForIgnore(relativePath: string, isDirectory: boolean): string {
  let key = toPosix(relativePath).replace(/^\.\//, '').replace(/^\/+/, '');
  if (isDirectory && key.length > 0 && !key.endsWith('/')) key += '/';
  return key;
}
