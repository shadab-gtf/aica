/**
 * Proposed changes, between proposal and review.
 *
 * A patch lives here from the moment it is proposed until it is applied,
 * discarded, or the run ends. That gap is the review step, and holding the
 * proposal in memory rather than on disk is what makes the gap real: a proposed
 * change written to the working tree has already happened, whatever the UI says
 * next. A build watcher picks it up, a test runner sees it, and the question
 * "do you want this?" has been answered by writing it down.
 *
 * The registry also enforces a smaller rule with a large consequence: only a
 * patch that was previewed can be applied. An agent cannot construct a patch id
 * and apply something nobody has seen.
 */

import type { AppliedPatch, Patch, PatchPreview } from '@aica/fs-engine';

export type PatchStatus = 'proposed' | 'applied' | 'reverted' | 'discarded';

export interface StagedPatch {
  readonly patch: Patch;
  readonly preview: PatchPreview;
  readonly proposedAt: number;
  status: PatchStatus;
  appliedAt?: number;
  /** Contents before the write, so a revert restores exactly what was there. */
  revertTo?: ReadonlyMap<string, string | undefined>;
}

export class PatchRegistry {
  private readonly staged = new Map<string, StagedPatch>();

  stage(patch: Patch, preview: PatchPreview): StagedPatch {
    const entry: StagedPatch = {
      patch,
      preview,
      proposedAt: Date.now(),
      status: 'proposed',
    };
    this.staged.set(patch.id, entry);
    return entry;
  }

  get(patchId: string): StagedPatch | undefined {
    return this.staged.get(patchId);
  }

  markApplied(patchId: string, applied: AppliedPatch): void {
    const entry = this.staged.get(patchId);
    if (!entry) return;
    entry.status = 'applied';
    entry.appliedAt = applied.appliedAt;
  }

  markReverted(patchId: string): void {
    const entry = this.staged.get(patchId);
    if (entry) entry.status = 'reverted';
  }

  markDiscarded(patchId: string): void {
    const entry = this.staged.get(patchId);
    // Applying then discarding is not a thing: the change is on disk and has to
    // be reverted rather than forgotten.
    if (entry && entry.status === 'proposed') entry.status = 'discarded';
  }

  /** Remember what the files held before a write, so a revert is exact. */
  rememberOriginals(patchId: string, originals: ReadonlyMap<string, string | undefined>): void {
    const entry = this.staged.get(patchId);
    if (entry) entry.revertTo = originals;
  }

  list(status?: PatchStatus): readonly StagedPatch[] {
    const all = [...this.staged.values()].sort((left, right) => left.proposedAt - right.proposedAt);
    return status === undefined ? all : all.filter((entry) => entry.status === status);
  }

  get appliedCount(): number {
    return this.list('applied').length;
  }

  /** Files touched by everything applied, for the run summary. */
  changedFiles(): string[] {
    const files = new Set<string>();
    for (const entry of this.list('applied')) {
      for (const file of entry.preview.files) files.add(file.path);
    }
    return [...files].sort();
  }

  clear(): void {
    this.staged.clear();
  }
}
