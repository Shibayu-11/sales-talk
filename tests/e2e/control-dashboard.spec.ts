import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('control dashboard loads with sandboxed preload and actionable diagnostics', async () => {
  await withSalesTalkApp(async ({ controlWindow }) => {
    await expect(controlWindow.getByText('音声 / STT 診断')).toBeVisible();
    await expect(controlWindow.getByRole('button', { name: '診断開始' })).toBeVisible();
    await expect(controlWindow.getByText(/顧客へ録音・文字起こし/)).toBeVisible();
    await expect(controlWindow.getByText('Apple SpeechAnalyzer優先')).toBeVisible();
    await expect(controlWindow.getByText('Dev transcript injection')).toBeVisible();

    await expect
      .poll(() => controlWindow.evaluate(() => typeof window.api?.app?.getVersion))
      .toBe('function');
  });
});

test('first-run onboarding gates the app until permissions, key, and product are set', async () => {
  await withSalesTalkApp(
    async ({ controlWindow }) => {
      // Onboarding overlay is shown and blocks the main UI. Scope to the dialog so
      // queries don't match the dashboard rendered underneath.
      const dialog = controlWindow.getByRole('dialog', { name: '初期セットアップ' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'すべての項目を完了してください' })).toBeDisabled();

      // Permissions are force-granted via env, so step 1 auto-completes and the
      // API key becomes the active step.
      await dialog.getByLabel('Anthropic API key').fill('sk-ant-e2e-test');
      await dialog.getByRole('button', { name: '保存', exact: true }).click();

      // Step 3: pick a product (only present once the API key step completes).
      await dialog.getByRole('button', { name: '健康経営優良法人' }).click();

      // Now completable; finishing reveals the main dashboard.
      const done = dialog.getByRole('button', { name: '商談を始める' });
      await expect(done).toBeEnabled();
      await done.click();
      await expect(controlWindow.getByRole('dialog', { name: '初期セットアップ' })).toHaveCount(0);
      await expect(controlWindow.getByText('音声 / STT 診断')).toBeVisible();
    },
    {
      completeOnboarding: false,
      env: { SALES_TALK_FORCE_AUDIO_PERMISSIONS: '1' },
    },
  );
});

