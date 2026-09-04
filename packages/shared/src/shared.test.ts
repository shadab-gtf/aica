import { describe, expect, it, vi } from 'vitest';

import { all, andThen, err, isErr, isOk, mapErr, ok, partition, unwrap } from './result.js';
import { AgentError, ErrorCode, errors } from './errors.js';
import { isId, newId, stableId } from './ids.js';
import { ManualClock } from './clock.js';
import { EventBus, type AgentEvent } from './events.js';
import { RunEmitter } from './emitter.js';
import { MemorySink, createLogger } from './logger.js';
import { attempt, mapConcurrent, retry, withTimeout } from './async.js';
import { Limits, previewJson, truncate } from './limits.js';

describe('Result', () => {
  it('narrows ok and err', () => {
    const good = ok(1);
    const bad = err(errors.notFound('missing'));
    expect(isOk(good)).toBe(true);
    expect(isErr(bad)).toBe(true);
    expect(unwrap(good)).toBe(1);
  });

  it('short-circuits andThen on error', () => {
    const step = vi.fn(() => ok(2));
    const result = andThen(err(errors.internal('boom')), step);
    expect(step).not.toHaveBeenCalled();
    expect(isErr(result)).toBe(true);
  });

  it('all() fails on the first error and keeps order otherwise', () => {
    expect(unwrap(all([ok(1), ok(2), ok(3)]))).toEqual([1, 2, 3]);
    const failed = all([ok(1), err(errors.notFound('x')), ok(3)]);
    expect(isErr(failed)).toBe(true);
  });

  it('partition keeps both sides', () => {
    const { values, errors: failures } = partition([ok('a'), err(errors.notFound('b')), ok('c')]);
    expect(values).toEqual(['a', 'c']);
    expect(failures).toHaveLength(1);
  });

  it('mapErr transforms only the error channel', () => {
    const mapped = mapErr(err(errors.notFound('gone')), (e) => e.code);
    expect(isErr(mapped) && mapped.error).toBe(ErrorCode.NOT_FOUND);
  });
});

describe('AgentError', () => {
  it('derives retryability from the code', () => {
    expect(errors.timeout('slow').retryable).toBe(true);
    expect(errors.permissionDenied('no').retryable).toBe(false);
  });

  it('classifies Node filesystem and network codes', () => {
    const enoent = Object.assign(new Error('nope'), { code: 'ENOENT' });
    expect(AgentError.from(enoent).code).toBe(ErrorCode.NOT_FOUND);

    const refused = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    const converted = AgentError.from(refused);
    expect(converted.code).toBe(ErrorCode.NETWORK_ERROR);
    expect(converted.retryable).toBe(true);
  });

  it('passes an existing AgentError through unchanged', () => {
    const original = errors.conflict('spec disagrees with itself');
    expect(AgentError.from(original)).toBe(original);
  });

  it('serialises without dropping details', () => {
    const json = errors.invalidInput('bad path', { path: 'x/y' }).toJSON();
    expect(json).toMatchObject({
      code: ErrorCode.INVALID_INPUT,
      message: 'bad path',
      retryable: false,
      details: { path: 'x/y' },
    });
  });

  it('survives a non-Error throw', () => {
    const converted = AgentError.from('plain string failure');
    expect(converted.code).toBe(ErrorCode.INTERNAL);
    expect(converted.message).toBe('plain string failure');
  });
});

describe('ids', () => {
  it('produces recognisable prefixed ids', () => {
    const id = newId('run');
    expect(id.startsWith('run_')).toBe(true);
    expect(isId(id, 'run')).toBe(true);
    expect(isId(id, 'proj')).toBe(false);
  });

  it('rejects a bare prefix as an id', () => {
    expect(isId('run_', 'run')).toBe(false);
  });

  it('stableId is deterministic and input-sensitive', () => {
    expect(stableId('ep', 'POST', '/payments')).toBe(stableId('ep', 'POST', '/payments'));
    expect(stableId('ep', 'POST', '/payments')).not.toBe(stableId('ep', 'GET', '/payments'));
  });
});

