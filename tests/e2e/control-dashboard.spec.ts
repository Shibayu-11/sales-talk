import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('control dashboard loads with sandboxed preload and actionable diagnostics', async () => {
  await withSalesTalkApp(async ({ controlWindow }) => {
    await expect(controlWindow.getByText('音声 / STT 診断')).toBeVisible();
    await expect(controlWindow.getByRole('button', { name: '診断開始' })).toBeVisible();
    await expect(controlWindow.getByText('Deepgram API key が未設定です')).toBeVisible();

    await expect
      .poll(() => controlWindow.evaluate(() => typeof window.api?.app?.getVersion))
      .toBe('function');
  });
});

test('saving a Deepgram key clears the dashboard setup warning', async () => {
  await withSalesTalkApp(async ({ controlWindow }) => {
    await expect(controlWindow.getByText('Deepgram API key が未設定です')).toBeVisible();

    await controlWindow.getByRole('button', { name: 'Settings を開く' }).click();
    await expect(controlWindow.getByRole('heading', { name: 'API Keys' })).toBeVisible();
    await controlWindow.getByRole('textbox', { name: 'Deepgram API key' }).fill('e2e-deepgram-key');
    await controlWindow.getByRole('button', { name: 'Deepgram API key を保存' }).click();
    await expect(controlWindow.getByText('保存済み').first()).toBeVisible();

    await controlWindow.getByRole('button', { name: 'ダッシュボード' }).click();
    await expect(controlWindow.getByText('Deepgram API key が未設定です')).toHaveCount(0);
    await expect(controlWindow.getByRole('button', { name: '診断開始' })).toBeVisible();
  });
});

async function withSalesTalkApp(
  run: (context: { controlWindow: Page; electronApp: ElectronApplication }) => Promise<void>,
): Promise<void> {
  const userDataPath = await mkdtemp(join(tmpdir(), 'sales-talk-e2e-'));
  const electronApp = await electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env: {
      ...process.env,
      SALES_TALK_USER_DATA_PATH: userDataPath,
    },
  });
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];

  try {
    const controlWindow = await waitForControlWindow(electronApp);
    controlWindow.on('pageerror', (error) => pageErrors.push(error.message));
    controlWindow.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });

    await controlWindow.reload();
    await controlWindow.waitForLoadState('load');
    await expect(controlWindow.getByText('SalesTalk')).toBeVisible();
    await run({ controlWindow, electronApp });
    expect(pageErrors).toEqual([]);
    expect(consoleErrors.filter((message) => message.includes('preload'))).toEqual([]);
  } finally {
    await electronApp.close();
    await rm(userDataPath, { force: true, recursive: true });
  }
}

async function waitForControlWindow(electronApp: ElectronApplication): Promise<Page> {
  await electronApp.firstWindow();
  await expect
    .poll(
      () => {
        const controlWindow = electronApp
          .windows()
          .find((window) => window.url().includes('/control/'));
        return controlWindow?.url() ?? null;
      },
      { timeout: 15_000 },
    )
    .not.toBeNull();

  const controlWindow = electronApp
    .windows()
    .find((window) => window.url().includes('/control/'));
  if (!controlWindow) {
    throw new Error('Control window was not found');
  }
  return controlWindow;
}
