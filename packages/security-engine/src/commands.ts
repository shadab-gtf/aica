import path from 'node:path';

import type { Result, RiskLevel } from '@aica/shared';
import { err, errors, ok } from '@aica/shared';

/**
 * Command execution policy (specification section 35).
 *
 * The central design choice: a command is a **program name plus an argument
 * vector**, never a shell string. The executor spawns without a shell, so shell
 * metacharacters in an argument are inert data. Injection is therefore
 * structurally impossible rather than filtered, and the deny rules below exist
 * to catch destructive *intent* (an allowlisted program asked to do something
 * ruinous), not to sanitize syntax.
 */

export interface CommandSpec {
  /** Program name only, e.g. "pnpm". Never a path, never a shell line. */
  readonly program: string;
  readonly args: readonly string[];
  /** Working directory, relative to the project root. */
  readonly cwd?: string;
}

export interface CommandRule {
  readonly program: string;
  readonly risk: RiskLevel;
  /**
   * When present, the first argument must be one of these. This is how `git`
   * can be allowed for `status` and `diff` while `push` stays out.
   */
  readonly allowedSubcommands?: readonly string[];
  /** Subcommands refused even when the program is allowed. */
  readonly deniedSubcommands?: readonly string[];
  readonly description: string;
  /** Always confirm, even in auto mode. */
  readonly alwaysConfirm?: boolean;
}

/**
 * Default allowlist. Deliberately small: the tools the agent actually needs to
 * validate its own work. Projects extend this through configuration; nothing is
 * added implicitly.
 */
export const DEFAULT_COMMAND_RULES: readonly CommandRule[] = [
  {
    program: 'node',
    risk: 'LOW_RISK_WRITE',
    description: 'Run a Node.js script from the project.',
  },
  {
    program: 'npm',
    risk: 'LOW_RISK_WRITE',
    allowedSubcommands: ['run', 'test', 'exec', 'ls', 'view', 'why', 'ci', 'install', 'audit'],
    description: 'npm scripts and dependency inspection.',
  },
  {
    program: 'pnpm',
    risk: 'LOW_RISK_WRITE',
    allowedSubcommands: [
      'run',
      'test',
      'exec',
      'list',
      'why',
      'install',
      'audit',
      'build',
      'lint',
      'typecheck',
    ],
    description: 'pnpm scripts and dependency inspection.',
  },
  {
    program: 'yarn',
    risk: 'LOW_RISK_WRITE',
    allowedSubcommands: ['run', 'test', 'install', 'why', 'list', 'audit'],
    description: 'yarn scripts and dependency inspection.',
  },
  {
    program: 'bun',
    risk: 'LOW_RISK_WRITE',
    allowedSubcommands: ['run', 'test', 'install', 'pm', 'x'],
    description: 'bun scripts and dependency inspection.',
  },
  {
    program: 'npx',
    risk: 'LOW_RISK_WRITE',
    description: 'Run a package binary resolved from the project.',
  },
  {
    program: 'tsc',
    risk: 'READ_ONLY',
    description: 'TypeScript compiler; type checking.',
  },
  {
    program: 'eslint',
    risk: 'LOW_RISK_WRITE',
    description: 'Lint, optionally with --fix.',
  },
  {
    program: 'prettier',
    risk: 'LOW_RISK_WRITE',
    description: 'Format check or write.',
  },
  {
    program: 'vitest',
    risk: 'READ_ONLY',
    description: 'Run tests.',
  },
  {
    program: 'jest',
    risk: 'READ_ONLY',
    description: 'Run tests.',
  },
  {
    program: 'playwright',
    risk: 'LOW_RISK_WRITE',
    description: 'Run end-to-end tests.',
  },
  {
    program: 'git',
    risk: 'READ_ONLY',
    allowedSubcommands: [
      'status',
      'diff',
      'log',
      'show',
      'branch',
      'rev-parse',
      'ls-files',
      'blame',
      'describe',
      'remote',
      'config',
      'stash',
      'add',
      'commit',
    ],
    deniedSubcommands: [
      'push',
      'reset',
      'clean',
      'checkout',
      'switch',
      'restore',
      'rebase',
      'filter-branch',
      'gc',
      'prune',
    ],
    description:
      'Git inspection, staging, and committing. History rewriting and remote writes are refused.',
  },
];

