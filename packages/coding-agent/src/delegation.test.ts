import { Redactor } from '@aica/security-engine';
import { errors, isErr, ok, unwrap } from '@aica/shared';
import type { Result } from '@aica/shared';
import { describe, expect, it } from 'vitest';

import type {
  CodingActivity,
  CodingAgentProvider,
  CodingResult,
  CodingSession,
  CodingSessionState,
  CodingTask,
} from './contract.js';
import type { DelegationEvent, ValidationOutcome, ValidationRunner } from './delegation.js';
import { Delegator, buildRepairInstruction, countChangedFiles } from './delegation.js';

const DIFF = '--- a/src/api/client.ts\n+++ b/src/api/client.ts\n@@ -1 +1 @@\n-a\n+b\n';

const TASK: CodingTask = {
  brief: '# Objective\n\nIntegrate POST /refunds.',
  title: 'Integrate POST /refunds',
  repository: { sourceId: 'github-acme-shop' },
};

/**
 * A scriptable provider.
 *
 * The state script is consumed one entry per poll, so a test states the exact
 * sequence the provider will report and the loop is driven through it
 * deterministically — no timers, no sleeping, no flakiness.
 */
class ScriptedProvider implements CodingAgentProvider {
  readonly name = 'scripted';
  readonly capabilities = { cancel: true, followUp: true, planApproval: true, unifiedDiff: true };

  readonly messages: string[] = [];
  readonly approvals: string[] = [];
  createCalls = 0;

  private index = 0;

  constructor(
    private readonly states: readonly CodingSessionState[],
    private readonly options: {
      changeSets?: readonly string[];
      failCreate?: boolean;
      failureReason?: string;
    } = {},
  ) {}

  async healthCheck(): Promise<Result<true>> {
    return ok(true);
  }

  async listRepositories() {
    return ok([{ sourceId: 'github-acme-shop' }]);
  }

  async createSession(): Promise<Result<CodingSession>> {
    this.createCalls += 1;
    if (this.options.failCreate) return { ok: false, error: errors.apiError('provider is down') };
    return ok(this.session(this.states[0] ?? 'queued'));
  }

  async getSession(): Promise<Result<CodingSession>> {
    this.index += 1;
    const state = this.states[Math.min(this.index, this.states.length - 1)] ?? 'completed';
    return ok(this.session(state));
  }

  async getActivities(): Promise<Result<readonly CodingActivity[]>> {
    return ok([]);
  }

  async sendMessage(_sessionId: string, message: string): Promise<Result<void>> {
    this.messages.push(message);
    // A follow-up restarts the session, so the script resumes from the top.
    this.index = 0;
    return ok(undefined);
  }

  async approvePlan(sessionId: string): Promise<Result<void>> {
    this.approvals.push(sessionId);
    return ok(undefined);
  }

  async getResult(): Promise<Result<CodingResult>> {
    const diffs = this.options.changeSets ?? [DIFF];
    return ok({
      sessionId: 'session-1',
      state: 'completed',
      changeSets: diffs.map((unifiedDiff) => ({ unifiedDiff })),
      ...(this.options.failureReason ? { failureReason: this.options.failureReason } : {}),
    });
  }

  async cancel(): Promise<Result<void>> {
    return ok(undefined);
  }

  private session(state: CodingSessionState): CodingSession {
    return {
      id: 'session-1',
      providerSessionId: 'session-1',
      state,
      title: TASK.title,
      createdAt: 0,
      updatedAt: 0,
      ...(state === 'failed' && this.options.failureReason
        ? { failureReason: this.options.failureReason }
        : {}),
    };
  }
}

/** Fails a scripted number of times, then passes. */
class ScriptedValidation implements ValidationRunner {
  calls = 0;

  constructor(private readonly outcomes: readonly ValidationOutcome[]) {}

  async validate(): Promise<Result<ValidationOutcome>> {
    const outcome =
      this.outcomes[Math.min(this.calls, this.outcomes.length - 1)] ??
      ({ passed: true, findings: [] } as ValidationOutcome);
    this.calls += 1;
    return ok(outcome);
  }
}

const FAILING: ValidationOutcome = {
  passed: false,
  findings: [
    {
      check: 'typecheck',
      message: "Property 'amount' is missing",
      file: 'src/api/client.ts',
      line: 42,
    },
  ],
};

const PASSING: ValidationOutcome = { passed: true, findings: [] };

function makeDelegator(
  provider: CodingAgentProvider,
  options: {
    validation?: ValidationRunner;
    events?: DelegationEvent[];
    maxRepairAttempts?: number;
    maxPolls?: number;
    maxDurationMs?: number;
    approvePlan?: (session: CodingSession) => Promise<boolean>;
  } = {},
): Delegator {
  let clock = 0;
  return new Delegator({
    provider,
    redactor: new Redactor(),
    ...(options.validation ? { validation: options.validation } : {}),
    ...(options.approvePlan ? { approvePlan: options.approvePlan } : {}),
    maxRepairAttempts: options.maxRepairAttempts ?? 2,
    maxPolls: options.maxPolls ?? 20,
    ...(options.maxDurationMs !== undefined ? { maxDurationMs: options.maxDurationMs } : {}),
    pollIntervalMs: 1,
    // A virtual clock keeps the tests instant and deterministic.
    now: () => (clock += 100),
    sleep: async () => undefined,
    ...(options.events ? { onEvent: (event) => options.events?.push(event) } : {}),
  });
}

