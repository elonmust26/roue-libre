import { defineConfig } from 'vitest/config';

// Configuration vitest de roue-libre : tests Node purs, timeout large
// pour laisser le cycle e2e simulé se dérouler (il reste < 2 s en pratique).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
  },
});
