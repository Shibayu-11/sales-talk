import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

test('control dashboard loads with sandboxed preload and actionable diagnostics', async () => {
  const electronApp = await electron.launch({
    args: ['.'],
    cwd: process.cwd(),
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
    await expect(controlWindow.getByText('音声 / STT 診断')).toBeVisible();
    await expect(controlWindow.getByRole('button', { name: '診断開始' })).toBeVisible();
    await expect(controlWindow.getByText('Deepgram API key が未設定です')).toBeVisible();

    await expect
      .poll(() => controlWindow.evaluate(() => typeof window.api?.app?.getVersion))
      .toBe('function');
    expect(pageErrors).toEqual([]);
    expect(consoleErrors.filter((message) => message.includes('preload'))).toEqual([]);
  } finally {
    await electronApp.close();
  }
});

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