/**
 * Argument shapes refused outright, even for an allowlisted program.
 *
 * Each entry names the destructive capability rather than a syntax pattern,
 * because arguments are not shell-interpreted; what matters is what the program
 * would be told to do.
 */
interface DenyRule {
  readonly name: string;
  readonly matches: (spec: CommandSpec) => boolean;
  readonly reason: string;
}

const RECURSIVE_FORCE_RM = /^-{1,2}[a-zA-Z]*[rR][a-zA-Z]*$/;

const DENY_RULES: readonly DenyRule[] = [
  {
    name: 'recursive-delete',
    matches: (spec) =>
      ['rm', 'rmdir', 'del', 'erase', 'rd'].includes(spec.program.toLowerCase()) &&
      spec.args.some((arg) => RECURSIVE_FORCE_RM.test(arg) || arg === '/s' || arg === '/S'),
    reason: 'Recursive deletion is never performed by the agent.',
  },
  {
    name: 'disk-format',
    matches: (spec) => /^(?:mkfs(?:\..+)?|format|diskpart|fdisk|dd)$/i.test(spec.program),
    reason: 'Disk and partition operations are forbidden.',
  },
  {
    name: 'privilege-escalation',
    matches: (spec) => /^(?:sudo|su|doas|runas|pkexec)$/i.test(spec.program),
    reason: 'Privilege escalation is forbidden.',
  },
  {
    name: 'shell-interpreter',
    matches: (spec) =>
      /^(?:sh|bash|zsh|fish|dash|ksh|csh|cmd|cmd\.exe|powershell|powershell\.exe|pwsh)$/i.test(
        spec.program,
      ),
    reason:
      'Shell interpreters are not invoked directly, because that would reintroduce a shell-string execution path. Run the target program with an argument vector instead.',
  },
  {
    name: 'remote-code-execution',
    matches: (spec) =>
      /^(?:curl|wget|iwr|invoke-webrequest)$/i.test(spec.program) &&
      spec.args.some((arg) => /^-{1,2}(?:o|output|O)$/i.test(arg) || arg.includes('|')),
    reason:
      'Downloading and executing remote content is forbidden. Use the API executor, which applies SSRF protection.',
  },
  {
    name: 'credential-dumping',
    matches: (spec) =>
      /^(?:security|keychain|cmdkey|vaultcmd|lsass|procdump|mimikatz)$/i.test(spec.program),
    reason: 'Credential store access is forbidden.',
  },
  {
    name: 'git-history-destruction',
    matches: (spec) => {
      if (spec.program.toLowerCase() !== 'git') return false;
      const sub = spec.args[0]?.toLowerCase();
      if (sub === 'reset' && spec.args.includes('--hard')) return true;
      if (sub === 'clean' && spec.args.some((a) => /^-[a-z]*[fd]/i.test(a))) return true;
      if (
        sub === 'push' &&
        spec.args.some((a) => a === '--force' || a === '-f' || a.startsWith('--force-with-lease'))
      ) {
        return true;
      }
      return false;
    },
    reason:
      'git reset --hard, git clean -fd, and force push destroy uncommitted or published work and are refused without explicit policy (specification section 37).',
  },
  {
    name: 'process-kill-broad',
    matches: (spec) =>
      /^(?:killall|pkill|taskkill)$/i.test(spec.program) &&
      spec.args.some((arg) => arg === '-9' || /^\/f$/i.test(arg) || arg === '*'),
    reason: 'Broad process termination is forbidden.',
  },
  {
    name: 'system-power',
    matches: (spec) => /^(?:shutdown|reboot|halt|poweroff)$/i.test(spec.program),
    reason: 'System power operations are forbidden.',
  },
  {
    name: 'permission-change-broad',
    matches: (spec) =>
      /^(?:chmod|chown|icacls|takeown)$/i.test(spec.program) &&
      spec.args.some((arg) => arg === '-R' || arg === '/T' || arg === '777'),
    reason: 'Broad permission changes are forbidden.',
  },
];

export interface CommandPolicyOptions {
  readonly rules?: readonly CommandRule[];
  /** Programs added by project configuration. */
  readonly additionalRules?: readonly CommandRule[];
  /** Programs removed from the effective allowlist. */
  readonly blockedPrograms?: readonly string[];
}

export interface CommandVerdict {
  readonly spec: CommandSpec;
  readonly rule: CommandRule;
  readonly risk: RiskLevel;
  readonly alwaysConfirm: boolean;
  /** Rendered form, for display and audit only. Never executed as a string. */
  readonly display: string;
}

