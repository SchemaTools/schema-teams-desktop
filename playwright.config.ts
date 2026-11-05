import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  workers: 1,
  // Повтор упавшего теста — только на раннере CI (окно Electron там медленнее); локально повторов нет
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
});
