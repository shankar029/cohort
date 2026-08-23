import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: [
      'src/**/*.test.ts',
      'tests/unit/**/*.test.ts',
      'tests/integration/**/*.test.ts',
      'tests/live/**/*.test.ts',
    ],
    globals: false,
    hookTimeout: 20000,
    testTimeout: 20000,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html'],
      // Exclude the live LLM smoke test from coverage runs.
      exclude: ['tests/live/**'],
      // Core orchestration + domain the team relies on; enforce the 80% bar here
      // rather than across legacy/UI glue that vitest doesn't exercise.
      include: [
        'src/server/orchestrator.ts',
        'src/server/git.ts',
        'src/server/db/store.ts',
        'src/server/agents/fakeAdapter.ts',
        'src/server/agents/catalog.ts',
        'src/server/agents/context.ts',
        'src/shared/**/*.ts',
      ],
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 70 },
    },
  },
});
