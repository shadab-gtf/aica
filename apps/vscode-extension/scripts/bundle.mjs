#!/usr/bin/env node
/**
 * Package the extension.
 *
 * Two bundles, for two different hosts:
 *
 * - **`dist/extension.cjs`** — the extension host loads CommonJS and provides
 *   `vscode` as a runtime module that must not be bundled. This repository is
 *   ESM throughout, so the reconciliation happens here rather than by
 *   compromising the source (a recorded decision, §9).
 * - **`dist/server/main.cjs`** — the agent server, for plain Node 22. It ships
 *   inside the extension so an installed extension always runs the server
 *   matching its protocol version, rather than whatever happens to be on the
 *   machine.
 *
 * Both outputs are CommonJS, and the server's format is not a stylistic choice.
 * The code indexer depends on `typescript`, which is CommonJS and reaches for
 * `require`, `__filename` and `__dirname` at runtime in ways no bundler can
 * see. Bundled into ESM those become shims that throw — and they throw on the
 * first indexing call, not at build time, so the failure surfaces to a user
 * rather than to CI. CommonJS output has them for real. Nothing in the server's
 * own source uses `import.meta`, so the conversion costs nothing.
 *
 * Bundling also means the published extension carries no `node_modules`, which
 * matters here: workspace packages are symlinks, and a symlink does not survive
 * a `.vsix`.
 */

import { build } from 'esbuild';
import { cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(root, '../..');

const shared = {
  bundle: true,
  minify: process.env.NODE_ENV === 'production',
  sourcemap: true,
  // The floor the extension declares it runs on. Targeting anything newer
  // produces syntax an older-but-supported host cannot parse.
  target: 'node22',
  logLevel: 'info',
};

await build({
  ...shared,
  entryPoints: [path.join(root, 'src/extension.ts')],
  outfile: path.join(root, 'dist/extension.cjs'),
  platform: 'node',
  format: 'cjs',
  // Provided by the host at runtime and unbundleable by definition.
  external: ['vscode'],
});

await build({
  ...shared,
  entryPoints: [path.join(repoRoot, 'apps/agent-server/src/main.ts')],
  outfile: path.join(root, 'dist/server/main.cjs'),
  platform: 'node',
  format: 'cjs',
  // The server is a separate process with its own entry point; nothing about
  // the editor reaches it except through the pipe.
  external: [],
});

// Skills are markdown, not code, so the bundler cannot inline them — and they
// have to travel with the server, which looks for them beside its own entry
// point. Without this an installed extension has no guidance at all.
const shippedSkills = path.join(root, 'dist/server/skills');
await rm(shippedSkills, { recursive: true, force: true });
await cp(path.join(repoRoot, 'skills'), shippedSkills, { recursive: true });

console.log('bundled extension.cjs, server/main.cjs, and the shipped skills');
