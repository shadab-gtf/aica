/**
 * A real agent server, for the end-to-end suite.
 *
 * Spawns the built server with its HTTP transport enabled, opens the sample
 * fixture as a project, and indexes it — so the dashboard under test is
 * rendering counted facts about a real repository rather than a mock.
 *
 * Two things are deliberately real here. The **transport**: the harness talks
 * to the server the same way the dashboard does, over HTTP with a token, so a
 * break in that path fails the suite rather than being papered over. And the
 * **project**: the fixture is the same one the indexer and the planner are
 * gated on, so the numbers the dashboard shows are numbers something else
 * already asserts.
 */

import { spawn } from 'node:child_process';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');

export const AGENT_PORT = 7411;
export const AGENT_TOKEN = 'e2e-token-not-a-real-secret';
export const AGENT_URL = `http://127.0.0.1:${AGENT_PORT}`;
export const FIXTURE_SOURCE = path.join(REPO_ROOT, 'fixtures/sample-app');

/**
 * A copy of the fixture, with configuration of its own.
 *
 * Copied rather than used in place for two reasons. The fixture is shared with
 * the indexer and planner suites and should stay a plain sample app with no
 * agent configuration. And this copy needs the **scripted** provider: a run
 * started against the default would ask for an OpenRouter key that a test
 * machine does not have, and a suite that needs a credential is a suite that
 * does not run.
 */
async function makeProjectCopy() {
  const root = await mkdtemp(path.join(tmpdir(), 'aica-e2e-'));
  await cp(FIXTURE_SOURCE, root, { recursive: true });

  await writeFile(
    path.join(root, 'agent.config.json'),
    JSON.stringify({ model: { provider: 'scripted', model: 'scripted/e2e' } }, null, 2),
    'utf8',
  );

  return root;
}

const SERVER_ENTRY = path.join(REPO_ROOT, 'apps/agent-server/dist/main.js');

/** Call the agent server exactly the way the dashboard's route handler does. */
export async function callAgent(method, params) {
  const response = await fetch(`${AGENT_URL}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${AGENT_TOKEN}` },
    body: JSON.stringify({ method, params }),
  });

  const body = await response.json();
  if (!body.ok) throw new Error(`${method} failed: ${body.error?.message ?? response.status}`);
  return body.value;
}

async function waitForHealth(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${AGENT_URL}/health`);
      if (response.ok) return;
    } catch {
      // Not up yet. Polling is right here: there is no readiness signal on a
      // port that is not listening.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`The agent server did not become healthy within ${timeoutMs}ms.`);
}

/**
 * Start a server with a project open and indexed.
 *
 * Returns a stop function. The child gets `stdin: 'pipe'` and it is left open:
 * the server exits when its stdin closes, which is correct for an editor that
 * has gone away and would be an immediate exit here.
 */
export async function startAgentServer() {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      AICA_HTTP_PORT: String(AGENT_PORT),
      AICA_HTTP_TOKEN: AGENT_TOKEN,
      AICA_LOG_LEVEL: 'warn',
      NO_COLOR: '1',
    },
    windowsHide: true,
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => process.stderr.write(`[agent] ${chunk}`));

  await waitForHealth();

  await callAgent('initialize', {
    clientName: 'e2e',
    clientVersion: '1',
    capabilities: {},
  });

  const projectRoot = await makeProjectCopy();
  const project = await callAgent('project/open', { root: projectRoot });
  await callAgent('code/index', { projectId: project.projectId });

  // The catalog page needs something to show, and a cURL command is the
  // smallest real specification there is.
  await callAgent('api/import', {
    projectId: project.projectId,
    source: { kind: 'text', text: 'curl https://api.example.com/v1/orders' },
  });

  return {
    projectId: project.projectId,
    projectRoot,
    stop: () => {
      child.kill('SIGTERM');
      void rm(projectRoot, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
