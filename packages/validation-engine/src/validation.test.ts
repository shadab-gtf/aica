import { describe, expect, it } from 'vitest';

import { categorize, diagnose, groupFindings, toRepairInstruction } from './diagnosis.js';
import type { CheckResult, ValidationFinding, ValidationReport } from './findings.js';
import { CHECK_ORDER, describeReport, errorsOf } from './findings.js';
import {
  parseBuild,
  parseLint,
  parseTests,
  parseTypecheck,
  parseUnknown,
  stripAnsi,
} from './parsers.js';
import { RepairOutcome, runRepairLoop } from './repair.js';
import { ok } from '@aica/shared';
import type { Result } from '@aica/shared';

// ---------------------------------------------------------------------------
// Parsers — real output shapes, not invented ones
// ---------------------------------------------------------------------------

describe('parseTypecheck', () => {
  it('parses the parenthesised tsc format', () => {
    const output = `src/api/client.ts(42,17): error TS2741: Property 'amount' is missing in type 'Refund'.`;
    expect(parseTypecheck(output)).toEqual([
      {
        check: 'typecheck',
        file: 'src/api/client.ts',
        line: 42,
        column: 17,
        severity: 'error',
        code: 'TS2741',
        message: "Property 'amount' is missing in type 'Refund'.",
      },
    ]);
  });

  it('parses the pretty tsc format', () => {
    const output = `packages/api/src/x.ts:7:3 - error TS2322: Type 'string' is not assignable to type 'number'.`;
    expect(parseTypecheck(output)[0]).toMatchObject({
      file: 'packages/api/src/x.ts',
      line: 7,
      column: 3,
      code: 'TS2322',
    });
  });

  it('keeps an error that names no file at all', () => {
    // TS18003 has no location; a file-anchored parser would drop it entirely.
    const findings = parseTypecheck('error TS18003: No inputs were found in config file.');

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ code: 'TS18003', severity: 'error' });
    // The location is genuinely absent rather than invented.
    expect(findings[0]?.file).toBeUndefined();
    expect(findings[0]?.line).toBeUndefined();
  });

  it('distinguishes warnings from errors', () => {
    const findings = parseTypecheck('src/a.ts(1,1): warning TS6133: unused.');
    expect(findings[0]?.severity).toBe('warning');
  });

  it('finds nothing in clean output', () => {
    expect(parseTypecheck('')).toEqual([]);
    expect(parseTypecheck('Compilation complete.')).toEqual([]);
  });

  it('strips ANSI colour before matching', () => {
    const coloured = `[96msrc/a.ts[0m(1,1): [91merror[0m TS1005: ';' expected.`;
    expect(parseTypecheck(coloured)[0]).toMatchObject({ file: 'src/a.ts', code: 'TS1005' });
  });
});

describe('parseLint', () => {
  it('prefers the JSON formatter', () => {
    const output = JSON.stringify([
      {
        filePath: '/repo/src/a.ts',
        messages: [
          {
            ruleId: 'no-unused-vars',
            severity: 2,
            message: "'x' is defined but never used.",
            line: 3,
            column: 7,
          },
          { ruleId: 'eqeqeq', severity: 1, message: 'Expected ===.', line: 9, column: 1 },
        ],
      },
    ]);

    const findings = parseLint(output);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({ code: 'no-unused-vars', severity: 'error', line: 3 });
    expect(findings[1]?.severity).toBe('warning');
  });

  it('falls back to the stylish text format', () => {
    const output = [
      '/repo/src/api/client.ts',
      '  12:5   error    Unexpected console statement  no-console',
      '  20:1   warning  Missing return type           @typescript-eslint/explicit-function-return-type',
      '',
      '2 problems (1 error, 1 warning)',
    ].join('\n');

    const findings = parseLint(output);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      file: '/repo/src/api/client.ts',
      line: 12,
      severity: 'error',
      code: 'no-console',
    });
  });

  it('returns nothing for a clean run', () => {
    expect(parseLint('[]')).toEqual([]);
  });
});

describe('parseTests', () => {
  it('captures the test name, the assertion, and the project location', () => {
    const output = [
      ' FAIL  src/api/client.test.ts > createRefund > rejects an expired token',
      'AssertionError: expected 401 to be 200',
      '    at node_modules/vitest/dist/index.js:1:1',
      '    at src/api/client.test.ts:57:9',
    ].join('\n');

    const findings = parseTests(output);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      check: 'test',
      testName: 'src/api/client.test.ts > createRefund > rejects an expired token',
      message: 'AssertionError: expected 401 to be 200',
      file: 'src/api/client.test.ts',
      line: 57,
    });
  });

  it('skips node_modules frames when locating the failure', () => {
    const output = [
      '× breaks',
      'Error: boom',
      '    at /repo/node_modules/lib/index.js:9:1',
      '    at src/real.ts:3:2',
    ].join('\n');
    expect(parseTests(output)[0]?.file).toBe('src/real.ts');
  });

  it('reports a failing run even when no individual test could be parsed', () => {
    const findings = parseTests('Tests  3 failed | 10 passed');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/3 test\(s\) failed/);
  });

  it('finds nothing in a passing run', () => {
    expect(parseTests('Tests  12 passed (12)')).toEqual([]);
  });
});

