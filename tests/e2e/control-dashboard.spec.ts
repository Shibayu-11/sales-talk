import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('control dashboard loads with sandboxed preload and actionable diagnostics', async () => {
  await withSalesTalkApp(async ({ controlWindow }) => {
    await expect(controlWindow.getByText('音声 / STT 診断')).toBeVisible();
    await expect(controlWindow.getByRole('button', { name: '診断開始' })).toBeVisible();
    await expect(controlWindow.getByText(/顧客へ録音・文字起こし/)).toBeVisible();
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

    await controlWindow.getByRole('button', { name: '設定', exact: true }).click();
    await expect(controlWindow.getByRole('heading', { name: '組織・ユーザー権限' })).toBeVisible();
    await expect(controlWindow.getByText('Local Insurance Company')).toBeVisible();
    await expect(controlWindow.getByText('Agency Admin', { exact: true })).toBeVisible();
    const auditorRole = controlWindow.getByLabel('Insurer Auditor role');
    await expect(auditorRole).toBeDisabled();
    const agentRole = controlWindow.getByLabel('Agency Agent role');
    await agentRole.selectOption('manager');
    await expect(agentRole).toHaveValue('manager');

    await controlWindow.getByRole('button', { name: '監査ログ' }).click();
    await expect(controlWindow.getByRole('heading', { name: '監査ログ' })).toBeVisible();
    await expect(
      controlWindow.getByRole('listitem').filter({ hasText: 'organization.user_role_updated' }),
    ).toBeVisible();
    await expect(controlWindow.getByText(/actor: Agency Admin/)).toBeVisible();
    await controlWindow.getByLabel('監査ログ検索').fill('user_role_updated');
    await controlWindow.getByRole('button', { name: '適用' }).click();
    await expect(
      controlWindow.getByRole('listitem').filter({ hasText: 'organization.user_role_updated' }),
    ).toBeVisible();
    await controlWindow.getByLabel('監査ログ操作種別').selectOption('recording.started');
    await controlWindow.getByRole('button', { name: '適用' }).click();
    await expect(controlWindow.getByText('監査ログはまだありません。')).toBeVisible();

    await controlWindow.getByRole('button', { name: 'ルール設定' }).click();
    await expect(
      controlWindow.getByRole('heading', { name: '会社別プリセット・商品別ルールセット' }),
    ).toBeVisible();
    await expect(controlWindow.getByText('保険会社標準コンプライアンス')).toBeVisible();
    await controlWindow.getByLabel('ルールセット名').fill('不動産向け重点ルール');
    await controlWindow.getByLabel('ルールセット商品').selectOption('real_estate');
    await controlWindow.getByRole('button', { name: 'セット作成' }).click();
    await expect(controlWindow.getByText('不動産向け重点ルール')).toBeVisible();
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

      await controlWindow.evaluate(() =>
        window.api.dev.injectTranscript({
          speaker: 'counterpart',
          text: 'この商品は絶対儲かります。',
          isFinal: true,
          startMs: Date.now() - 1_000,
          endMs: Date.now(),
        }),
      );
      await expect(controlWindow.getByText('この商品は絶対儲かります。', { exact: true })).toBeVisible();

      await controlWindow.getByRole('button', { name: 'dismiss' }).click();
      await expect(controlWindow.getByText('検知待機中')).toBeVisible();

      await controlWindow.getByRole('button', { name: '商談履歴' }).click();
      await expect(controlWindow.getByRole('heading', { name: '商談履歴' })).toBeVisible();
      await expect(controlWindow.getByText(/顧客から録音・文字起こし/)).toBeVisible();
      await expect(controlWindow.getByRole('button', { name: '音声から自動生成' })).toBeDisabled();
      await expect(controlWindow.getByRole('button', { name: '音声から自動生成' })).toBeVisible();
      await expect(controlWindow.getByRole('button', { name: '音声ファイルを取り込む' })).toBeVisible();
      await expect(controlWindow.getByText('価格の内訳を確認').first()).toBeVisible();
      await controlWindow.getByRole('button', { name: 'transcript から生成' }).click();
      await expect(controlWindow.getByText(/直近の発話:/)).toBeVisible();
      await expect(controlWindow.getByText('保留事項')).toBeVisible();
      await expect(controlWindow.getByText('コンプラレビュー')).toBeVisible();
      await expect(controlWindow.getByText('将来利益を断定する表現は顧客誤認につながります。')).toBeVisible();
      await expect(controlWindow.getByText('保存済み call / transcript')).toBeVisible();
      await expect(controlWindow.getByText(new RegExp('manual_transcript / insurance'))).toBeVisible();
      await expect(controlWindow.getByText('stt jobs')).toBeVisible();
      await expect(controlWindow.getByText('この call の STT job は未作成です。')).toBeVisible();
      await expect(controlWindow.getByText('saved transcript')).toBeVisible();

      await controlWindow.getByRole('button', { name: 'レビュー' }).click();
      await expect(controlWindow.getByRole('heading', { name: '管理者レビュー' })).toBeVisible();
      await expect(controlWindow.getByText('高リスク発話の確認')).toBeVisible();
      await controlWindow.getByRole('button', { name: '要教育' }).click();
      await expect(controlWindow.locator('span').filter({ hasText: '要教育' })).toBeVisible();

      await controlWindow.getByRole('button', { name: 'タスク' }).click();
      await controlWindow.getByLabel('タスク担当').selectOption('joint');
      await controlWindow.getByLabel('タスク内容').fill('費用対効果の資料を送る');
      await controlWindow.getByRole('button', { name: '追加' }).click();
      const task = controlWindow.getByRole('button', { name: /共同.*費用対効果の資料を送る/ });
      await expect(task).toBeVisible();
      await task.click();
      await expect(controlWindow.getByText('完了')).toBeVisible();

      await controlWindow.getByRole('button', { name: 'ナレッジ' }).click();
      await controlWindow.getByLabel('反論タイプ').fill('price');
      await controlWindow.getByLabel('反論トリガー').fill('価格が高い');
      await controlWindow.getByLabel('切り返し').fill('範囲を分けて費用対効果を確認します。');
      await controlWindow.getByRole('button', { name: '登録' }).click();
      await expect(controlWindow.getByText('範囲を分けて費用対効果を確認します。')).toBeVisible();
      await controlWindow.getByLabel('ナレッジ検索').fill('価格');
      await controlWindow.getByRole('button', { name: '検索' }).click();
      await expect(controlWindow.getByText('検索結果')).toBeVisible();
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
