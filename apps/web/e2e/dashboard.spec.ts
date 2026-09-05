import { expect, test } from '@playwright/test';

// @ts-expect-error — a plain .mjs harness, deliberately untyped: it is a test
// fixture that starts a process, not a module the app depends on.
import { AGENT_TOKEN, callAgent, startAgentServer } from './harness.mjs';

/**
 * The dashboard, end to end.
 *
 * A real agent server holding a real indexed project, a production build of
 * this app, and a real browser. What is being checked is mostly not "does it
 * render" — it is whether the page tells the truth about state the user cannot
 * otherwise see, and whether the token stays where it belongs.
 */

let server: { projectId: string; projectRoot: string; stop: () => void };

test.beforeAll(async () => {
  server = await startAgentServer();
});

test.afterAll(() => {
  server?.stop();
});

test.describe('the overview', () => {
  test('shows counted facts about the indexed project', async ({ page }) => {
    await page.goto('/');

    // The project is a copy of the fixture in a temporary directory, so its
    // name is whatever that directory is called; the file count is the fixture's.
    await expect(page.locator('h1')).toBeVisible();

    // Seven files in the fixture, and the same figure the indexer is gated on.
    const files = page.locator('.stat', { hasText: 'Files indexed' });
    await expect(files.locator('.value')).toHaveText('7');
  });

  test('explains what the resolution rate does not cover', async ({ page }) => {
    await page.goto('/');

    // A percentage on its own reads as a defect. The page has to say why the
    // remainder is counted rather than attributed.
    //
    // Asserted against the panel's whole text because the sentence is broken up
    // by markup — a text locator would be matching how the page is built rather
    // than what it says.
    const panel = page.locator('.panel').filter({ hasText: 'references were attributed' });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('would point at the wrong function');
  });

  test('says Postman is not connected rather than showing nothing', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('not configured')).toBeVisible();
  });
});

test.describe('the API catalog', () => {
  test('lists the imported specification and its endpoint', async ({ page }) => {
    await page.goto('/apis');

    await expect(page.getByRole('heading', { name: /api\.example\.com/ })).toBeVisible();
    await expect(page.locator('td.method', { hasText: 'GET' })).toBeVisible();
    // The path appears twice — once as the path, once inside the summary the
    // cURL parser derived — so the locator names which one it means.
    await expect(page.getByText('/v1/orders', { exact: true })).toBeVisible();
  });

  test('shows where the codebase already calls an endpoint', async ({ page }) => {
    await page.goto('/apis');

    // The column that earns this page its place: the fixture calls `/orders`
    // through a BASE_URL constant, and the catalog knows.
    await expect(page.getByText('src/api/client.ts:', { exact: false }).first()).toBeVisible();
  });

  test('names security schemes and never a credential', async ({ page }) => {
    await page.goto('/apis');

    const body = (await page.textContent('body')) ?? '';
    expect(body).not.toContain(AGENT_TOKEN);
    expect(body).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{16,}/);
  });
});

test.describe('runs', () => {
  test('says nothing has run yet rather than rendering an empty table', async ({ page }) => {
    await page.goto('/runs');
    await expect(page.getByText('Nothing has run yet.')).toBeVisible();
  });

  test('connects to the live event stream', async ({ page }) => {
    await page.goto('/runs');

    // "Nothing is happening" and "the stream is down" look identical in a list
    // that only shows events.
    await expect(page.locator('.badge', { hasText: 'live' })).toBeVisible();
    await expect(page.getByTestId('timeline')).toContainText('Nothing is running');
  });

  test('renders a run that actually happened', async ({ page }) => {
    // A scripted provider is configured for the fixture, so this run plans,
    // calls no tools, and completes — enough to produce a record.
    await callAgent('run/start', { projectId: server.projectId, task: 'look around' }).catch(
      () => undefined,
    );

    await page.goto('/runs');

    const row = page.locator('tbody tr').first();
    await expect(row).toContainText('look around');
    // Nothing was written, so there was nothing to validate. Showing that as a
    // pass would be the false reassurance the validation engine exists to
    // prevent.
    await expect(row.locator('.badge', { hasText: 'no changes' })).toBeVisible();
  });
});

test.describe('the token never reaches the browser', () => {
  test('is absent from the page, its scripts, and the stream URL', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));

    await page.goto('/runs');
    await expect(page.locator('.badge', { hasText: 'live' })).toBeVisible();

    // Not in the markup.
    expect(await page.content()).not.toContain(AGENT_TOKEN);

    // Not in any URL the browser asked for — which is where the naive design
    // puts it, because EventSource cannot set a header.
    for (const url of requests) expect(url).not.toContain(AGENT_TOKEN);

    // Not reachable from a script running on the page either.
    const leaked = await page.evaluate(
      (token) => JSON.stringify(window.localStorage).includes(token),
      AGENT_TOKEN,
    );
    expect(leaked).toBe(false);
  });

  test('never opens a connection to the agent server directly', async ({ page }) => {
    const foreign: string[] = [];
    page.on('request', (request) => {
      if (!request.url().startsWith('http://127.0.0.1:3210')) foreign.push(request.url());
    });

    await page.goto('/runs');
    await expect(page.locator('.badge', { hasText: 'live' })).toBeVisible();

    // Same-origin only, which is what makes the CSP's `connect-src 'self'`
    // enforceable and the agent's CORS allowlist defence in depth.
    expect(foreign).toEqual([]);
  });
});

test.describe('security headers', () => {
  test('are set on a real response from the built app', async ({ page }) => {
    const response = await page.goto('/');

    expect(response?.headers()['x-content-type-options']).toBe('nosniff');
    expect(response?.headers()['x-frame-options']).toBe('DENY');
    expect(response?.headers()['referrer-policy']).toBe('no-referrer');

    const csp = response?.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
  });
});

test.describe('when the agent server is gone', () => {
  test('says so instead of rendering a broken page', async ({ page }) => {
    server.stop();
    // Give the port a moment to actually close.
    await new Promise((resolve) => setTimeout(resolve, 500));

    await page.goto('/');
    await expect(page.getByText('The agent server is not running.')).toBeVisible();
  });
});