describe('parseBuild', () => {
  it('recognizes type errors emitted by a build', () => {
    const findings = parseBuild('src/a.ts(3,1): error TS2304: Cannot find name x.');
    expect(findings[0]).toMatchObject({ check: 'build', code: 'TS2304' });
  });

  it('keeps an unrecognized error line verbatim', () => {
    const findings = parseBuild('ERROR: Could not resolve "./missing" from src/a.ts');
    expect(findings[0]?.message).toContain('Could not resolve');
  });

  it('ignores a summary count line', () => {
    expect(parseBuild('3 errors')).toEqual([]);
  });
});

describe('parseUnknown', () => {
  it('preserves the tail of the output rather than reporting nothing', () => {
    // A failure with nothing to act on is the worst outcome the loop can give.
    const findings = parseUnknown('e2e', 'line one\nline two\nthe actual error', 1);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('the actual error');
  });

  it('says so when there was no output at all', () => {
    expect(parseUnknown('e2e', '', 137)[0]?.message).toMatch(/produced no output/);
  });
});

describe('stripAnsi', () => {
  it('removes colour codes and leaves the text', () => {
    expect(stripAnsi('[31mred[0m')).toBe('red');
  });
});

// ---------------------------------------------------------------------------
// Diagnosis
// ---------------------------------------------------------------------------

function finding(overrides: Partial<ValidationFinding> = {}): ValidationFinding {
  return {
    check: 'typecheck',
    severity: 'error',
    message: 'Something is wrong',
    ...overrides,
  };
}

function report(overrides: Partial<ValidationReport> = {}): ValidationReport {
  const results: CheckResult[] = overrides.results
    ? [...overrides.results]
    : [
        {
          check: 'typecheck',
          passed: false,
          command: 'tsc',
          exitCode: 1,
          durationMs: 10,
          timedOut: false,
          truncated: false,
          findings: overrides.findings ?? [finding()],
        },
      ];

  return {
    passed: false,
    results,
    findings: results.flatMap((result) => result.findings),
    durationMs: 10,
    firstFailure: 'typecheck',
    ...overrides,
  };
}

describe('categorize', () => {
  it.each([
    [finding({ code: 'TS2741', message: "Property 'x' is missing" }), 'typeError'],
    [finding({ code: 'TS2307', message: "Cannot find module './x'" }), 'missingModule'],
    [finding({ code: 'TS18003', message: 'No inputs were found' }), 'toolingProblem'],
    [finding({ check: 'lint', message: 'Unexpected console' }), 'styleViolation'],
    [finding({ check: 'test', message: 'expected 401 to be 200' }), 'assertionFailure'],
    [finding({ check: 'test', message: 'TypeError: x is not a function' }), 'runtimeError'],
    [finding({ check: 'test', message: 'command not found: vitest' }), 'toolingProblem'],
  ])('classifies by what the message actually says', (input, expected) => {
    expect(categorize(input)).toBe(expected);
  });
});

describe('groupFindings', () => {
  it('collapses a cascade of one error code into a single group', () => {
    const findings = Array.from({ length: 20 }, (_, index) =>
      finding({ code: 'TS2741', file: 'src/api/client.ts', line: index + 1 }),
    );

    const groups = groupFindings(findings);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.findings).toHaveLength(20);
    expect(groups[0]?.summary).toContain('20 occurrences');
  });

  it('groups variants of one message shape together', () => {
    const groups = groupFindings([
      finding({ message: "Property 'amount' is missing" }),
      finding({ message: "Property 'currency' is missing" }),
    ]);
    expect(groups).toHaveLength(1);
  });

  it('ranks a concentrated cause above a scattered one', () => {
    const scattered = Array.from({ length: 4 }, (_, index) =>
      finding({ code: 'TS2322', file: `src/f${index}.ts` }),
    );
    const concentrated = Array.from({ length: 4 }, () =>
      finding({ code: 'TS2741', file: 'src/one.ts' }),
    );

    const groups = groupFindings([...scattered, ...concentrated]);
    expect(groups[0]?.files).toEqual(['src/one.ts']);
  });

  it('separates genuinely different causes', () => {
    const groups = groupFindings([
      finding({ code: 'TS2741' }),
      finding({ check: 'lint', code: 'no-console', message: 'Unexpected console' }),
    ]);
    expect(groups).toHaveLength(2);
  });
});

