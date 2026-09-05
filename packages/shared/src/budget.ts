/**
 * What one run is allowed to consume (§35).
 *
 * An agent loop's failure mode is not usually a crash. It is a run that keeps
 * going: re-reading the same file, retrying the same call, spending tokens on
 * an approach that was never going to work. Iteration caps catch the crudest
 * version of that, and this catches the rest — wall clock, tool calls, tokens,
 * money, and how much of the repository a single run may rewrite.
 *
 * Three decisions shape it:
 *
 * **A budget is checked, not enforced by interruption.** `check` returns why
 * the run should stop; the caller decides where it is safe to stop. Killing a
 * run mid-write to save a token would trade money for a half-applied patch.
 *
 * **Exhaustion is a normal outcome, not an error.** A run that hits its budget
 * did not fail — it did as much as it was allowed to. It is reported with what
 * it managed, so a user can raise the limit and resume rather than start again.
 *
 * **Every limit is optional and every one is off by default here.** The
 * defaults live in configuration, where a project can see them. A limit that
 * appears out of nowhere is a limit nobody can plan around.
 */

export interface RunLimits {
  /** Provider round-trips. The crudest and most reliable brake. */
  readonly maxIterations?: number;
  readonly maxToolCalls?: number;
  readonly maxWallClockMs?: number;
  /** Input plus output tokens across the run. */
  readonly maxTokens?: number;
  /** Spend, in whole currency units. */
  readonly maxCostUsd?: number;
  /** Distinct files a run may change. */
  readonly maxFilesChanged?: number;
  /** Consecutive failing iterations tolerated before it is clearly stuck. */
  readonly maxConsecutiveFailures?: number;
}

export interface BudgetUsage {
  readonly iterations: number;
  readonly toolCalls: number;
  readonly elapsedMs: number;
  readonly tokens: number;
  readonly costUsd: number;
  readonly filesChanged: number;
  readonly consecutiveFailures: number;
}

export type BudgetVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly limit: keyof RunLimits; readonly reason: string };

export class RunBudget {
  private startedAt: number;
  private iterations = 0;
  private toolCalls = 0;
  private tokens = 0;
  private costUsd = 0;
  private consecutiveFailures = 0;
  private readonly files = new Set<string>();

  constructor(
    private readonly limits: RunLimits = {},
    private readonly now: () => number = () => Date.now(),
  ) {
    this.startedAt = this.now();
  }

  /** Restart the clock. For a run resumed after a pause. */
  reset(): void {
    this.startedAt = this.now();
    this.iterations = 0;
    this.toolCalls = 0;
    this.tokens = 0;
    this.costUsd = 0;
    this.consecutiveFailures = 0;
    this.files.clear();
  }

  countIteration(): void {
    this.iterations += 1;
  }

  countToolCall(succeeded: boolean): void {
    this.toolCalls += 1;
    // Consecutive, not total. A run with forty successes and one failure is
    // working; one with four failures in a row is not.
    this.consecutiveFailures = succeeded ? 0 : this.consecutiveFailures + 1;
  }

  countUsage(usage: { inputTokens?: number; outputTokens?: number; costUsd?: number }): void {
    this.tokens += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    this.costUsd += usage.costUsd ?? 0;
  }

  countFiles(paths: readonly string[]): void {
    // A set, so a file rewritten three times counts once. The limit is about
    // how much of the repository a run touches, not how busy it was.
    for (const path of paths) this.files.add(path);
  }

  get usage(): BudgetUsage {
    return {
      iterations: this.iterations,
      toolCalls: this.toolCalls,
      elapsedMs: this.now() - this.startedAt,
      tokens: this.tokens,
      costUsd: Number(this.costUsd.toFixed(4)),
      filesChanged: this.files.size,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  /**
   * Is there budget left?
   *
   * Checked before doing more, so the message names what ran out and what it
   * managed first — "stopped after 40 iterations" is actionable, "budget
   * exceeded" is not.
   */
  check(): BudgetVerdict {
    const usage = this.usage;

    if (this.limits.maxIterations !== undefined && usage.iterations >= this.limits.maxIterations) {
      return exceeded('maxIterations', `Stopped after ${usage.iterations} iterations.`);
    }

    if (this.limits.maxToolCalls !== undefined && usage.toolCalls >= this.limits.maxToolCalls) {
      return exceeded('maxToolCalls', `Stopped after ${usage.toolCalls} tool calls.`);
    }

    if (this.limits.maxWallClockMs !== undefined && usage.elapsedMs >= this.limits.maxWallClockMs) {
      return exceeded(
        'maxWallClockMs',
        `Stopped after ${Math.round(usage.elapsedMs / 1000)}s, which is this project's time budget.`,
      );
    }

    if (this.limits.maxTokens !== undefined && usage.tokens >= this.limits.maxTokens) {
      return exceeded('maxTokens', `Stopped after ${usage.tokens.toLocaleString()} tokens.`);
    }

    if (this.limits.maxCostUsd !== undefined && usage.costUsd >= this.limits.maxCostUsd) {
      return exceeded(
        'maxCostUsd',
        `Stopped at $${usage.costUsd.toFixed(2)}, which is this project's spend limit.`,
      );
    }

    if (
      this.limits.maxFilesChanged !== undefined &&
      usage.filesChanged >= this.limits.maxFilesChanged
    ) {
      return exceeded(
        'maxFilesChanged',
        `Stopped after changing ${usage.filesChanged} files. A run that touches more than this should be split into reviewable pieces.`,
      );
    }

    if (
      this.limits.maxConsecutiveFailures !== undefined &&
      usage.consecutiveFailures >= this.limits.maxConsecutiveFailures
    ) {
      return exceeded(
        'maxConsecutiveFailures',
        `Stopped after ${usage.consecutiveFailures} failures in a row, which means the approach is not working.`,
      );
    }

    return { ok: true };
  }

  /**
   * Whether one more file may be changed.
   *
   * Asked separately because it is the one limit worth checking *before* the
   * action rather than after: a patch refused is a patch the user still has,
   * and a patch applied past the limit is a repository that has already been
   * rewritten.
   */
  allowsFiles(paths: readonly string[]): BudgetVerdict {
    if (this.limits.maxFilesChanged === undefined) return { ok: true };

    const projected = new Set([...this.files, ...paths]).size;
    if (projected <= this.limits.maxFilesChanged) return { ok: true };

    return exceeded(
      'maxFilesChanged',
      `This change would bring the run to ${projected} files, above the limit of ${this.limits.maxFilesChanged}.`,
    );
  }

  /** A one-line account of what was spent. */
  render(): string {
    const usage = this.usage;
    const parts = [
      `${usage.iterations} iteration(s)`,
      `${usage.toolCalls} tool call(s)`,
      `${Math.round(usage.elapsedMs / 1000)}s`,
    ];

    if (usage.tokens > 0) parts.push(`${usage.tokens.toLocaleString()} tokens`);
    if (usage.costUsd > 0) parts.push(`$${usage.costUsd.toFixed(4)}`);
    if (usage.filesChanged > 0) parts.push(`${usage.filesChanged} file(s) changed`);

    return parts.join(', ');
  }
}

function exceeded(limit: keyof RunLimits, reason: string): BudgetVerdict {
  return { ok: false, limit, reason };
}
