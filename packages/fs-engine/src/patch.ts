import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { FileChangeSummary, Id, Logger, Result } from '@aica/shared';
import { Limits, err, errors, newId, ok, silentLogger } from '@aica/shared';
import type { PathPolicy } from '@aica/security-engine';

import { applyUnifiedDiff, computeStat, formatUnifiedDiff, parseUnifiedDiff } from './diff.js';

/**
 * Patch application (specification section 36).
 *
 * Design commitments, each of which exists because of a specific way that
 * AI-generated edits go wrong:
 *
 * - **Anchored edits are the primary format.** An edit names the exact text it
 *   replaces. If that text is not present, the edit fails loudly rather than
 *   writing to a guessed location.
 * - **Content hashes are preconditions.** If the file changed since the agent
 *   read it — because the user was typing in it — the patch is refused instead
 *   of silently overwriting their work (specification section 37).
 * - **Application is transactional.** A multi-file patch either fully applies
 *   or fully rolls back. A half-applied patch leaves a repository that neither
 *   builds nor resembles what was reviewed.
 * - **Nothing is written outside the project**, and no code path writes the
 *   whole repository.
 */

/** Replace an exact anchor. The safest and preferred edit form. */
export interface AnchoredEdit {
  readonly oldText: string;
  readonly newText: string;
  /** Replace every occurrence. Default false, which requires a unique anchor. */
  readonly replaceAll?: boolean;
}

export type FileOperation =
  | { readonly kind: 'edit'; readonly edits: readonly AnchoredEdit[] }
  | { readonly kind: 'create'; readonly content: string }
  | { readonly kind: 'replace'; readonly content: string }
  | { readonly kind: 'unified'; readonly diff: string }
  | { readonly kind: 'delete' };

export interface FilePatch {
  /** Project-relative path. */
  readonly path: string;
  readonly operation: FileOperation;
  /**
   * SHA-256 of the file content the agent based this edit on. When present it
   * is enforced; when absent, anchored edits still provide their own safety.
   */
  readonly expectedHash?: string;
}

export interface Patch {
  readonly id: Id<'patch'>;
  /** Why this change is being made, shown alongside the diff for review. */
  readonly rationale: string;
  readonly files: readonly FilePatch[];
}

export interface PatchPreview {
  readonly patchId: Id<'patch'>;
  readonly rationale: string;
  readonly files: readonly FileChangeSummary[];
  /** Unified diff across all files, for display. */
  readonly diff: string;
}

export interface AppliedPatch extends PatchPreview {
  readonly appliedAt: number;
}

interface StagedChange {
  readonly relative: string;
  readonly absolute: string;
  readonly before: string | undefined;
  readonly after: string | undefined;
  readonly summary: FileChangeSummary;
  readonly diff: string;
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function makePatch(rationale: string, files: readonly FilePatch[]): Patch {
  return { id: newId('patch'), rationale, files };
}

export interface PatchEngineOptions {
  readonly pathPolicy: PathPolicy;
  readonly logger?: Logger;
  readonly maxFiles?: number;
}

export class PatchEngine {
  private readonly pathPolicy: PathPolicy;
  private readonly logger: Logger;
  private readonly maxFiles: number;

  constructor(options: PatchEngineOptions) {
    this.pathPolicy = options.pathPolicy;
    this.logger = (options.logger ?? silentLogger).child('patch');
    this.maxFiles = options.maxFiles ?? Limits.maxPatchFiles;
  }

  /**
   * Compute what a patch would do, without writing anything.
   *
   * This is the review artifact: the user sees this diff, approves it, and only
   * then is `apply` called. Every validation that `apply` performs is performed
   * here too, so an approved preview does not fail at write time for a reason
   * the user could have been shown earlier.
   */
  async preview(patch: Patch): Promise<Result<PatchPreview>> {
    const staged = await this.stage(patch);
    if (!staged.ok) return staged;

    return ok({
      patchId: patch.id,
      rationale: patch.rationale,
      files: staged.value.map((change) => change.summary),
      diff: staged.value
        .map((change) => change.diff)
        .filter((diff) => diff.length > 0)
        .join('\n'),
    });
  }