describe('diagnose', () => {
  it('says nothing is wrong when the report passed', () => {
    const diagnosis = diagnose(report({ passed: true, results: [], findings: [] }));
    expect(diagnosis).toMatchObject({ passed: true, repairable: false });
  });

  it('leads with the check that failed first', () => {
    const diagnosis = diagnose(report());
    expect(diagnosis.check).toBe('typecheck');
    expect(diagnosis.category).toBe('typeError');
    expect(diagnosis.repairable).toBe(true);
  });

  it('refuses to attempt repair on a timeout', () => {
    const timedOut = report({
      results: [
        {
          check: 'test',
          passed: false,
          command: 'vitest',
          exitCode: null,
          durationMs: 1,
          timedOut: true,
          truncated: false,
          findings: [finding({ check: 'test' })],
        },
      ],
    });

    const diagnosis = diagnose(timedOut);
    expect(diagnosis.category).toBe('timeout');
    expect(diagnosis.repairable).toBe(false);
    expect(diagnosis.rationale).toMatch(/says nothing about which code is wrong/i);
  });

  it('refuses to attempt repair when the tool itself is misconfigured', () => {
    const broken = report({
      results: [
        {
          check: 'lint',
          passed: false,
          command: 'eslint',
          exitCode: null,
          durationMs: 1,
          timedOut: false,
          truncated: false,
          skippedReason: 'Program "eslint" was not found',
          findings: [finding({ check: 'lint', message: 'could not be run' })],
        },
      ],
    });

    const diagnosis = diagnose(broken);
    expect(diagnosis.category).toBe('toolingProblem');
    expect(diagnosis.repairable).toBe(false);
  });

  it('warns that a missing module may be a dependency rather than a code error', () => {
    const diagnosis = diagnose(
      report({ findings: [finding({ code: 'TS2307', message: "Cannot find module 'left-pad'" })] }),
    );
    expect(diagnosis.category).toBe('missingModule');
    expect(diagnosis.rationale).toMatch(/verify before installing/i);
  });
});

describe('toRepairInstruction', () => {
  it('names the code, the message, and the location', () => {
    const instruction = toRepairInstruction(
      diagnose(
        report({
          findings: [
            finding({
              code: 'TS2741',
              message: "Property 'amount' is missing",
              file: 'src/a.ts',
              line: 42,
            }),
          ],
        }),
      ),
    );

    expect(instruction).toContain('TS2741');
    expect(instruction).toContain("Property 'amount' is missing");
    expect(instruction).toContain('src/a.ts:42');
  });

  it('forbids the shortcuts an agent reaches for under pressure', () => {
    const instruction = toRepairInstruction(diagnose(report()));
    expect(instruction).toMatch(/do not disable, skip, or weaken a check/i);
    expect(instruction).toMatch(/do not change unrelated files/i);
  });

  it('sends only the leading cause, not the whole cascade', () => {
    const findings = [
      ...Array.from({ length: 30 }, () => finding({ code: 'TS2741', file: 'src/a.ts' })),
      finding({ code: 'TS9999', file: 'src/b.ts', message: 'unrelated' }),
    ];

    const instruction = toRepairInstruction(diagnose(report({ findings })));
    expect(instruction).toContain('TS2741');
    expect(instruction).toMatch(/further occurrence\(s\) of the same cause/);
    expect(instruction).toMatch(/other group/);
  });
});

describe('describeReport', () => {
  it('summarizes a pass and a failure', () => {
    expect(describeReport(report({ passed: true }))).toMatch(/passed/);
    expect(describeReport(report())).toMatch(/Failed: typecheck \(1\)/);
  });
});

describe('errorsOf', () => {
  it('keeps errors and drops warnings', () => {
    expect(errorsOf([finding(), finding({ severity: 'warning' })])).toHaveLength(1);
  });
});

describe('CHECK_ORDER', () => {
  it('puts typecheck before test, so a cascade is not chased', () => {
    expect(CHECK_ORDER.indexOf('typecheck')).toBeLessThan(CHECK_ORDER.indexOf('test'));
    expect(CHECK_ORDER.indexOf('lint')).toBeLessThan(CHECK_ORDER.indexOf('test'));
  });
});

// ---------------------------------------------------------------------------
// The repair loop
// ---------------------------------------------------------------------------

/** Returns each scripted report in turn. */
function scriptedValidate(
  reports: readonly ValidationReport[],
): () => Promise<Result<ValidationReport>> {
  let index = 0;
  return async () => {
    const next = reports[Math.min(index, reports.length - 1)] as ValidationReport;
    index += 1;
    return ok(next);
  };
}

const PASSING = report({ passed: true, results: [], findings: [], firstFailure: undefined });

function failingWith(count: number, code = 'TS2741'): ValidationReport {
  const findings = Array.from({ length: count }, (_, index) =>
    finding({ code, file: 'src/a.ts', line: index + 1 }),
  );
  return report({ findings });
}