// ---------------------------------------------------------------------------

describe('a successful delegation', () => {
  it('polls to completion, validates, and reports verified', async () => {
    const provider = new ScriptedProvider(['queued', 'running', 'completed']);
    const validation = new ScriptedValidation([PASSING]);
    const outcome = unwrap(await makeDelegator(provider, { validation }).run(TASK));

    expect(outcome.status).toBe('verified');
    expect(outcome.changeSet?.unifiedDiff).toBe(DIFF);
    expect(outcome.repairAttempts).toBe(0);
    expect(validation.calls).toBe(1);
  });

  it('emits the documented lifecycle events', async () => {
    const events: DelegationEvent[] = [];
    const provider = new ScriptedProvider(['queued', 'running', 'completed']);
    await makeDelegator(provider, { validation: new ScriptedValidation([PASSING]), events }).run(
      TASK,
    );

    expect(events.map((event) => event.type)).toEqual([
      'coding_agent.session.created',
      'coding_agent.session.started',
      'coding_agent.session.progress',
      'coding_agent.session.completed',
      'coding_agent.validation.started',
      'coding_agent.validation.passed',
    ]);
  });

  it('reports how many files changed, without leaking their contents', async () => {
    const events: DelegationEvent[] = [];
    const provider = new ScriptedProvider(['completed']);
    await makeDelegator(provider, { validation: new ScriptedValidation([PASSING]), events }).run(
      TASK,
    );

    const completed = events.find((event) => event.type === 'coding_agent.session.completed');
    expect(completed?.filesChanged).toBe(1);
    expect(JSON.stringify(events)).not.toContain('+b');
  });
});

// ---------------------------------------------------------------------------

describe('the repair loop', () => {
  it('sends a repair instruction and revalidates', async () => {
    const provider = new ScriptedProvider(['completed']);
    const validation = new ScriptedValidation([FAILING, PASSING]);

    const outcome = unwrap(await makeDelegator(provider, { validation }).run(TASK));

    expect(outcome.status).toBe('verified');
    expect(outcome.repairAttempts).toBe(1);
    expect(provider.messages).toHaveLength(1);
    expect(provider.messages[0]).toContain("Property 'amount' is missing");
  });

  it('stops at the repair budget instead of looping forever', async () => {
    const provider = new ScriptedProvider(['completed']);
    const validation = new ScriptedValidation([FAILING]);

    const outcome = unwrap(
      await makeDelegator(provider, { validation, maxRepairAttempts: 2 }).run(TASK),
    );

    expect(outcome.status).toBe('repairExhausted');
    expect(outcome.repairAttempts).toBe(2);
    expect(provider.messages).toHaveLength(2);
    expect(outcome.findings).toHaveLength(1);
  });

  it('respects a zero repair budget', async () => {
    const provider = new ScriptedProvider(['completed']);
    const outcome = unwrap(
      await makeDelegator(provider, {
        validation: new ScriptedValidation([FAILING]),
        maxRepairAttempts: 0,
      }).run(TASK),
    );

    expect(outcome.status).toBe('repairExhausted');
    expect(provider.messages).toEqual([]);
  });

  it('emits repair events with their attempt number', async () => {
    const events: DelegationEvent[] = [];
    const provider = new ScriptedProvider(['completed']);
    await makeDelegator(provider, {
      validation: new ScriptedValidation([FAILING]),
      maxRepairAttempts: 1,
      events,
    }).run(TASK);

    const types = events.map((event) => event.type);
    expect(types).toContain('coding_agent.validation.failed');
    expect(types).toContain('coding_agent.repair.started');
    expect(types).toContain('coding_agent.repair.exhausted');
    expect(events.find((e) => e.type === 'coding_agent.repair.started')?.attempt).toBe(1);
  });
});

describe('buildRepairInstruction', () => {
  it('names the check, the file, the line, and the message', () => {
    const instruction = buildRepairInstruction(FAILING.findings);
    expect(instruction).toContain('[typecheck]');
    expect(instruction).toContain('src/api/client.ts:42');
    expect(instruction).toContain("Property 'amount' is missing");
  });

  it('forbids the shortcuts an agent reaches for under pressure', () => {
    const instruction = buildRepairInstruction(FAILING.findings);
    expect(instruction).toMatch(/do not disable or skip a check/i);
    expect(instruction).toMatch(/do not change unrelated files/i);
  });

  it('caps the list so one root cause is not buried under its cascade', () => {
    const many = Array.from({ length: 50 }, (_, index) => ({
      check: 'typecheck',
      message: `error ${index}`,
    }));
    const instruction = buildRepairInstruction(many);

    expect(instruction).toContain('30 further finding(s) were omitted');
    expect(instruction).not.toContain('error 40');
  });
});

