import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // better-sqlite3 is synchronous + native; keep tests in a single thread-friendly pool.
    pool: 'forks',
  },
});
