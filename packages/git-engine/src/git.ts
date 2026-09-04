import type { Logger, Result } from '@aica/shared';
import { err, errors, ok, silentLogger } from '@aica/shared';
import type { CommandExecutor } from '@aica/exec-engine';

/**
 * Git operations (specification section 37).
 *
 * Two responsibilities:
 *
 * 1. **Inspection**, so the agent knows the state of the working tree before it
 *    modifies anything and can show what changed afterwards.
 * 2. **Refusal**. `git reset --hard`, `git clean -fd`, and force pushes destroy
 *    work that may not exist anywhere else. They are blocked in the command
 *    policy and there is deliberately no method here that performs them, so the
 *    capability is absent rather than merely discouraged.
 *
 * Commits are never automatic. `commit` exists, but the orchestrator only calls
 * it when the project configuration asks for it.
 */

export type FileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'ignored'
  | 'conflicted'
  | 'unknown';

export interface StatusEntry {
  readonly path: string;
  readonly status: FileStatus;
  readonly staged: boolean;
  readonly unstaged: boolean;
  readonly originalPath?: string;
}

export interface RepoStatus {
  readonly isRepository: boolean;
  readonly branch: string | undefined;
  readonly detached: boolean;
  readonly ahead: number;
  readonly behind: number;
  readonly entries: readonly StatusEntry[];
  /** True when the user has uncommitted work the agent must not disturb. */
  readonly dirty: boolean;
  readonly hasConflicts: boolean;
}

export interface CommitInfo {
  readonly hash: string;
  readonly shortHash: string;
  readonly author: string;
  readonly date: string;
  readonly subject: string;
}

/**
 * ASCII unit and record separators, requested from `git log` via %x1f and %x1e.
 * Using control characters rather than punctuation means a commit subject can
 * contain any printable text without breaking the parse.
 */
const FIELD_SEPARATOR = '\u001f';
const RECORD_SEPARATOR = '\u001e';

export interface GitEngineOptions {
  readonly executor: CommandExecutor;
  readonly logger?: Logger;
}

export class GitEngine {
  private readonly executor: CommandExecutor;
  private readonly logger: Logger;

  constructor(options: GitEngineOptions) {
    this.executor = options.executor;
    this.logger = (options.logger ?? silentLogger).child('git');
  }

  /** True when the project root is inside a Git working tree. */
  async isRepository(): Promise<boolean> {
    const result = await this.executor.run({
      program: 'git',
      args: ['rev-parse', '--is-inside-work-tree'],
    });
    return result.ok && result.value.ok && result.value.stdout.trim() === 'true';
  }

  /**
   * Read the working-tree state.
   *
   * Called before any modification so that pre-existing user changes are known
   * and can be preserved and reported, rather than being conflated with the
   * agent's own edits when the diff is reviewed.
   */
  async status(): Promise<Result<RepoStatus>> {
    if (!(await this.isRepository())) {
      return ok({
        isRepository: false,
        branch: undefined,
        detached: false,
        ahead: 0,
        behind: 0,
        entries: [],
        dirty: false,
        hasConflicts: false,
      });
    }

    // Porcelain v2 is the stable machine-readable format; v1 short output is
    // ambiguous for paths containing spaces.
    const result = await this.executor.run({
      program: 'git',
      args: ['status', '--porcelain=v2', '--branch', '--untracked-files=normal'],
    });
    if (!result.ok) return result;
    if (!result.value.ok) {
      return err(
        errors.toolFailure('git status failed', {
          exitCode: result.value.exitCode,
          stderr: result.value.stderr.slice(0, 500),
        }),
      );
    }

    return ok(parsePorcelainV2(result.value.stdout));
  }