// ---------------------------------------------------------------------------

describe('when validation is not configured', () => {
  it('returns the changes marked unvalidated rather than claiming success', async () => {
    const provider = new ScriptedProvider(['completed']);
    const outcome = unwrap(await makeDelegator(provider).run(TASK));

    // The one thing this must never do is call an unchecked patch verified.
    expect(outcome.status).toBe('unvalidated');
    expect(outcome.status).not.toBe('verified');
    expect(outcome.changeSet).toBeDefined();
    expect(outcome.message).toMatch(/not been checked/i);
  });
});

describe('provider failures', () => {
  it('surfaces a failed create as an error the orchestrator can handle', async () => {
    const provider = new ScriptedProvider(['queued'], { failCreate: true });
    const result = await makeDelegator(provider).run(TASK);

    expect(isErr(result)).toBe(true);
  });

  it('reports a failed session with its reason', async () => {
    const provider = new ScriptedProvider(['running', 'failed'], {
      failureReason: 'The repository could not be cloned.',
    });
    const outcome = unwrap(await makeDelegator(provider).run(TASK));

    expect(outcome.status).toBe('failed');
    expect(outcome.message).toContain('could not be cloned');
  });

  it('reports a session that finished with no changes', async () => {
    const provider = new ScriptedProvider(['completed'], { changeSets: [] });
    const outcome = unwrap(await makeDelegator(provider).run(TASK));

    expect(outcome.status).toBe('failed');
    expect(outcome.message).toMatch(/without producing any changes/i);
  });

  it('gives up after the poll cap rather than spinning', async () => {
    // A session that never leaves `running`.
    const provider = new ScriptedProvider(['running']);
    const result = await makeDelegator(provider, { maxPolls: 5 }).run(TASK);

    expect(isErr(result)).toBe(true);
    expect(isErr(result) && result.error.code).toBe('TIMEOUT');
  });

  it('gives up when the wall-clock budget is exhausted', async () => {
    const provider = new ScriptedProvider(['running']);
    // The virtual clock advances 100ms per read, so this budget expires fast.
    const result = await makeDelegator(provider, { maxDurationMs: 300, maxPolls: 1000 }).run(TASK);

    expect(isErr(result) && result.error.code).toBe('TIMEOUT');
    expect(isErr(result) && result.error.message).toMatch(/did not finish within/i);
  });
});

// ---------------------------------------------------------------------------

describe('plan approval', () => {
  it('stops and asks when no approver is configured', async () => {
    const provider = new ScriptedProvider(['awaitingApproval']);
    const outcome = unwrap(await makeDelegator(provider).run(TASK));

    expect(outcome.status).toBe('awaitingDecision');
    expect(provider.approvals).toEqual([]);
  });

  it('approves and continues when the approver agrees', async () => {
    const provider = new ScriptedProvider(['awaitingApproval', 'running', 'completed']);
    const outcome = unwrap(
      await makeDelegator(provider, {
        validation: new ScriptedValidation([PASSING]),
        approvePlan: async () => true,
      }).run(TASK),
    );

    expect(provider.approvals).toEqual(['session-1']);
    expect(outcome.status).toBe('verified');
  });

  it('stops when the approver declines', async () => {
    const provider = new ScriptedProvider(['awaitingApproval']);
    const outcome = unwrap(
      await makeDelegator(provider, { approvePlan: async () => false }).run(TASK),
    );

    expect(outcome.status).toBe('awaitingDecision');
    expect(provider.approvals).toEqual([]);
  });

  it('stops when the provider asks a question', async () => {
    const provider = new ScriptedProvider(['awaitingInput']);
    const outcome = unwrap(await makeDelegator(provider).run(TASK));
    expect(outcome.status).toBe('awaitingDecision');
  });
});

// ---------------------------------------------------------------------------

describe('countChangedFiles', () => {
  it('counts the files a diff touches', () => {
    expect(countChangedFiles(DIFF)).toBe(1);
    expect(countChangedFiles('+++ b/a.ts\n+++ b/b.ts\n+++ b/a.ts\n')).toBe(2);
    expect(countChangedFiles('no diff here')).toBe(0);
  });
});

describe('observability', () => {
  it('never puts the brief or a credential into an event', async () => {
    const events: DelegationEvent[] = [];
    const provider = new ScriptedProvider(['completed'], {
      failureReason: 'token was sk_live_51H8xQ2abcdefghijklmno',
    });

    await makeDelegator(provider, { events, validation: new ScriptedValidation([PASSING]) }).run({
      ...TASK,
      brief: 'secret brief contents',
    });

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('secret brief contents');
    expect(serialized).not.toContain('sk_live_51H8xQ2abcdefghijklmno');
  });

  it('tags every event with the provider name', async () => {
    const events: DelegationEvent[] = [];
    const provider = new ScriptedProvider(['completed']);
    await makeDelegator(provider, { events }).run(TASK);

    expect(events.every((event) => event.provider === 'scripted')).toBe(true);
  });
});
