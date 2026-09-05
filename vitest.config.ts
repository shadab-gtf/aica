import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    pool: 'forks',
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts', '**/*.d.ts'],
    },
  },
  resolve: {
    // Vitest executes TypeScript sources directly, so workspace package
    // specifiers resolve to src/ rather than to built dist/ output. The
    // agent-server entry is listed first because it lives under apps/ — the
    // extension's protocol test runs a real client against a real server, and
    // it can only do that if both resolve.
    alias: [
      { find: '@aica/agent-server', replacement: `${root}apps/agent-server/src/index.ts` },
      { find: /^@aica\/([a-z-]+)$/, replacement: `${root}packages/$1/src/index.ts` },
    ],
  },
});
