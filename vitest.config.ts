import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    // Each file gets its own process so module-level DB init doesn't bleed between files
    pool: 'forks',
    env: {
      VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true',
    },
  },
});