export class CommandPolicy {
  private readonly rules = new Map<string, CommandRule>();

  constructor(options: CommandPolicyOptions = {}) {
    const blocked = new Set((options.blockedPrograms ?? []).map((p) => p.toLowerCase()));
    for (const rule of [
      ...(options.rules ?? DEFAULT_COMMAND_RULES),
      ...(options.additionalRules ?? []),
    ]) {
      if (blocked.has(rule.program.toLowerCase())) continue;
      this.rules.set(rule.program.toLowerCase(), rule);
    }
  }

  get allowedPrograms(): readonly string[] {
    return [...this.rules.keys()].sort();
  }

  describe(): readonly CommandRule[] {
    return [...this.rules.values()];
  }

  /**
   * Validate a command against the policy.
   *
   * Rejects a program given as a path, because allowlisting by name is only
   * meaningful if the name cannot be spelled as `./node_modules/.bin/anything`
   * or `..\\..\\windows\\system32\\cmd.exe`.
   */
  check(spec: CommandSpec): Result<CommandVerdict> {
    if (spec.program.trim().length === 0) {
      return err(errors.invalidInput('Empty program name'));
    }

    if (/[\\/]/.test(spec.program)) {
      return err(
        errors.permissionDenied(
          'Programs must be referenced by name, not by path, so that the allowlist cannot be bypassed.',
          { program: spec.program },
        ),
      );
    }

    if (containsControlCharacters(spec.program) || spec.args.some(containsControlCharacters)) {
      return err(
        errors.invalidInput('Command contains control characters', { program: spec.program }),
      );
    }

    for (const deny of DENY_RULES) {
      if (deny.matches(spec)) {
        return err(
          errors.permissionDenied(deny.reason, { program: spec.program, rule: deny.name }),
        );
      }
    }

    const normalized = normalizeProgram(spec.program);
    const rule = this.rules.get(normalized);
    if (!rule) {
      return err(
        errors.permissionDenied(
          `"${spec.program}" is not in the command allowlist. Allowed: ${this.allowedPrograms.join(', ')}.`,
          { program: spec.program },
        ),
      );
    }

    const subcommand = firstSubcommand(spec.args);
    if (rule.deniedSubcommands && subcommand && rule.deniedSubcommands.includes(subcommand)) {
      return err(
        errors.permissionDenied(`"${rule.program} ${subcommand}" is refused by policy.`, {
          program: rule.program,
          subcommand,
        }),
      );
    }
    if (rule.allowedSubcommands) {
      if (!subcommand) {
        return err(
          errors.permissionDenied(
            `"${rule.program}" requires a subcommand. Allowed: ${rule.allowedSubcommands.join(', ')}.`,
            { program: rule.program },
          ),
        );
      }
      if (!rule.allowedSubcommands.includes(subcommand)) {
        return err(
          errors.permissionDenied(
            `"${rule.program} ${subcommand}" is not permitted. Allowed subcommands: ${rule.allowedSubcommands.join(', ')}.`,
            { program: rule.program, subcommand },
          ),
        );
      }
    }

    return ok({
      spec,
      rule,
      risk: rule.risk,
      alwaysConfirm: rule.alwaysConfirm ?? false,
      display: renderForDisplay(spec),
    });
  }
}

/** Strip a Windows executable suffix so `npm.cmd` matches the `npm` rule. */
function normalizeProgram(program: string): string {
  const lower = program.toLowerCase();
  const ext = path.extname(lower);
  return ['.cmd', '.bat', '.exe', '.ps1'].includes(ext) ? lower.slice(0, -ext.length) : lower;
}

function firstSubcommand(args: readonly string[]): string | undefined {
  for (const arg of args) {
    if (!arg.startsWith('-')) return arg.toLowerCase();
  }
  return undefined;
}

function containsControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 && code !== 0x09) return true;
    if (code === 0x7f) return true;
  }
  return false;
}

/**
 * Render a command for logs and approval prompts. Quoting here is purely
 * cosmetic; the executor never consumes this string.
 */
export function renderForDisplay(spec: CommandSpec): string {
  const parts = [spec.program, ...spec.args].map((part) =>
    /[\s"'`$&|;<>(){}[\]*?!#~]/.test(part) ? JSON.stringify(part) : part,
  );
  return parts.join(' ');
}
