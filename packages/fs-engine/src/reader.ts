import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import type { Logger, Result } from '@aica/shared';
import { Limits, err, errors, ok, silentLogger } from '@aica/shared';
import type { PathPolicy, Redactor } from '@aica/security-engine';

import { hashContent } from './patch.js';

/**
 * Workspace reading (specification sections 50, 51, 63).
 *
 * Reads are bounded and filtered, because "do not dump the repository into the
 * model" has to be enforced by the tool that produces context, not by asking
 * the model to be frugal. Every read returns the content hash alongside the
 * text so a later patch can use it as a precondition.
 */

export interface FileEntry {
  readonly path: string;
  readonly kind: 'file' | 'directory';
  readonly bytes?: number;
}

export interface ListResult {
  readonly entries: readonly FileEntry[];
  readonly truncated: boolean;
}

export interface ReadResult {
  readonly path: string;
  readonly content: string;
  /** SHA-256 of the full file, usable as a patch precondition. */
  readonly hash: string;
  readonly totalLines: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly truncated: boolean;
  readonly bytes: number;
}

export interface SearchMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface SearchResult {
  readonly matches: readonly SearchMatch[];
  readonly filesScanned: number;
  readonly truncated: boolean;
}

export interface WorkspaceReaderOptions {
  readonly pathPolicy: PathPolicy;
  readonly redactor?: Redactor;
  readonly logger?: Logger;
}

export class WorkspaceReader {
  private readonly pathPolicy: PathPolicy;
  private readonly redactor: Redactor | undefined;
  private readonly logger: Logger;

  constructor(options: WorkspaceReaderOptions) {
    this.pathPolicy = options.pathPolicy;
    this.redactor = options.redactor;
    this.logger = (options.logger ?? silentLogger).child('fs');
  }

  /** List a directory, or walk it recursively, honouring ignore rules. */
  async list(
    relativePath = '.',
    options: { recursive?: boolean; maxEntries?: number } = {},
  ): Promise<Result<ListResult>> {
    const resolved = this.pathPolicy.resolve(relativePath);
    if (!resolved.ok) return resolved;

    const maxEntries = options.maxEntries ?? Limits.maxListEntries;
    const entries: FileEntry[] = [];
    let truncated = false;

    const queue: string[] = [resolved.value.absolute];

    while (queue.length > 0) {
      const dir = queue.shift() as string;
      let dirents;
      try {
        dirents = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (dir === resolved.value.absolute) {
          return err(
            errors.notFound(`Cannot list "${relativePath}"`, {
              path: relativePath,
              cause: error instanceof Error ? error.message : String(error),
            }),
          );
        }
        continue;
      }

      for (const dirent of dirents) {
        if (entries.length >= maxEntries) {
          truncated = true;
          break;
        }

        const absolute = path.join(dir, dirent.name);
        const relative = this.pathPolicy.relativize(absolute);
        const isDirectory = dirent.isDirectory();

        if (this.pathPolicy.isIgnored(relative, isDirectory)) continue;

        if (isDirectory) {
          entries.push({ path: relative, kind: 'directory' });
          if (options.recursive) queue.push(absolute);
          continue;
        }

        if (!dirent.isFile()) continue;

        let bytes: number | undefined;
        try {
          bytes = (await stat(absolute)).size;
        } catch {
          bytes = undefined;
        }
        entries.push({ path: relative, kind: 'file', ...(bytes === undefined ? {} : { bytes }) });
      }

      if (truncated) break;
    }

    entries.sort((a, b) => a.path.localeCompare(b.path));
    return ok({ entries, truncated });
  }

