import { defineConfig } from 'vitest/config';

// Runs against a real Supabase project. Requires the variables listed in
// test/integration/README.md; every test is skipped when they are missing.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
