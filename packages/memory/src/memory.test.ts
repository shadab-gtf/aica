import { ErrorCode } from '@aica/shared';
import { describe, expect, it, vi } from 'vitest';

import { looksLikeCredential } from './entry.js';
import { MemoryStore } from './store.js';

function store(options: ConstructorParameters<typeof MemoryStore>[0] = {}): MemoryStore {
  return new MemoryStore(options);
}

// ---------------------------------------------------------------------------
// The rule that matters most
// ---------------------------------------------------------------------------

describe('memory refuses to hold a credential', () => {
  it.each([
    ['sk-abcdefghijklmnopqrstuv', 'an OpenAI-style key'],
    ['sk-or-v1-0000000000000000000000000000', 'an OpenRouter key'],
    ['sb_secret_000000000000000000', 'a Supabase key'],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123', 'a GitHub token'],
    ['AKIAIOSFODNN7EXAMPLE', 'an AWS access key id'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc', 'a JWT'],
    ['-----BEGIN RSA PRIVATE KEY-----', 'a private key'],
    ['Bearer abcdefghijklmnopqrstuvwxyz', 'a bearer token'],
    ['PAYMENT_API_KEY=hunter2hunter2', 'an assignment'],
  ])('refuses %s', (value) => {
    const result = store().remember({ scope: 'project', key: 'some.key', value });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.INVALID_INPUT);
      // The message has to say what to do instead, or the caller just rephrases
      // until it slips through.
      expect(result.error.message).toContain('env:');
    }
  });

  it('refuses rather than storing a redacted placeholder', () => {
    // Redacting would mean the value had already been written somewhere, and
    // the caller would believe it remembered something useful.
    const memory = store();
    memory.remember({ scope: 'project', key: 'api.token', value: 'sk-abcdefghijklmnopqrst' });

    expect(memory.size).toBe(0);
    expect(memory.recall('api.token')).toBeUndefined();
  });

  it('accepts a secret reference, which is the shape it wants', () => {
    const result = store().remember({
      scope: 'project',
      key: 'payments.key',
      value: 'env:PAYMENT_API_KEY',
    });

    // Recording *where* a credential comes from, without the credential.
    expect(result.ok).toBe(true);
  });

  it('still scans a value that merely mentions a reference', () => {
    // "the key is env:FOO, currently sk-abc..." is exactly the mistake.
    const result = store().remember({
      scope: 'project',
      key: 'payments.key',
      value: 'the key is env:PAYMENT_API_KEY, currently sk-abcdefghijklmnopqrst',
    });

    expect(result.ok).toBe(false);
  });

  it('does not refuse ordinary prose that mentions the word token', () => {
    // A false refusal costs a rephrase; the rule still has to be usable.
    const result = store().remember({
      scope: 'project',
      key: 'auth.approach',
      value: 'Requests carry a bearer token read from the environment at startup.',
    });

    expect(result.ok).toBe(true);
  });

  it('catches a prefixed SCREAMING_SNAKE assignment', () => {
    // A word boundary treats `_` as a word char, so such a pattern misses
    // `PAYMENT_API_KEY` entirely — and that prefixed form is the commonest one.
    // The same mistake once made the MCP risk heuristic near-useless.
    for (const value of [
      'PAYMENT_API_KEY=hunter2hunter2',
      'STRIPE_SECRET=abcdefghijkl',
      'my_password: correcthorsebattery',
    ]) {
      expect(looksLikeCredential(value).isCredential, value).toBe(true);
    }
  });

  it('does not fire on prose that merely uses the word', () => {
    for (const value of [
      'the token: see above',
      'password rotation is handled by ops',
      'secrets live in the keychain',
    ]) {
      expect(looksLikeCredential(value).isCredential, value).toBe(false);
    }
  });

  it('classifies a bare value the same way outside the store', () => {
    expect(looksLikeCredential('env:FOO').isCredential).toBe(false);
    expect(looksLikeCredential('we use axios').isCredential).toBe(false);
    expect(looksLikeCredential('ghp_abcdefghijklmnopqrstuvwxyz0123').isCredential).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

describe('scope resolution', () => {
  function threeScopes(): MemoryStore {
    const memory = store();
    memory.remember({ scope: 'global', key: 'http.client', value: 'fetch' });
    memory.remember({ scope: 'project', key: 'http.client', value: 'axios' });
    memory.remember({ scope: 'task', key: 'http.client', value: 'ky' });
    return memory;
  }

  it('returns the most specific scope that has an opinion', () => {
    expect(threeScopes().recall('http.client')?.value).toBe('ky');
  });

  it('falls back outward when the specific scopes are silent', () => {
    const memory = store();
    memory.remember({ scope: 'global', key: 'editor', value: 'vscode' });
    expect(memory.recall('editor')?.value).toBe('vscode');
  });

  it('shows the whole chain, because "why does it believe that" has an answer', () => {
    const chain = threeScopes().recallAll('http.client');

    expect(chain.map((entry) => entry.scope)).toEqual(['task', 'project', 'global']);
    // A shadowed fact is not gone, and a surprising behaviour is explained by
    // seeing both.
    expect(chain.map((entry) => entry.value)).toEqual(['ky', 'axios', 'fetch']);
  });

  it('hides shadowed entries from the effective set', () => {
    const effective = threeScopes().effective();

    expect(effective).toHaveLength(1);
    expect(effective[0]?.value).toBe('ky');
  });

  it('drops a whole scope when a task ends', () => {
    const memory = threeScopes();
    expect(memory.forgetScope('task')).toBe(1);

    // The project belief is intact underneath.
    expect(memory.recall('http.client')?.value).toBe('axios');
  });

  it('forgets one entry without touching the others', () => {
    const memory = threeScopes();
    expect(memory.forget('project', 'http.client')).toBe(true);
    expect(memory.forget('project', 'http.client')).toBe(false);
    expect(memory.recallAll('http.client').map((entry) => entry.scope)).toEqual(['task', 'global']);
  });
});

// ---------------------------------------------------------------------------
// Keys and values
// ---------------------------------------------------------------------------

describe('what a memory may be', () => {
  it.each(['http.client', 'db', 'test-runner', 'api.base-url'])('accepts the key %s', (key) => {
    expect(store().remember({ scope: 'project', key, value: 'x' }).ok).toBe(true);
  });

  it.each(['we use axios here', 'HTTP.Client', '.leading', 'trailing.', ''])(
    'rejects the key %s',
    (key) => {
      // A key is a name a later run can find again, not a sentence.
      expect(store().remember({ scope: 'project', key, value: 'x' }).ok).toBe(false);
    },
  );

  it('keeps the original creation time across an update', () => {
    let clock = 1_000;
    const memory = store({ now: () => clock });

    memory.remember({ scope: 'project', key: 'http.client', value: 'axios' });
    clock = 2_000;
    const updated = memory.remember({ scope: 'project', key: 'http.client', value: 'ky' });

    expect(updated.ok).toBe(true);
    if (updated.ok) {
      // When a belief was first formed is part of judging whether it still holds.
      expect(updated.value.createdAt).toBe(new Date(1_000).toISOString());
      expect(updated.value.updatedAt).toBe(new Date(2_000).toISOString());
    }
  });

  it('keeps provenance, because a memory without it is a rumour', () => {
    const result = store().remember({
      scope: 'project',
      key: 'http.client',
      value: 'axios',
      source: 'observed in src/api/client.ts',
    });

    expect(result.ok && result.value.source).toBe('observed in src/api/client.ts');
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe('persistence', () => {
  it('writes through without letting a failure reach the caller', () => {
    const sink = vi.fn(() => {
      throw new Error('the database is down');
    });

    const result = store({ sink }).remember({ scope: 'project', key: 'a.b', value: 'x' });

    // Remembering for the rest of a run is worth having even when it will not
    // survive a restart.
    expect(result.ok).toBe(true);
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('survives a rejected async sink', async () => {
    const sink = vi.fn(async () => {
      throw new Error('timeout');
    });

    expect(store({ sink }).remember({ scope: 'project', key: 'a.b', value: 'x' }).ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it('re-checks stored values on the way back in', () => {
    const memory = store();
    const loaded = memory.hydrate([
      {
        scope: 'project',
        key: 'good.fact',
        value: 'we use axios',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
      {
        // Written by an older build, before the rule existed. Being on disk
        // already does not earn it a pass.
        scope: 'project',
        key: 'bad.fact',
        value: 'ghp_abcdefghijklmnopqrstuvwxyz0123',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
      { scope: 'project', key: 'malformed' },
    ]);

    expect(loaded).toBe(1);
    expect(memory.recall('bad.fact')).toBeUndefined();
    expect(memory.recall('good.fact')?.value).toBe('we use axios');
  });
});

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

describe('rendering for a prompt', () => {
  it('renders nothing when there is nothing to say', () => {
    expect(store().render()).toMatchObject({ text: '', included: 0 });
  });

  it('says a memory is recollection, not instruction', () => {
    const memory = store();
    memory.remember({ scope: 'project', key: 'http.client', value: 'axios' });

    const rendered = memory.render();
    // §2: the code in front of the model outranks a note from last week.
    expect(rendered.text).toContain('recollection, not instruction');
    expect(rendered.text).toContain('the code is right and the note is stale');
    expect(rendered.text).toContain('http.client: axios');
  });

  it('caps how many memories reach a prompt, and reports the rest', () => {
    const memory = store({ maxRendered: 3 });
    for (let index = 0; index < 10; index += 1) {
      memory.remember({ scope: 'project', key: `fact.n${index}`, value: `value ${index}` });
    }

    const rendered = memory.render();
    // Every memory loaded is tokens spent on a belief rather than on the code.
    expect(rendered.included).toBe(3);
    expect(rendered.omitted).toBe(7);
  });

  it('keeps the most recently confirmed when it has to choose', () => {
    let clock = 1_000;
    const memory = store({ now: () => clock, maxRendered: 1 });

    memory.remember({ scope: 'project', key: 'old.fact', value: 'stale' });
    clock = 5_000;
    memory.remember({ scope: 'project', key: 'new.fact', value: 'fresh' });

    // A fact re-established recently is likelier to still hold.
    expect(memory.render().text).toContain('new.fact');
    expect(memory.render().text).not.toContain('old.fact');
  });

  it('renders the same set identically every time', () => {
    const build = (): MemoryStore => {
      const memory = store();
      for (const key of ['z.one', 'a.two', 'm.three']) {
        memory.remember({ scope: 'project', key, value: key });
      }
      return memory;
    };

    // A prompt that reorders between runs cannot be diffed when behaviour
    // changes.
    expect(build().render().text).toBe(build().render().text);
  });

  it('respects a character budget as well as a count', () => {
    const memory = store({ maxRenderedChars: 60 });
    for (let index = 0; index < 5; index += 1) {
      memory.remember({ scope: 'project', key: `fact.n${index}`, value: 'x'.repeat(40) });
    }

    expect(memory.render().included).toBeLessThan(5);
  });

  it('loads the single best memory even when it alone exceeds the budget', () => {
    const memory = store({ maxRenderedChars: 10 });
    memory.remember({ scope: 'project', key: 'long.fact', value: 'x'.repeat(500) });

    // Refusing everything because the only relevant note is large would give
    // the user nothing at all.
    expect(memory.render().included).toBe(1);
  });
});
