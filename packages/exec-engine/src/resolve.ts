import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

import type { Result } from '@aica/shared';
import { err, errors, ok } from '@aica/shared';

/**
 * Locate an allowlisted program on disk.
 *
 * Resolution is done here rather than delegated to the shell so that the exact
 * file about to be executed is known and can be reported. Project-local
 * binaries take precedence over global ones, which is what makes `pnpm test`
 * inside a repository run that repository's toolchain.
 */

const WINDOWS_EXTENSIONS: readonly string[] = ['.cmd', '.exe', '.bat', '.com'];

export interface ResolveOptions {
  /** Project root; `node_modules/.bin` beneath it is searched first. */
  readonly root: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
}

export interface ResolvedProgram {
  readonly program: string;
  readonly path: string;
  readonly source: 'project' | 'path';
}

export function resolveProgram(program: string, options: ResolveOptions): Result<ResolvedProgram> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const isWindows = platform === 'win32';
  const candidates = isWindows ? nameVariants(program) : [program];

  // Project-local binaries first, walking up from the root so a package inside
  // a monorepo still finds the workspace root's .bin directory.
  for (const dir of localBinDirs(options.root)) {
    for (const name of candidates) {
      const candidate = path.join(dir, name);
      if (isExecutableFile(candidate)) {
        return ok({ program, path: candidate, source: 'project' });
      }
    }
  }

  const pathValue = env.PATH ?? env.Path ?? '';
  const separator = isWindows ? ';' : ':';
  for (const dir of pathValue.split(separator)) {
    if (dir.trim().length === 0) continue;
    for (const name of candidates) {
      const candidate = path.join(dir, name);
      if (isExecutableFile(candidate)) {
        return ok({ program, path: candidate, source: 'path' });
      }
    }
  }

  return err(
    errors.notFound(
      `"${program}" was not found in the project's node_modules/.bin or on PATH. Install it, or point the project's validation commands at a tool that is present.`,
      { program },
    ),
  );
}

function nameVariants(program: string): string[] {
  if (path.extname(program).length > 0) return [program];
  return [...WINDOWS_EXTENSIONS.map((ext) => `${program}${ext}`), program];
}

/** Every `node_modules/.bin` from the root upward, nearest first. */
function localBinDirs(root: string): string[] {
  const dirs: string[] = [];
  let current = path.resolve(root);

  for (let depth = 0; depth < 32; depth += 1) {
    dirs.push(path.join(current, 'node_modules', '.bin'));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return dirs;
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
  } catch {
    return false;
  }
  if (process.platform === 'win32') return true;
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
