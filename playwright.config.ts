import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,
  workers: 1,
  reporter: 'list',
  use: {
    // Fake audio device so MediaRecorder works headlessly and the mic permission
    // is auto-granted. Affects only Chromium contexts the browser tests launch;
    // the Electron tests launch their own process and are unaffected.
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    },
  },
  // Serve the mobile PWA for the recorder E2E. reuseExistingServer avoids a second
  // instance if it's already running; harmless for the Electron specs.
  webServer: {
    command: 'npm run mobile:dev',
    url: 'http://localhost:5180',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
