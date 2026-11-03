import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['dist/**', 'node_modules/**', 'e2e/**'],
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://utilities_owner:dev@localhost/utilities_test',
      DB_SET_ROLE: '1',
      TEST_TODAY: '2027-01-31', // lets tests add late charges for bills dated months ahead (see runPenalties)
    },
  },
});