  /** Stage, then write. Rolls back completely if any write fails. */
  async apply(patch: Patch): Promise<Result<AppliedPatch>> {
    const staged = await this.stage(patch);
    if (!staged.ok) return staged;
    const changes = staged.value;

    const written: StagedChange[] = [];
    try {
      for (const change of changes) {
        if (change.after === undefined) {
          await rm(change.absolute, { force: true });
        } else {
          await mkdir(path.dirname(change.absolute), { recursive: true });
          await writeFile(change.absolute, change.after, 'utf8');
        }
        written.push(change);
      }
    } catch (error) {
      // Roll every completed write back to the content captured at stage time.
      await this.rollback(written);
      return err(
        errors.toolFailure(
          `Patch failed partway through and was rolled back; the working tree is unchanged.`,
          {
            patchId: patch.id,
            failedAt: written.length,
            cause: error instanceof Error ? error.message : String(error),
          },
        ),
      );
    }

    this.logger.info('patch applied', { patchId: patch.id, files: changes.length });

    return ok({
      patchId: patch.id,
      rationale: patch.rationale,
      files: changes.map((change) => change.summary),
      diff: changes
        .map((change) => change.diff)
        .filter((diff) => diff.length > 0)
        .join('\n'),
      appliedAt: Date.now(),
    });
  }

