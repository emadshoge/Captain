import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each test file creates its own database; keep server load predictable.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
