import { defineConfig, devices } from '@playwright/test';
import { claimRelayLock } from './e2e/relay/run-lock';
import { LOCAL_RELAY_URLS } from './e2e/relay/settings';

// Two relay setups:
// - local (the default): the app is built against a Nostr relay that globalSetup starts with podman, so the battery
//   is fast, repeatable and never floods the public relays. Project `local`, and `soak` or `gallery` only when E2E_SOAK=1 or E2E_GALLERY=1.
// - public (E2E_RELAYS=public): the real default relays, as a smoke run of the tests tagged @public. Project `public`.
// A deployment under test (E2E_BASE_URL) has its own relays, so it always runs the public setup.
const RELAYS = process.env.E2E_RELAYS === 'public' || process.env.E2E_BASE_URL ? 'public' : 'local';
// Not vite preview's default (4173), so a preview someone left running is never mistaken for the test build.
const PREVIEW_PORT = 4180;
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${PREVIEW_PORT}`;
const chrome = devices['Desktop Chrome'];

// One run per machine that starts its own web server, local or public: they share port 4180 and dist-e2e/, and the local
// battery also shares the relay ports. Take the lock here, because Playwright starts the web server before globalSetup:
// a second run must stop before it builds or binds a port, with a message naming the run it is waiting for.
if (!process.env.E2E_BASE_URL) claimRelayLock();

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  // Public relays are sometimes slow; the local relay never is, so a local failure is a real one.
  retries: RELAYS === 'public' ? 1 : 0,
  // One test at a time on the public relays, so we don't look like a flood.
  workers: RELAYS === 'public' ? 1 : 2,
  reporter: process.env.CI ? 'list' : [['list'], ['html', { open: 'never' }]],
  globalSetup: RELAYS === 'local' ? './e2e/relay/global-setup.ts' : undefined,
  // Teardown also releases the run lock, which every run with its own web server holds.
  globalTeardown: process.env.E2E_BASE_URL ? undefined : './e2e/relay/global-teardown.ts',
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: RELAYS === 'local'
    ? [
        { name: 'local', testIgnore: ['soak/**', 'restart/**', 'gallery/**'], use: chrome },
        // After the rest, on its own: these tests restart the shared local relay.
        { name: 'local-restart', testDir: 'e2e/restart', dependencies: ['local'], use: chrome },
        // On demand only: npm run test:soak sets E2E_SOAK=1. The 50-minute soak test goes in e2e/soak/.
        ...(process.env.E2E_SOAK === '1' ? [{ name: 'soak', testDir: 'e2e/soak', timeout: 70 * 60_000, use: chrome }] : []),
        // On demand only: npm run gallery sets E2E_GALLERY=1. The screenshot gallery goes in e2e/gallery/. Its clicks give up
        // after 30 s, because with no action timeout a wrong guess about where a button is hangs until the test timeout.
        ...(process.env.E2E_GALLERY === '1' ? [{ name: 'gallery', testDir: 'e2e/gallery', timeout: 30 * 60_000, use: { ...chrome, actionTimeout: 30_000 } }] : []),
      ]
    : [{ name: 'public', grep: /@public/, use: chrome }],
  // localhost is a secure context, so WebCrypto works without HTTPS. The test build goes to its own directory,
  // so it can never be mistaken for a release build in dist/.
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: `npx vite build --mode ${RELAYS === 'local' ? 'e2e' : 'production'} --outDir dist-e2e --emptyOutDir`
      + ` && npx vite preview --mode ${RELAYS === 'local' ? 'e2e' : 'production'} --outDir dist-e2e --port ${PREVIEW_PORT} --strictPort`,
    // Public builds never take relays from the shell.
    env: { VITE_RELAYS: RELAYS === 'local' ? LOCAL_RELAY_URLS.join(',') : '' },
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