  private async rollback(written: readonly StagedChange[]): Promise<void> {
    for (const change of [...written].reverse()) {
      try {
        if (change.before === undefined) {
          await rm(change.absolute, { force: true });
        } else {
          await mkdir(path.dirname(change.absolute), { recursive: true });
          await writeFile(change.absolute, change.before, 'utf8');
        }
      } catch (error) {
        // Report rather than throw: the caller must learn that the tree may be
        // inconsistent, and a throw here would mask the original failure.
        this.logger.error('rollback failed', {
          path: change.relative,
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** Resolve, validate, and compute the result of every file operation. */
  private async stage(patch: Patch): Promise<Result<StagedChange[]>> {
    if (patch.files.length === 0) {
      return err(errors.invalidInput('Patch contains no file operations', { patchId: patch.id }));
    }
    if (patch.files.length > this.maxFiles) {
      return err(
        errors.limitExceeded(
          `Patch touches ${patch.files.length} files, above the limit of ${this.maxFiles}. Split it into smaller, reviewable changes.`,
          { patchId: patch.id, fileCount: patch.files.length },
        ),
      );
    }

    const seen = new Set<string>();
    const staged: StagedChange[] = [];

    for (const file of patch.files) {
      const resolved = this.pathPolicy.resolve(file.path);
      if (!resolved.ok) return resolved;
      const { absolute, relative } = resolved.value;

      if (seen.has(relative)) {
        return err(
          errors.invalidInput(
            `Patch addresses "${relative}" more than once. Combine the edits into a single entry so the outcome is unambiguous.`,
            { path: relative },
          ),
        );
      }
      seen.add(relative);

      if (this.pathPolicy.isSecretFile(relative)) {
        return err(
          errors.permissionDenied('Refusing to modify a credentials file', { path: relative }),
        );
      }

      const before = await this.readIfExists(absolute);

      if (file.expectedHash !== undefined) {
        const actual = before === undefined ? undefined : hashContent(before);
        if (actual !== file.expectedHash) {
          return err(
            errors.preconditionFailed(
              `"${relative}" has changed since it was read. Re-read the file and rebuild the edit; the existing content will not be overwritten.`,
              { path: relative, expectedHash: file.expectedHash, actualHash: actual ?? null },
            ),
          );
        }
      }

      const after = this.computeAfter(relative, before, file.operation);
      if (!after.ok) return after;

      if (after.value === before) {
        // A no-op edit usually means the agent misread the file; surfacing it
        // is more useful than silently writing nothing.
        return err(
          errors.invalidInput(
            `The edit to "${relative}" would not change the file. Verify the anchor text matches what is actually there.`,
            { path: relative },
          ),
        );
      }

      staged.push({
        relative,
        absolute,
        before,
        after: after.value,
        summary: summarize(relative, before, after.value),
        diff: renderDiff(relative, before, after.value),
      });
    }

    return ok(staged);
  }

  private computeAfter(
    relative: string,
    before: string | undefined,
    operation: FileOperation,
  ): Result<string | undefined> {
    switch (operation.kind) {
      case 'create':
        if (before !== undefined) {
          return err(
            errors.alreadyExists(
              `"${relative}" already exists. Use an edit or a replace if replacing it is intended.`,
              { path: relative },
            ),
          );
        }
        return ok(operation.content);

      case 'replace':
        return ok(operation.content);

      case 'delete':
        if (before === undefined) {
          return err(errors.notFound(`"${relative}" does not exist`, { path: relative }));
        }
        return ok(undefined);

      case 'edit': {
        if (before === undefined) {
          return err(
            errors.notFound(`Cannot edit "${relative}" because it does not exist`, {
              path: relative,
            }),
          );
        }
        if (operation.edits.length === 0) {
          return err(
            errors.invalidInput(`No edits supplied for "${relative}"`, { path: relative }),
          );
        }

        let content = before;
        for (const [index, edit] of operation.edits.entries()) {
          const applied = applyAnchoredEdit(content, edit, relative, index);
          if (!applied.ok) return applied;
          content = applied.value;
        }
        return ok(content);
      }

      case 'unified': {
        if (before === undefined) {
          return err(
            errors.notFound(`Cannot apply a diff to "${relative}" because it does not exist`, {
              path: relative,
            }),
          );
        }
        const parsed = parseUnifiedDiff(operation.diff);
        if ('error' in parsed) {
          return err(errors.invalidInput(parsed.error, { path: relative }));
        }
        const applied = applyUnifiedDiff(before, parsed.hunks);
        if (!applied.ok) {
          return err(errors.preconditionFailed(applied.error, { path: relative }));
        }
        return ok(applied.content);
      }

      default:
        return err(errors.unsupported('Unknown file operation'));
    }
  }

  private async readIfExists(absolute: string): Promise<string | undefined> {
    try {
      return await readFile(absolute, 'utf8');
    } catch {
      return undefined;
    }
  }
}

/**
 * Apply one anchored edit.
 *
 * A non-unique anchor is an error rather than a first-match replacement: when
 * an anchor appears twice, which one the model meant is genuinely unknown, and
 * guessing produces a plausible-looking wrong edit.
 */
function applyAnchoredEdit(
  content: string,
  edit: AnchoredEdit,
  relative: string,
  index: number,
): Result<string> {
  if (edit.oldText === '') {
    return err(
      errors.invalidInput(
        `Edit ${index + 1} for "${relative}" has empty anchor text. Anchor on the exact text being replaced.`,
        { path: relative },
      ),
    );
  }
  if (edit.oldText === edit.newText) {
    return err(
      errors.invalidInput(`Edit ${index + 1} for "${relative}" replaces text with itself.`, {
        path: relative,
      }),
    );
  }

  const occurrences = countOccurrences(content, edit.oldText);

  if (occurrences === 0) {
    return err(
      errors.preconditionFailed(
        `Edit ${index + 1} for "${relative}" did not match. The anchor text was not found, so nothing was written. Re-read the file and anchor on text that is actually present.`,
        { path: relative, anchorPreview: preview(edit.oldText) },
      ),
    );
  }

  if (occurrences > 1 && edit.replaceAll !== true) {
    return err(
      errors.conflict(
        `Edit ${index + 1} for "${relative}" is ambiguous: the anchor appears ${occurrences} times. Include surrounding lines to make it unique, or set replaceAll if every occurrence should change.`,
        { path: relative, occurrences, anchorPreview: preview(edit.oldText) },
      ),
    );
  }

  return ok(
    edit.replaceAll === true
      ? content.split(edit.oldText).join(edit.newText)
      : content.replace(edit.oldText, () => edit.newText),
  );
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const found = haystack.indexOf(needle, from);
    if (found === -1) return count;
    count += 1;
    from = found + needle.length;
  }
}

function preview(text: string): string {
  const firstLine = text.split('\n')[0] ?? '';
  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}...` : firstLine;
}

function summarize(
  relative: string,
  before: string | undefined,
  after: string | undefined,
): FileChangeSummary {
  if (before === undefined && after !== undefined) {
    const stat = computeStat('', after);
    return { path: relative, kind: 'created', linesAdded: stat.linesAdded, linesRemoved: 0 };
  }
  if (after === undefined && before !== undefined) {
    const stat = computeStat(before, '');
    return { path: relative, kind: 'deleted', linesAdded: 0, linesRemoved: stat.linesRemoved };
  }
  const stat = computeStat(before ?? '', after ?? '');
  return {
    path: relative,
    kind: 'modified',
    linesAdded: stat.linesAdded,
    linesRemoved: stat.linesRemoved,
  };
}

function renderDiff(
  relative: string,
  before: string | undefined,
  after: string | undefined,
): string {
  if (before === undefined) {
    return formatUnifiedDiff('', after ?? '', {
      oldPath: '/dev/null',
      newPath: `b/${relative}`,
    });
  }
  if (after === undefined) {
    return formatUnifiedDiff(before, '', {
      oldPath: `a/${relative}`,
      newPath: '/dev/null',
    });
  }
  return formatUnifiedDiff(before, after, {
    oldPath: `a/${relative}`,
    newPath: `b/${relative}`,
  });
}