  /** Unified diff of the working tree, optionally staged or path-scoped. */
  async diff(
    options: { staged?: boolean; paths?: readonly string[]; contextLines?: number } = {},
  ): Promise<Result<string>> {
    const args = ['diff', '--no-color'];
    if (options.staged) args.push('--cached');
    if (options.contextLines !== undefined) args.push(`--unified=${options.contextLines}`);
    if (options.paths?.length) args.push('--', ...options.paths);

    const result = await this.executor.run({ program: 'git', args });
    if (!result.ok) return result;
    // git diff exits 0 with no output when there is nothing to show, and
    // non-zero only on real failure.
    if (!result.value.ok && result.value.stderr.trim().length > 0) {
      return err(
        errors.toolFailure('git diff failed', { stderr: result.value.stderr.slice(0, 500) }),
      );
    }
    return ok(result.value.stdout);
  }

  /** Names of changed files, which is what impact analysis needs. */
  async changedFiles(options: { staged?: boolean } = {}): Promise<Result<readonly string[]>> {
    const args = ['diff', '--name-only'];
    if (options.staged) args.push('--cached');

    const result = await this.executor.run({ program: 'git', args });
    if (!result.ok) return result;
    return ok(
      result.value.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    );
  }

  async log(
    options: { limit?: number; paths?: readonly string[] } = {},
  ): Promise<Result<readonly CommitInfo[]>> {
    const limit = Math.min(options.limit ?? 20, 200);
    // Unit separator between fields and record separator between commits, so
    // subjects containing any punctuation still parse.
    const format = ['%H', '%h', '%an', '%aI', '%s'].join('%x1f');
    const args = ['log', `--max-count=${limit}`, `--format=${format}%x1e`];
    if (options.paths?.length) args.push('--', ...options.paths);

    const result = await this.executor.run({ program: 'git', args });
    if (!result.ok) return result;
    if (!result.value.ok) {
      return err(
        errors.toolFailure('git log failed', { stderr: result.value.stderr.slice(0, 500) }),
      );
    }

    const commits: CommitInfo[] = [];
    for (const record of result.value.stdout.split(RECORD_SEPARATOR)) {
      const trimmed = record.trim();
      if (trimmed.length === 0) continue;
      const [hash, shortHash, author, date, subject] = trimmed.split(FIELD_SEPARATOR);
      if (!hash || !shortHash) continue;
      commits.push({
        hash,
        shortHash,
        author: author ?? '',
        date: date ?? '',
        subject: subject ?? '',
      });
    }
    return ok(commits);
  }

  async currentBranch(): Promise<Result<string>> {
    const result = await this.executor.run({
      program: 'git',
      args: ['rev-parse', '--abbrev-ref', 'HEAD'],
    });
    if (!result.ok) return result;
    if (!result.value.ok) {
      return err(errors.toolFailure('Could not determine the current branch'));
    }
    return ok(result.value.stdout.trim());
  }

  async listBranches(): Promise<Result<readonly string[]>> {
    const result = await this.executor.run({
      program: 'git',
      args: ['branch', '--format=%(refname:short)'],
    });
    if (!result.ok) return result;
    return ok(
      result.value.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    );
  }

  /**
   * Stage specific paths. Never `git add -A`: the agent stages what it changed,
   * so unrelated user work is not swept into its commit.
   */
  async stage(paths: readonly string[]): Promise<Result<void>> {
    if (paths.length === 0) {
      return err(errors.invalidInput('No paths supplied to stage'));
    }
    if (paths.some((p) => p === '.' || p === '-A' || p === '--all' || p === '*')) {
      return err(
        errors.permissionDenied(
          'Refusing to stage everything. Name the files the agent changed, so unrelated work is not committed with them.',
          { paths },
        ),
      );
    }

    const result = await this.executor.run({ program: 'git', args: ['add', '--', ...paths] });
    if (!result.ok) return result;
    if (!result.value.ok) {
      return err(
        errors.toolFailure('git add failed', { stderr: result.value.stderr.slice(0, 500) }),
      );
    }
    return ok(undefined);
  }