describe('EventBus and RunEmitter', () => {
  it('assigns monotonic per-run sequence numbers', () => {
    const bus = new EventBus();
    const seen: AgentEvent[] = [];
    bus.subscribe((event) => seen.push(event));

    const runId = newId('run');
    const emitter = new RunEmitter({
      bus,
      runId,
      projectId: newId('proj'),
      clock: new ManualClock(0),
    });

    emitter.status('first');
    emitter.status('second');

    expect(seen.map((e) => e.seq)).toEqual([1, 2]);
    expect(seen.every((e) => e.runId === runId)).toBe(true);
  });

  it('keeps sequences independent across runs', () => {
    const bus = new EventBus();
    const a = newId('run');
    const b = newId('run');
    expect(bus.nextSeq(a)).toBe(1);
    expect(bus.nextSeq(b)).toBe(1);
    expect(bus.nextSeq(a)).toBe(2);
  });

  it('isolates a throwing listener so other consumers still receive events', () => {
    const failures: unknown[] = [];
    const bus = new EventBus((error) => failures.push(error));
    const received: string[] = [];

    bus.subscribe(() => {
      throw new Error('broken UI consumer');
    });
    bus.subscribe((event) => received.push(event.type));

    new RunEmitter({ bus, runId: newId('run'), projectId: newId('proj') }).status('ping');

    expect(received).toEqual(['STATUS']);
    expect(failures).toHaveLength(1);
  });

  it('routes every payload through the sanitizer', () => {
    const bus = new EventBus();
    const seen: AgentEvent[] = [];
    bus.subscribe((event) => seen.push(event));

    const emitter = new RunEmitter({
      bus,
      runId: newId('run'),
      projectId: newId('proj'),
      sanitize: <T>(value: T): T =>
        JSON.parse(JSON.stringify(value).replaceAll('sk-live-abc', '[REDACTED]')) as T,
    });

    emitter.status('key is sk-live-abc');
    expect(JSON.stringify(seen[0]?.payload)).toContain('[REDACTED]');
    expect(JSON.stringify(seen[0]?.payload)).not.toContain('sk-live-abc');
  });
});

describe('logger', () => {
  it('respects the level threshold', () => {
    const sink = new MemorySink();
    const log = createLogger({ level: 'warn', sink: sink.write });
    log.debug('hidden');
    log.info('hidden');
    log.warn('shown');
    log.error('shown');
    expect(sink.records.map((r) => r.level)).toEqual(['warn', 'error']);
  });

  it('applies the sanitizer to message and fields', () => {
    const sink = new MemorySink();
    const log = createLogger({
      level: 'debug',
      sink: sink.write,
      sanitize: <T>(value: T): T =>
        JSON.parse(JSON.stringify(value).replaceAll('hunter2', '[REDACTED]')) as T,
    });
    log.info('password is hunter2', { token: 'hunter2' });
    const record = sink.records[0];
    expect(record?.message).toContain('[REDACTED]');
    expect(record?.fields?.token).toBe('[REDACTED]');
  });

  it('child loggers nest scope and inherit bound fields', () => {
    const sink = new MemorySink();
    const log = createLogger({ level: 'debug', sink: sink.write, scope: 'aica' });
    log.child('tools', { runId: 'run_1' }).child('fs').info('read');
    expect(sink.records[0]?.scope).toBe('aica:tools:fs');
    expect(sink.records[0]?.fields?.runId).toBe('run_1');
  });
});

describe('async boundaries', () => {
  it('returns a TIMEOUT result rather than throwing', async () => {
    const result = await withTimeout(
      (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
      { timeoutMs: 20, label: 'slow op' },
    );
    expect(isErr(result) && result.error.code).toBe(ErrorCode.TIMEOUT);
  });

  it('propagates an outer abort as ABORTED', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await withTimeout(async () => 'value', {
      timeoutMs: 1_000,
      label: 'op',
      signal: controller.signal,
    });
    expect(isErr(result) && result.error.code).toBe(ErrorCode.ABORTED);
  });

  it('converts a throw into a Result', async () => {
    const result = await attempt(async () => {
      throw new Error('kaboom');
    });
    expect(isErr(result) && result.error.message).toBe('kaboom');
  });

  it('retries retryable failures and stops on non-retryable ones', async () => {
    let calls = 0;
    const flaky = await retry(
      async () => {
        calls += 1;
        return calls < 3 ? err(errors.timeout('again')) : ok('done');
      },
      { attempts: 5, baseDelayMs: 0, random: () => 0 },
    );
    expect(flaky).toEqual(ok('done'));
    expect(calls).toBe(3);

    let denied = 0;
    const blocked = await retry(
      async () => {
        denied += 1;
        return err(errors.permissionDenied('nope'));
      },
      { attempts: 5, baseDelayMs: 0, random: () => 0 },
    );
    expect(isErr(blocked)).toBe(true);
    expect(denied).toBe(1);
  });

  it('mapConcurrent preserves order under a concurrency cap', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapConcurrent([1, 2, 3, 4, 5, 6], 2, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe('limits', () => {
  it('marks truncation explicitly', () => {
    expect(truncate('abcdef', 10)).toBe('abcdef');
    expect(truncate('abcdef', 3)).toContain('truncated 3 characters');
  });

  it('previewJson never throws on a circular value', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(previewJson(circular)).toBe('[unserializable]');
  });

  it('repair attempts default to the specified maximum of 3', () => {
    expect(Limits.maxRepairAttempts).toBe(3);
  });
});