  /**
   * Read a file as text, optionally a line range.
   *
   * Credential files and binaries are refused by policy rather than read and
   * then filtered, so their contents never enter the process at all.
   */
  async read(
    relativePath: string,
    options: { startLine?: number; maxLines?: number; redact?: boolean } = {},
  ): Promise<Result<ReadResult>> {
    const permitted = this.pathPolicy.canRead(relativePath);
    if (!permitted.ok) return permitted;

    const resolved = this.pathPolicy.resolve(relativePath);
    if (!resolved.ok) return resolved;

    let stats;
    try {
      stats = await stat(resolved.value.absolute);
    } catch (error) {
      return err(
        errors.notFound(`"${resolved.value.relative}" does not exist`, {
          path: resolved.value.relative,
          cause: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    if (!stats.isFile()) {
      return err(
        errors.invalidInput(`"${resolved.value.relative}" is not a file`, {
          path: resolved.value.relative,
        }),
      );
    }

    if (stats.size > Limits.maxReadBytes) {
      return err(
        errors.limitExceeded(
          `"${resolved.value.relative}" is ${stats.size} bytes, above the ${Limits.maxReadBytes}-byte read limit. Read a line range instead, or search within it.`,
          { path: resolved.value.relative, bytes: stats.size },
        ),
      );
    }

    let raw: string;
    try {
      raw = await readFile(resolved.value.absolute, 'utf8');
    } catch (error) {
      return err(
        errors.toolFailure(`Could not read "${resolved.value.relative}"`, {
          path: resolved.value.relative,
          cause: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    // Hash the full content, not the slice: the hash is a precondition for
    // editing the file, so it must describe the whole file.
    const hash = hashContent(raw);

    const allLines = raw.split('\n');
    const totalLines = allLines.length;
    const startLine = Math.max(1, options.startLine ?? 1);
    const maxLines = Math.min(options.maxLines ?? Limits.maxReadLines, Limits.maxReadLines);
    const endLine = Math.min(totalLines, startLine + maxLines - 1);

    const slice = allLines.slice(startLine - 1, endLine).join('\n');
    const content = options.redact === false ? slice : this.redact(slice);

    return ok({
      path: resolved.value.relative,
      content,
      hash,
      totalLines,
      startLine,
      endLine,
      truncated: startLine > 1 || endLine < totalLines,
      bytes: stats.size,
    });
  }

  /**
   * Search file contents by regular expression.
   *
   * Implemented in-process rather than shelling out to a grep tool, so that
   * behaviour does not vary with what happens to be installed and so that
   * ignore rules and secret exclusions are applied consistently.
   */
  async search(
    pattern: string,
    options: {
      root?: string;
      include?: readonly string[];
      maxMatches?: number;
      caseSensitive?: boolean;
      maxFileBytes?: number;
    } = {},
  ): Promise<Result<SearchResult>> {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, options.caseSensitive === false ? 'i' : '');
    } catch (error) {
      return err(
        errors.invalidInput(
          `Invalid search pattern: ${error instanceof Error ? error.message : ''}`,
          {
            pattern,
          },
        ),
      );
    }

    const listed = await this.list(options.root ?? '.', { recursive: true, maxEntries: 20_000 });
    if (!listed.ok) return listed;

    const maxMatches = options.maxMatches ?? Limits.maxSearchMatches;
    const maxFileBytes = options.maxFileBytes ?? Limits.maxIndexBytes;
    const matches: SearchMatch[] = [];
    let filesScanned = 0;
    let truncated = listed.value.truncated;

    for (const entry of listed.value.entries) {
      if (entry.kind !== 'file') continue;
      if (matches.length >= maxMatches) {
        truncated = true;
        break;
      }
      if (options.include && !matchesAnyGlob(entry.path, options.include)) continue;
      if (this.pathPolicy.isSecretFile(entry.path)) continue;
      if (!this.pathPolicy.canRead(entry.path).ok) continue;
      if (entry.bytes !== undefined && entry.bytes > maxFileBytes) continue;

      const resolved = this.pathPolicy.resolve(entry.path);
      if (!resolved.ok) continue;

      let content: string;
      try {
        content = await readFile(resolved.value.absolute, 'utf8');
      } catch {
        continue;
      }
      filesScanned += 1;

      const lines = content.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        if (matches.length >= maxMatches) {
          truncated = true;
          break;
        }
        const line = lines[index] as string;
        if (regex.test(line)) {
          matches.push({
            path: entry.path,
            line: index + 1,
            text: this.redact(line.length > 300 ? `${line.slice(0, 300)}...` : line),
          });
        }
      }
    }

    this.logger.debug('search complete', { pattern, filesScanned, matches: matches.length });
    return ok({ matches, filesScanned, truncated });
  }

  private redact(text: string): string {
    return this.redactor ? this.redactor.text(text) : text;
  }
}

/**
 * Minimal glob matching for include filters: supports `*`, `**`, `?`, and
 * brace alternation such as `*.{ts,tsx}`.
 */
export function matchesGlob(filePath: string, pattern: string): boolean {
  const expanded = expandBraces(pattern);
  return expanded.some((single) => globToRegExp(single).test(filePath));
}

function matchesAnyGlob(filePath: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesGlob(filePath, pattern));
}

function expandBraces(pattern: string): string[] {
  const match = /\{([^{}]*)\}/.exec(pattern);
  if (!match) return [pattern];
  const [whole, body = ''] = match;
  return body.split(',').flatMap((option) => expandBraces(pattern.replace(whole, option)));
}

function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i] as string;
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` matches zero or more path segments.
        if (pattern[i + 2] === '/') {
          source += '(?:.*/)?';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}
