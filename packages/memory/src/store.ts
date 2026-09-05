/**
 * The memory store.
 *
 * Scope resolution, a refusal to hold credentials, and a budget — in that order
 * of importance.
 *
 * **Resolution is most-specific-wins.** A `task` fact shadows a `project` one
 * of the same key, which shadows `global`. Reading returns the winner and
 * `resolveAll` returns the chain, because "why does it think that" is a
 * question with a specific answer and a UI should be able to give it.
 *
 * **Persistence is a projection.** The authoritative copy is here, in memory,
 * and a store is written through to. That ordering matters: a database being
 * down must not stop the agent remembering something for the rest of a run, and
 * §2 puts derived facts below the sources they came from anyway.
 *
 * **The budget is real.** Memories are prompt content. Every one loaded is
 * tokens spent on a belief rather than on the code in front of the model, so
 * there is a cap and the things that do not fit are reported rather than
 * quietly dropped.
 */

import type { Logger, Result } from '@aica/shared';
import { AgentError, ErrorCode, err, ok, silentLogger } from '@aica/shared';

import type { MemoryEntry, MemoryScope } from './entry.js';
import { SCOPE_PRECEDENCE, looksLikeCredential, memoryEntrySchema } from './entry.js';

/** Written through on every change. Failures are logged, never propagated. */
export type MemorySink = (entry: MemoryEntry) => void | Promise<void>;

export interface MemoryStoreOptions {
  readonly logger?: Logger;
  readonly sink?: MemorySink;
  readonly now?: () => number;
  /** Entries loaded into a prompt. Beyond this, the least recently updated go. */
  readonly maxRendered?: number;
  /** Characters of memory a prompt may carry. */
  readonly maxRenderedChars?: number;
}

const DEFAULT_MAX_RENDERED = 20;
const DEFAULT_MAX_CHARS = 4000;

export interface RememberInput {
  readonly scope: MemoryScope;
  readonly key: string;
  readonly value: string;
  readonly source?: string;
}

export class MemoryStore {
  private readonly entries = new Map<string, MemoryEntry>();
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(private readonly options: MemoryStoreOptions = {}) {
    this.logger = (options.logger ?? silentLogger).child('memory');
    this.now = options.now ?? (() => Date.now());
  }

  private static id(scope: MemoryScope, key: string): string {
    return `${scope}:${key}`;
  }