test('settings exposes local-first STT and Deepgram fallback mode', async () => {
  await withSalesTalkApp(async ({ controlWindow }) => {
    await controlWindow.getByRole('button', { name: '設定', exact: true }).click();
    await expect(controlWindow.getByRole('heading', { name: 'API Keys' })).toBeVisible();
    await expect(controlWindow.getByRole('heading', { name: '文字起こし方式' })).toBeVisible();
    await expect(controlWindow.getByText(/音声を外部サーバーに預けない/)).toBeVisible();
    await controlWindow.getByLabel('STT provider').selectOption('deepgram_fallback');
    await expect(controlWindow.getByLabel('STT provider')).toHaveValue('deepgram_fallback');
    await controlWindow.getByRole('button', { name: 'ダッシュボード' }).click();
    await expect(controlWindow.getByText('ローカル + Deepgram fallback')).toBeVisible();
    await expect(controlWindow.getByText('Deepgram fallback key が未設定です')).toBeVisible();

    await controlWindow.getByRole('button', { name: '設定', exact: true }).click();
    await controlWindow.getByRole('textbox', { name: 'Deepgram API key' }).fill('e2e-deepgram-key');
    await controlWindow.getByRole('button', { name: 'Deepgram API key を保存' }).click();
    await expect(controlWindow.getByText('保存済み').first()).toBeVisible();

    await controlWindow.getByRole('button', { name: 'ダッシュボード' }).click();
    await expect(controlWindow.getByText('Deepgram fallback key が未設定です')).toHaveCount(0);
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
    await expect(controlWindow.getByText('不動産向け重点ルール', { exact: true })).toBeVisible();
    await controlWindow.getByLabel('ルール検知表現').fill('絶対安全');
    await controlWindow.getByLabel('ルール理由').fill('断定表現です。');
    await controlWindow.getByLabel('ルール推奨表現').fill('リスクを説明します。');
    await controlWindow.getByLabel('ルール優先度').fill('20');
    await controlWindow.getByRole('button', { name: 'ルール追加' }).click();
    await expect(controlWindow.getByText('絶対安全')).toBeVisible();
    await controlWindow.getByRole('button', { name: '優先度↑' }).click();
    await expect(controlWindow.getByText(/優先度 10/)).toBeVisible();
    await controlWindow
      .getByText('不動産向け重点ルール', { exact: true })
      .locator('..')
      .locator('..')
      .getByRole('button', { name: '承認申請' })
      .click();
    await expect(
      controlWindow.getByText('商品: real_estate / 自社ルール / v1 / pending_review'),
    ).toBeVisible();
    await controlWindow.getByRole('button', { name: '承認' }).click();
    const approvedRuleSetCard = controlWindow
      .getByText('不動産向け重点ルール', { exact: true })
      .locator('..')
      .locator('..');
    await expect(approvedRuleSetCard.getByText(/v1 \/ approved/)).toBeVisible();
    await approvedRuleSetCard
      .getByRole('button', { name: '新版作成' })
      .click();
    await expect(
      controlWindow.getByText('不動産向け重点ルール v2', { exact: true }),
    ).toBeVisible();
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
      await expect(controlWindow.getByRole('heading', { name: '商談ライブラリ' })).toBeVisible();
      await expect(controlWindow.getByText(/顧客から録音・文字起こし/)).toBeVisible();
      await expect(controlWindow.getByRole('button', { name: '音声から自動生成' })).toBeDisabled();
      await expect(controlWindow.getByRole('button', { name: '音声から自動生成' })).toBeVisible();
      await expect(controlWindow.getByRole('button', { name: '音声ファイルを取り込む' })).toBeVisible();
      await expect(controlWindow.getByText('価格の内訳を確認').first()).toBeVisible();
      await controlWindow.getByRole('button', { name: '現セッションから議事録生成' }).click();
      await expect(controlWindow.getByText(/development mock 議事録/)).toBeVisible();
      await expect(controlWindow.getByText('決定事項', { exact: true })).toBeVisible();
      await expect(controlWindow.getByText('保留・宿題')).toBeVisible();
      await expect(controlWindow.getByText('コンプラレビュー')).toBeVisible();
      await expect(controlWindow.getByText('将来利益を断定する表現は顧客誤認につながります。')).toBeVisible();
      // Kanary 流三分割: 経過時間グループ + 商談タイトル + transcript バブル
      await expect(controlWindow.getByText('今日', { exact: true })).toBeVisible();
      await expect(controlWindow.getByText('不動産 / 手動transcript').first()).toBeVisible();
      await expect(
        controlWindow
          .getByText('価格が高いので、今すぐ導入するのは難しいです。', { exact: true })
          .first(),
      ).toBeVisible();
      await expect(controlWindow.getByText(/音声ファイル \/ STT ジョブ/)).toBeVisible();
      await expect(controlWindow.getByRole('button', { name: '再生成' })).toBeVisible();

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

test('audio diagnostic shows local-first SpeechAnalyzer transcripts in the UI', async () => {
  const fakeNative = await createFakeNativeAudioModule();
  const fakeSpeech = await createFakeSpeechAnalyzerHelper();

  await withSalesTalkApp(
    async ({ controlWindow }) => {
      await controlWindow.getByLabel(/顧客へ録音・文字起こし/).check();
      await expect(controlWindow.getByRole('button', { name: '診断開始' })).toBeEnabled();
      await controlWindow.getByRole('button', { name: '診断開始' }).click();

      await expect(controlWindow.getByText('STT').locator('..').getByText('connected')).toBeVisible();
      await expect(controlWindow.getByText('停止')).toBeVisible();
      await expect.poll(() => readTextFile(fakeNative.logPath)).toContain('emit');
      await expect.poll(() => readTextFile(fakeSpeech.logPath)).toContain('audio');
      await expect(controlWindow.getByText(/価格が高いので今は判断できません/)).toBeVisible();
      await expect(controlWindow.getByText(/final \/ counterpart/)).toBeVisible();

      await controlWindow.getByRole('button', { name: '停止' }).click();
      await expect(controlWindow.getByRole('button', { name: '診断開始' })).toBeVisible();
    },
    {
      env: {
        SALES_TALK_AUDIO_CAPTURE_MODULE: fakeNative.modulePath,
        SALES_TALK_FORCE_AUDIO_PERMISSIONS: '1',
        SALES_TALK_SPEECH_ANALYZER_HELPER: fakeSpeech.helperPath,
      },
    },
  );
});

async function withSalesTalkApp(
  run: (context: { controlWindow: Page; electronApp: ElectronApplication }) => Promise<void>,
  options: { env?: Record<string, string>; completeOnboarding?: boolean } = {},
): Promise<void> {
  const userDataPath = await mkdtemp(join(tmpdir(), 'sales-talk-e2e-'));
  // Existing tests target the main UI, not first-run onboarding; pre-seed settings
  // so the onboarding overlay does not block them. The onboarding test opts out.
  if (options.completeOnboarding !== false) {
    await seedOnboardedSettings(userDataPath);
  }
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
    await expect(controlWindow.getByText('SalesTalk').first()).toBeVisible();
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

async function createFakeNativeAudioModule(): Promise<{ modulePath: string; logPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'sales-talk-fake-native-'));
  const modulePath = join(directory, 'audio_capture.cjs');
  const logPath = join(directory, 'native.log');
  await writeFile(
    modulePath,
    `
const { appendFileSync } = require('node:fs');
const logPath = ${JSON.stringify(logPath)};
let audioCallback = null;
let errorCallback = null;
let intervalId = null;
exports.onAudioChunk = (cb) => { audioCallback = cb; };
exports.onError = (cb) => { errorCallback = cb; void errorCallback; };
exports.startCapture = async (config) => {
  const sessionId = 'fake-native-session';
  let emitted = 0;
  const emitChunk = () => {
    emitted += 1;
    appendFileSync(logPath, 'emit\\n');
    audioCallback?.({
      source: 'system',
      data: Buffer.alloc(3200),
      timestamp: Date.now(),
      durationMs: 100,
      sampleRate: config.sampleRate ?? 16000,
    });
  };
  emitChunk();
  setTimeout(() => {
    if (!audioCallback) return;
    emitChunk();
  }, 500);
  intervalId = setInterval(() => {
    if (!audioCallback) return;
    emitChunk();
    if (emitted >= 5 && intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }, 500);
  return { sessionId };
};
exports.stopCapture = async () => {
  if (intervalId) clearInterval(intervalId);
  intervalId = null;
};
`,
    'utf8',
  );
  return { modulePath, logPath };
}

async function createFakeSpeechAnalyzerHelper(): Promise<{ helperPath: string; logPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'sales-talk-fake-speech-'));
  const helperPath = join(directory, 'speech-analyzer-helper');
  const logPath = join(directory, 'speech.log');
  await writeFile(
    helperPath,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const logPath = ${JSON.stringify(logPath)};
process.stdout.write(JSON.stringify({ type: 'ready', sampleRate: 16000 }) + '\\n');
process.stdin.setEncoding('utf8');
let buffer = '';
let emitted = false;
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf('\\n');
    if (index === -1) break;
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    const message = JSON.parse(line);
    if (message.type === 'stop') process.exit(0);
    if (message.type === 'audio' && !emitted) {
      emitted = true;
      appendFileSync(logPath, 'audio\\n');
      process.stdout.write(JSON.stringify({
        type: 'transcript',
        speaker: 'counterpart',
        text: '価格が高いので今は判断できません',
        isFinal: true,
        startMs: message.startMs,
        endMs: message.startMs + 100
      }) + '\\n');
    }
  }
});
`,
    'utf8',
  );
  await chmod(helperPath, 0o755);
  return { helperPath, logPath };
}

async function readTextFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

async function seedOnboardedSettings(userDataPath: string): Promise<void> {
  const settings = {
    selectedProductId: 'real_estate',
    overlayPosition: { x: 0, y: 80, display: 0 },
    hotkeys: {
      toggleOverlay: 'Option+Space',
      expandLayer3: 'Command+D',
      nextCandidate: 'Command+N',
      markUnused: 'Command+Shift+X',
    },
    consentNoticeMode: 'verbal',
    sttProviderMode: 'local_first',
    sttImportProviderMode: 'local_first',
    onboardingCompletedAt: '2026-06-01T00:00:00.000Z',
    schemaVersion: 1,
  };
  await writeFile(join(userDataPath, 'settings.json'), JSON.stringify(settings), 'utf8');
}
