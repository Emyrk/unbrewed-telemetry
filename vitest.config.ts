import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // DB-backed test suites share a single Postgres instance and TRUNCATE
    // tables in beforeEach. Running files in parallel causes deadlocks.
    fileParallelism: false,
  },
});
