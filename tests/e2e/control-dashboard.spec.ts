import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('control dashboard loads with sandboxed preload and actionable diagnostics', async () => {
  await withSalesTalkApp(async ({ controlWindow }) => {
    await expect(controlWindow.getByText('音声 / STT 診断')).toBeVisible();
    await expect(controlWindow.getByRole('button', { name: '診断開始' })).toBeVisible();
    await expect(controlWindow.getByText('Deepgram API key が未設定です')).toBeVisible();
    await expect(controlWindow.getByText('Dev transcript injection')).toBeVisible();

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

test('dev transcript injection drives the mock pipeline without API keys', async () => {
  await withSalesTalkApp(
    async ({ controlWindow, electronApp }) => {
      const overlayWindow = await waitForOverlayWindow(electronApp);

      await expect(controlWindow.getByText('Dev transcript injection')).toBeVisible();
      await controlWindow.getByRole('button', { name: 'mock 通話開始' }).click();
      await expect(controlWindow.getByText('状態: in_call')).toBeVisible();

      await controlWindow.getByRole('button', { name: '反論 transcript 注入' }).click();
      await expect(
        controlWindow.getByText('価格が高いので、今すぐ導入するのは難しいです。', { exact: true }),
      ).toBeVisible();
      await expect(controlWindow.getByText('現在の反論')).toBeVisible();
      await expect(controlWindow.getByText('confidence: 92%')).toBeVisible();
      await expect(overlayWindow.getByText('条件を分解')).toBeVisible();
      await expect(overlayWindow.getByText('価格の内訳を確認')).toBeVisible();

      await overlayWindow.getByRole('button', { name: 'L3' }).click();
      await expect(overlayWindow.getByText('根拠詳細')).toBeVisible();
      await expect(overlayWindow.getByText('本番回答ではありません')).toBeVisible();

      await controlWindow.getByRole('button', { name: 'dismiss' }).click();
      await expect(controlWindow.getByText('検知待機中')).toBeVisible();

      await controlWindow.getByRole('button', { name: '商談履歴' }).click();
      await expect(controlWindow.getByRole('heading', { name: '商談履歴' })).toBeVisible();
      await expect(controlWindow.getByText('価格の内訳を確認')).toBeVisible();

      await controlWindow.getByRole('button', { name: 'タスク' }).click();
      await controlWindow.getByLabel('タスク担当').selectOption('joint');
      await controlWindow.getByLabel('タスク内容').fill('費用対効果の資料を送る');
      await controlWindow.getByRole('button', { name: '追加' }).click();
      await expect(
        controlWindow.getByRole('button', { name: /共同.*費用対効果の資料を送る/ }),
      ).toBeVisible();
    },
    {
      env: {
        SALES_TALK_ENABLE_DEV_TOOLS: '1',
        SALES_TALK_MOCK_LLM: '1',
      },
    },
  );
});

async function withSalesTalkApp(
  run: (context: { controlWindow: Page; electronApp: ElectronApplication }) => Promise<void>,
  options: { env?: Record<string, string> } = {},
): Promise<void> {
  const userDataPath = await mkdtemp(join(tmpdir(), 'sales-talk-e2e-'));
  const electronApp = await electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...options.env,
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

async function waitForOverlayWindow(electronApp: ElectronApplication): Promise<Page> {
  await expect
    .poll(
      () => {
        const overlayWindow = electronApp
          .windows()
          .find((window) => window.url().includes('/overlay/'));
        return overlayWindow?.url() ?? null;
      },
      { timeout: 15_000 },
    )
    .not.toBeNull();

  const overlayWindow = electronApp
    .windows()
    .find((window) => window.url().includes('/overlay/'));
  if (!overlayWindow) {
    throw new Error('Overlay window was not found');
  }
  return overlayWindow;
}
