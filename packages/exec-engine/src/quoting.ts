/**
 * Windows command-line construction.
 *
 * Node refuses to spawn a `.cmd` or `.bat` file without a shell, because the
 * Windows loader hands the line to `cmd.exe`, which re-parses it. Package
 * managers on Windows are exactly such shims (`pnpm.cmd`, `npm.cmd`), so they
 * cannot be avoided.
 *
 * Rather than fall back to `shell: true` with a concatenated string, this module
 * builds the command line explicitly: the program is already allowlisted by
 * name, and each argument is quoted by the documented Windows rules and then
 * escaped for `cmd.exe`. No caller- or model-supplied text is ever interpolated
 * unescaped, so the metacharacter injection path that `shell: true` would open
 * stays closed.
 *
 * References: the CommandLineToArgvW quoting rules, plus cmd.exe's separate
 * caret-escaping layer, which is applied second because cmd.exe parses before
 * the argv splitter runs.
 */

/**
 * Quote one argument for the CommandLineToArgvW parser used by most programs.
 *
 * Backslashes are only special immediately before a quote, which is why the run
 * length is doubled in that position and left alone otherwise.
 */
export function quoteArgvW(argument: string): string {
  if (argument.length > 0 && !/[\s"]/.test(argument)) return argument;

  let quoted = '"';
  let backslashes = 0;

  for (const char of argument) {
    if (char === '\\') {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      // Escape the accumulated backslashes, then the quote itself.
      quoted += '\\'.repeat(backslashes * 2 + 1);
      quoted += '"';
      backslashes = 0;
      continue;
    }
    quoted += '\\'.repeat(backslashes);
    backslashes = 0;
    quoted += char;
  }

  // Trailing backslashes precede the closing quote, so they must be doubled.
  quoted += '\\'.repeat(backslashes * 2);
  quoted += '"';
  return quoted;
}

/** Characters cmd.exe interprets before argv splitting happens. */
const CMD_METACHARACTERS = /[()%!^"<>&|]/g;

/**
 * Escape a quoted argument for cmd.exe's own parsing pass.
 *
 * `cmd.exe /s /c "<line>"` strips the outer quotes and runs the remainder, so
 * metacharacters inside still reach cmd's parser. Prefixing each with a caret
 * neutralises it.
 */
export function escapeForCmd(quoted: string): string {
  return quoted.replace(CMD_METACHARACTERS, (match) => `^${match}`);
}

/**
 * Build the full argument vector for invoking a Windows shim through cmd.exe.
 *
 * `/d` skips AutoRun registry commands, which would otherwise execute
 * arbitrary configured code before ours. `/s` fixes the quote-stripping rule so
 * the line is parsed predictably. `/c` runs and exits.
 */
export function buildCmdInvocation(
  program: string,
  args: readonly string[],
): { file: string; args: string[]; windowsVerbatimArguments: true } {
  const line = [program, ...args].map((part) => escapeForCmd(quoteArgvW(part))).join(' ');
  return {
    file: process.env.COMSPEC ?? 'cmd.exe',
    // The whole line is wrapped in quotes, as /s expects.
    args: ['/d', '/s', '/c', `"${line}"`],
    // Node must not re-quote what has already been quoted deliberately.
    windowsVerbatimArguments: true,
  };
}

/** True when a resolved program path is a batch shim needing cmd.exe. */
export function isBatchShim(resolvedPath: string): boolean {
  return /\.(?:cmd|bat)$/i.test(resolvedPath);
}
