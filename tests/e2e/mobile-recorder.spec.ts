import { expect, test, type Page } from '@playwright/test';

/**
 * Mobile recorder PWA E2E. Runs in Chromium with a fake audio device (config:
 * --use-fake-device-for-media-stream) so MediaRecorder produces a real blob, and
 * mocks the Cloudflare Worker so the full login → consent → record → upload →
 * done flow is exercised without a deployed backend.
 */

// The full Chromium build (not chrome-headless-shell) is required: getUserMedia
// with the fake audio device hangs under headless-shell.
test.use({ channel: 'chromium' });

const BASE = 'http://localhost:5180';

async function mockWorker(page: Page): Promise<{ uploadedBytes: () => number }> {
  let uploadedBytes = 0;

  await page.route('**/v1/auth/login', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sessionToken: 'e2e-session' }),
    });
  });

  await page.route('**/v1/audio-upload-urls', async (route) => {
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        uploadUrl: `${BASE}/v1/audio-upload-urls/e2e-token`,
        callId: 'e2e-call',
        sttJobId: 'e2e-job',
        method: 'PUT',
        headers: { 'content-type': 'audio/webm' },
      }),
    });
  });

  await page.route('**/v1/audio-upload-urls/e2e-token', async (route) => {
    const body = route.request().postDataBuffer();
    uploadedBytes = body?.length ?? 0;
    await route.fulfill({ status: 200, body: '' });
  });

  await page.route('**/v1/stt-jobs/e2e-job', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'e2e-job', status: 'completed' }),
    });
  });

  await page.route('**/v1/calls/e2e-call/transcripts', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 's1' }, { id: 's2' }]),
    });
  });

  return { uploadedBytes: () => uploadedBytes };
}

test('records a visit and uploads it through the full flow', async ({ page }) => {
  await page.context().grantPermissions(['microphone'], { origin: BASE });
  const worker = await mockWorker(page);
  await page.goto(BASE);

  // --- Login ---
  await expect(page.getByRole('heading', { name: 'SalesTalk 録音' })).toBeVisible();
  await page.getByLabel('メールアドレス').fill('agent@example.com');
  await page.getByLabel('パスワード').fill('pw-123456789012');
  await page.getByRole('button', { name: 'ログイン' }).click();

  // --- Product + consent gate ---
  await expect(page.getByText('商材と同意を確認')).toBeVisible();
  await page.getByRole('button', { name: '健康経営優良法人' }).click();

  // Record button must not be available until consent is granted.
  await expect(page.getByRole('button', { name: '録音開始' })).toHaveCount(0);
  await page.getByLabel('録音同意').check();
  await expect(page.getByText('録音できます')).toBeVisible();

  // --- Record (fake audio device produces a real stream) ---
  await page.getByRole('button', { name: '録音開始' }).click();
  await expect(page.getByText('録音中')).toBeVisible();
  await page.waitForTimeout(800); // capture a moment of audio
  await page.getByRole('button', { name: '録音停止' }).click();

  // --- Upload ---
  await expect(page.getByText('アップロード待ち')).toBeVisible();
  await page.getByRole('button', { name: 'アップロードして文字起こし' }).click();

  // --- Done ---
  await expect(page.getByText(/完了しました/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/2 セグメント/)).toBeVisible();

  // A non-empty audio blob actually reached the (mocked) signed upload URL.
  expect(worker.uploadedBytes()).toBeGreaterThan(0);
});

test('consent is a hard gate: cannot record without it', async ({ page }) => {
  await mockWorker(page);
  await page.goto(BASE);

  await page.getByLabel('メールアドレス').fill('agent@example.com');
  await page.getByLabel('パスワード').fill('pw-123456789012');
  await page.getByRole('button', { name: 'ログイン' }).click();

  await expect(page.getByText('商材と同意を確認')).toBeVisible();
  // Without checking consent, the record button is not rendered.
  await expect(page.getByRole('button', { name: '録音開始' })).toHaveCount(0);
});