  /**
   * Record a fact.
   *
   * Refuses a credential rather than storing and redacting one. Redaction would
   * mean the value had already been written somewhere, and the caller would
   * believe it had remembered something useful when it had remembered
   * `[REDACTED]`.
   */
  remember(input: RememberInput): Result<MemoryEntry> {
    const verdict = looksLikeCredential(input.value);
    if (verdict.isCredential) {
      return err(
        new AgentError(
          ErrorCode.INVALID_INPUT,
          `Refusing to remember "${input.key}": the value looks like ${verdict.what}. Store a reference such as "env:MY_API_KEY" instead — memory is read back into prompts, and a credential there would travel with them.`,
          { details: { key: input.key, scope: input.scope } },
        ),
      );
    }

    const at = new Date(this.now()).toISOString();
    const id = MemoryStore.id(input.scope, input.key);
    const existing = this.entries.get(id);

    const parsed = memoryEntrySchema.safeParse({
      scope: input.scope,
      key: input.key,
      value: input.value,
      ...(input.source !== undefined ? { source: input.source } : {}),
      // Created-at survives an update: when a belief was first formed is part of
      // judging whether it is still true.
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    });

    if (!parsed.success) {
      return err(
        new AgentError(
          ErrorCode.INVALID_INPUT,
          `Cannot remember "${input.key}": ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
          { details: { key: input.key } },
        ),
      );
    }

    this.entries.set(id, parsed.data);
    this.write(parsed.data);

    return ok(parsed.data);
  }

  /** The winning value for a key, most specific scope first. */
  recall(key: string): MemoryEntry | undefined {
    for (const scope of SCOPE_PRECEDENCE) {
      const entry = this.entries.get(MemoryStore.id(scope, key));
      if (entry) return entry;
    }
    return undefined;
  }

  /**
   * Every scope that has an opinion about a key, most specific first.
   *
   * The answer to "why does it believe that" — a project fact shadowed by a
   * task one is not gone, and a user looking at a surprising behaviour needs to
   * see both.
   */
  recallAll(key: string): MemoryEntry[] {
    return SCOPE_PRECEDENCE.map((scope) => this.entries.get(MemoryStore.id(scope, key))).filter(
      (entry): entry is MemoryEntry => entry !== undefined,
    );
  }

  forget(scope: MemoryScope, key: string): boolean {
    return this.entries.delete(MemoryStore.id(scope, key));
  }

  /** Drop a whole scope. Used when a task ends. */
  forgetScope(scope: MemoryScope): number {
    let removed = 0;
    for (const [id, entry] of this.entries) {
      if (entry.scope === scope) {
        this.entries.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Everything currently believed, with shadowed entries removed.
   *
   * Sorted by key so the same set of memories always renders identically —
   * a prompt that reorders between runs is a prompt that cannot be diffed when
   * behaviour changes.
   */
  effective(): MemoryEntry[] {
    const winners = new Map<string, MemoryEntry>();

    for (const scope of SCOPE_PRECEDENCE) {
      for (const entry of this.entries.values()) {
        if (entry.scope === scope && !winners.has(entry.key)) winners.set(entry.key, entry);
      }
    }

    return [...winners.values()].sort((left, right) => left.key.localeCompare(right.key));
  }

  get size(): number {
    return this.entries.size;
  }

  /** Load persisted entries. Anything that fails validation is skipped, loudly. */
  hydrate(entries: readonly unknown[]): number {
    let loaded = 0;

    for (const candidate of entries) {
      const parsed = memoryEntrySchema.safeParse(candidate);
      if (!parsed.success) {
        this.logger.warn('discarded a stored memory that no longer validates');
        continue;
      }

      // Re-checked on the way in. A value that predates this rule, or that was
      // written by an older build, does not get a pass because it is already on
      // disk.
      if (looksLikeCredential(parsed.data.value).isCredential) {
        this.logger.warn('discarded a stored memory that looks like a credential', {
          key: parsed.data.key,
        });
        continue;
      }

      this.entries.set(MemoryStore.id(parsed.data.scope, parsed.data.key), parsed.data);
      loaded += 1;
    }

    return loaded;
  }

  /**
   * Render what the model should be told, under a budget.
   *
   * Framed as recollection rather than instruction. A memory is a belief formed
   * on a previous run and it can be wrong — the code in front of the model is
   * the authority (§2), and saying so is what stops a stale note about a
   * removed library outranking the import list.
   */
  render(): { text: string; included: number; omitted: number } {
    const all = this.effective();
    if (all.length === 0) return { text: '', included: 0, omitted: 0 };

    const maxEntries = this.options.maxRendered ?? DEFAULT_MAX_RENDERED;
    const maxChars = this.options.maxRenderedChars ?? DEFAULT_MAX_CHARS;

    // Most recently confirmed first: a fact re-established last week is more
    // likely to still hold than one from six months ago.
    const ranked = [...all].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

    const lines: string[] = [];
    let chars = 0;
    let included = 0;

    for (const entry of ranked.slice(0, maxEntries)) {
      const line = `- ${entry.key}: ${entry.value}${entry.source ? ` (${entry.source})` : ''}`;
      if (chars + line.length > maxChars && included > 0) break;
      lines.push(line);
      chars += line.length;
      included += 1;
    }

    // Rendered in key order for a stable prompt, having been *selected* by
    // recency.
    lines.sort();

    return {
      text: [
        '# What this project has established before',
        '',
        'Notes from earlier runs. They are recollection, not instruction: if the code in front of you contradicts one, the code is right and the note is stale.',
        '',
        ...lines,
      ].join('\n'),
      included,
      omitted: all.length - included,
    };
  }

  private write(entry: MemoryEntry): void {
    try {
      const written = this.options.sink?.(entry);
      if (written instanceof Promise) {
        void written.catch((error: unknown) => {
          // Never propagated. Remembering something for the rest of a run is
          // worth having even when it will not survive a restart.
          this.logger.warn('memory not persisted', { key: entry.key, reason: String(error) });
        });
      }
    } catch (error) {
      this.logger.warn('memory sink threw', { key: entry.key, reason: String(error) });
    }
  }
}