describe('runRepairLoop', () => {
  it('does nothing when validation already passes', async () => {
    let repairs = 0;
    const result = await runRepairLoop({
      validate: scriptedValidate([PASSING]),
      repair: async () => {
        repairs += 1;
        return true;
      },
      maxAttempts: 3,
    });

    expect(result.ok && result.value.outcome).toBe(RepairOutcome.passed);
    expect(repairs).toBe(0);
  });

  it('repairs and reports success', async () => {
    const instructions: string[] = [];
    const result = await runRepairLoop({
      validate: scriptedValidate([failingWith(3), PASSING]),
      repair: async (instruction) => {
        instructions.push(instruction);
        return true;
      },
      maxAttempts: 3,
    });

    expect(result.ok && result.value.outcome).toBe(RepairOutcome.passed);
    expect(result.ok && result.value.attempts).toBe(1);
    expect(instructions[0]).toContain('TS2741');
  });

  it('stops at the attempt cap', async () => {
    let repairs = 0;
    // Each attempt reduces the count, so progress is real but never enough.
    const result = await runRepairLoop({
      validate: scriptedValidate([failingWith(5), failingWith(4), failingWith(3), failingWith(2)]),
      repair: async () => {
        repairs += 1;
        return true;
      },
      maxAttempts: 2,
    });

    expect(result.ok && result.value.outcome).toBe(RepairOutcome.exhausted);
    expect(repairs).toBe(2);
  });

  it('never repairs when the budget is zero', async () => {
    let repairs = 0;
    const result = await runRepairLoop({
      validate: scriptedValidate([failingWith(1)]),
      repair: async () => {
        repairs += 1;
        return true;
      },
      maxAttempts: 0,
    });

    expect(repairs).toBe(0);
    expect(result.ok && result.value.outcome).toBe(RepairOutcome.exhausted);
  });

  it('stops when an attempt changes nothing', async () => {
    // Repeating a prompt that already failed only spends the budget.
    let repairs = 0;
    const same = failingWith(2);
    const result = await runRepairLoop({
      validate: scriptedValidate([same, same, same, same]),
      repair: async () => {
        repairs += 1;
        return true;
      },
      maxAttempts: 5,
    });

    expect(result.ok && result.value.outcome).toBe(RepairOutcome.noProgress);
    expect(repairs).toBe(1);
    expect(result.ok && result.value.reason).toMatch(/did not change the failures/i);
  });

  it('stops and says so when an attempt makes things worse', async () => {
    const result = await runRepairLoop({
      validate: scriptedValidate([failingWith(2), failingWith(9)]),
      repair: async () => true,
      maxAttempts: 3,
    });

    expect(result.ok && result.value.outcome).toBe(RepairOutcome.regressed);
    expect(result.ok && result.value.reason).toMatch(/increased the failures from 2 to 9/);
  });

  it('does not spend an attempt on something an edit cannot fix', async () => {
    let repairs = 0;
    const timedOut = report({
      results: [
        {
          check: 'test',
          passed: false,
          command: 'vitest',
          exitCode: null,
          durationMs: 1,
          timedOut: true,
          truncated: false,
          findings: [finding({ check: 'test' })],
        },
      ],
    });

    const result = await runRepairLoop({
      validate: scriptedValidate([timedOut]),
      repair: async () => {
        repairs += 1;
        return true;
      },
      maxAttempts: 3,
    });

    expect(result.ok && result.value.outcome).toBe(RepairOutcome.notRepairable);
    expect(repairs).toBe(0);
  });

  it('reports when the repair action could not act', async () => {
    const result = await runRepairLoop({
      validate: scriptedValidate([failingWith(1)]),
      repair: async () => false,
      maxAttempts: 3,
    });

    expect(result.ok && result.value.outcome).toBe(RepairOutcome.actionFailed);
  });

  it('records a history of what each attempt changed', async () => {
    const result = await runRepairLoop({
      validate: scriptedValidate([failingWith(4), failingWith(2), PASSING]),
      repair: async () => true,
      maxAttempts: 3,
    });

    expect(result.ok && result.value.history).toEqual([
      {
        attempt: 1,
        errorsBefore: 4,
        errorsAfter: 2,
        category: 'typeError',
        summary: expect.any(String),
      },
      {
        attempt: 2,
        errorsBefore: 2,
        errorsAfter: 0,
        category: 'typeError',
        summary: expect.any(String),
      },
    ]);
  });

  it('honours cancellation', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runRepairLoop({
      validate: scriptedValidate([failingWith(1)]),
      repair: async () => true,
      maxAttempts: 3,
      signal: controller.signal,
    });

    expect(result.ok && result.value.reason).toBe('Cancelled.');
  });
});
