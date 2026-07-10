import { defineConfig } from 'vitest/config';

// Configuration vitest de roue-libre : tests Node purs + tests DOM (jsdom,
// déclarés par fichier via `// @vitest-environment jsdom`), timeout large
// pour laisser le cycle e2e simulé se dérouler (il reste < 2 s en pratique).
export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
    testTimeout: 30000,
  },
});