  /**
   * Commit staged changes.
   *
   * Never called automatically; the orchestrator invokes it only when project
   * configuration enables committing, and after the diff has been reviewed.
   */
  async commit(
    message: string,
    options: { allowEmpty?: boolean } = {},
  ): Promise<Result<CommitInfo>> {
    const trimmed = message.trim();
    if (trimmed.length === 0) {
      return err(errors.invalidInput('Commit message is empty'));
    }

    const args = ['commit', '--message', trimmed];
    if (options.allowEmpty) args.push('--allow-empty');

    const result = await this.executor.run({ program: 'git', args });
    if (!result.ok) return result;
    if (!result.value.ok) {
      const combined = `${result.value.stdout}\n${result.value.stderr}`;
      if (/nothing to commit/i.test(combined)) {
        return err(errors.invalidInput('Nothing staged to commit'));
      }
      return err(
        errors.toolFailure('git commit failed', {
          stderr: result.value.stderr.slice(0, 500),
          stdout: result.value.stdout.slice(0, 500),
        }),
      );
    }

    this.logger.info('commit created');
    const log = await this.log({ limit: 1 });
    if (!log.ok) return log;
    const head = log.value[0];
    if (!head) return err(errors.internal('Commit succeeded but HEAD could not be read'));
    return ok(head);
  }
}

/**
 * Parse `git status --porcelain=v2`.
 *
 * Format reference: `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>` for ordinary
 * changes, `2 ...` for renames with a tab-separated original path, `u ...` for
 * unmerged, `?` for untracked, `!` for ignored, and `# branch.*` headers.
 */
export function parsePorcelainV2(output: string): RepoStatus {
  const entries: StatusEntry[] = [];
  let branch: string | undefined;
  let detached = false;
  let ahead = 0;
  let behind = 0;
  let hasConflicts = false;

  for (const line of output.split('\n')) {
    if (line.length === 0) continue;

    if (line.startsWith('# branch.head ')) {
      const value = line.slice('# branch.head '.length).trim();
      if (value === '(detached)') detached = true;
      else branch = value;
      continue;
    }

    if (line.startsWith('# branch.ab ')) {
      const match = /\+(\d+) -(\d+)/.exec(line);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
      continue;
    }

    if (line.startsWith('# ')) continue;

    if (line.startsWith('1 ')) {
      const fields = line.split(' ');
      const xy = fields[1] ?? '..';
      const filePath = fields.slice(8).join(' ');
      if (filePath.length === 0) continue;
      entries.push(buildEntry(filePath, xy));
      continue;
    }

    if (line.startsWith('2 ')) {
      const fields = line.split(' ');
      const xy = fields[1] ?? '..';
      // Path and original path are tab-separated in the final field group.
      const tail = fields.slice(9).join(' ');
      const [filePath = '', originalPath = ''] = tail.split('\t');
      if (filePath.length === 0) continue;
      entries.push({ ...buildEntry(filePath, xy), status: 'renamed', originalPath });
      continue;
    }

    if (line.startsWith('u ')) {
      hasConflicts = true;
      const fields = line.split(' ');
      const filePath = fields.slice(10).join(' ');
      if (filePath.length === 0) continue;
      entries.push({ path: filePath, status: 'conflicted', staged: false, unstaged: true });
      continue;
    }

    if (line.startsWith('? ')) {
      entries.push({
        path: line.slice(2),
        status: 'untracked',
        staged: false,
        unstaged: true,
      });
      continue;
    }

    if (line.startsWith('! ')) {
      entries.push({ path: line.slice(2), status: 'ignored', staged: false, unstaged: false });
    }
  }

  const dirty = entries.some((entry) => entry.status !== 'ignored');

  return {
    isRepository: true,
    branch,
    detached,
    ahead,
    behind,
    entries,
    dirty,
    hasConflicts,
  };
}

function buildEntry(filePath: string, xy: string): StatusEntry {
  const staged = xy[0] !== undefined && xy[0] !== '.';
  const unstaged = xy[1] !== undefined && xy[1] !== '.';
  // The index column takes precedence when both are set, since that is what a
  // commit would record.
  const code = staged ? xy[0] : xy[1];
  return { path: filePath, status: mapStatusCode(code), staged, unstaged };
}

function mapStatusCode(code: string | undefined): FileStatus {
  switch (code) {
    case 'M':
      return 'modified';
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'U':
      return 'conflicted';
    default:
      return 'unknown';
  }
}
