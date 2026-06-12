# テスト実行ランブック(全手順)

作成日: 2026-06-12
目的: 何をどの順番で検証するかの完全な手順書。安い順(自動テスト)→ 高い順(実機 Zoom 商談)に並べてある。
上から順に通すこと。前段が落ちているのに後段をやっても原因切り分けができない。

## Stage 0: 自動テスト(キー不要・5分・コード変更のたび)

```bash
npm run lint && npm run typecheck && npm test
```

- 合格基準: すべて exit 0。unit テスト 112 件 pass(2026-06-12 時点)
- 落ちたら: 直す。ここが赤いまま先に進まない

## Stage 1: ネイティブビルド(キー不要・初回と Swift/NAPI 変更時)

```bash
npm run native:audio:build    # NAPI アドオン(node-gyp)
npm run native:speech:build   # SpeechAnalyzer helper(swift build -c release)
```

- 合格基準: 両方 exit 0。`src/native/audio-capture/.build/release/speech-analyzer-helper` が存在
- 落ちたら: Xcode Command Line Tools / macOS バージョン(SpeechAnalyzer は macOS 26+)を確認

## Stage 2: 実機スモーク(キー不要・10分・音声経路の単体確認)

ターミナルに Microphone / Screen Recording 権限が必要(初回はシステム設定で許可 → ターミナル再起動)。

### 2-1. 音声キャプチャだけ(マイク + システム音声)

```bash
# 何か音を再生しながら(YouTube でも可)
npm run native:audio:smoke -- --duration-ms 8000 --require-microphone --require-system
```

- 合格基準: microphone / system 両方で chunks > 0、sampleRate 16000、errors なし

### 2-2. マイク → local STT(SpeechAnalyzer)

```bash
# 実行中にマイクへ日本語で話しかける
npm run native:audio:local-stt-smoke -- --duration-ms 15000 --source microphone --require-transcript
```

- 合格基準: 話した内容の transcript が出る
- `--require-pipeline` を足すと反論検知パイプラインまで通せる(Anthropic キー要)

### 2-3. システム音声 → local STT

```bash
# 日本語音声(ニュース動画等)を再生しながら
npm run native:audio:local-stt-smoke -- --duration-ms 15000 --source system --require-transcript
```

- 合格基準: 再生中の音声が文字起こしされる
- 落ちたら: ここが Zoom 検証の前提。Screen Recording 権限と macOS バージョンを確認

### 2-4. (fallback 検証時のみ)Deepgram スモーク

```bash
npm run native:audio:stt-smoke -- --duration-ms 15000 --source microphone --require-transcript --deepgram-api-key <KEY>
```

## Stage 3: アプリ通し・キーなし(mock LLM・15分・UI/パイプライン配線の確認)

```bash
SALES_TALK_MOCK_LLM=1 npm run dev 2>&1 | tee /tmp/salestalk-mock-$(date +%Y%m%d-%H%M).log
```

開発モード(非パッケージ)では dev tools が自動で有効。

1. Control ウィンドウ → ダッシュボード → 「音声 / STT 診断」→ 診断開始
2. マイクに話す → local transcript が画面に出る
3. Dev transcript injection で反論文(「価格が高いですね」)を注入
4. mock 切り返しがオーバーレイに表示される
5. ログに `objection_pipeline_latency` が出る(mock なので detectMs/generateMs はほぼ 0)

- 合格基準: 注入 → 検知バッジ → オーバーレイ表示まで配線が通る
- ここで落ちる問題は LLM ではなく IPC/UI の問題

## Stage 4: アプリ通し・キーあり(本物 LLM・15分)

設定画面から Anthropic API キーを登録した上で:

```bash
npm run dev 2>&1 | tee /tmp/salestalk-real-$(date +%Y%m%d-%H%M).log
```

1. 設定 → API Keys → Anthropic 診断実行(`detectionOk` / `responseOk` / `latencyMs` が返る)
2. Dev transcript injection で §4 の反論セリフを注入 → 本物の Haiku 検知 + Sonnet 生成
3. ログの `objection_pipeline_latency` で detectMs / generateMs / totalMs を確認

- 合格基準: totalMs 中央値 ≤ 2,000ms(transcript 注入起点)。ガードレール(禁止キーワード入り発話)で `risk_flags` が付く

## Stage 5: Playwright E2E(キー不要・ビルド込みで数分)

```bash
npm run test:e2e
```

- パッケージ相当のビルドで Electron を起動し、Control UI(診断・設定・STT モード切替)を検証
- 合格基準: 全 spec pass
- リリース前(Week 5)は必須。普段はUI を触った時だけで可

## Stage 6: 実機 Zoom E2E(最重要・相手役必要・30分+)

手順・台本・判定基準は [live-zoom-e2e-checklist.md](./live-zoom-e2e-checklist.md) に従う。要点:

```bash
npm run dev 2>&1 | tee /tmp/salestalk-e2e-$(date +%Y%m%d-%H%M).log
```

1. 権限フロー → Zoom 通話開始 → 商談開始
2. 反論セリフ台本(6種 + 非検知2種)を相手役に読んでもらう
3. 画面共有してオーバーレイが相手に見えないことを確認
4. 30分通しでクラッシュ・音声途切れなし
5. レイテンシ集計: `grep objection_pipeline_latency /tmp/salestalk-e2e-*.log`
6. 監査ログに `sttProvider: "apple_speech_analyzer"` が入っていること
7. チェックリスト §8 の Go/No-Go 判定 → §9 に結果を記録

## 実行順序まとめ(いつ何をやるか)

| タイミング | 実行する Stage |
|---|---|
| コード変更のたび | 0 |
| Swift / NAPI を触ったとき | 0 → 1 → 2 |
| 初回セットアップ・環境が変わったとき | 0 → 1 → 2 → 3 |
| LLM・プロンプトを触ったとき | 0 → 4 |
| UI を触ったとき | 0 → 5 |
| Week 1 の Go/No-Go 判定(M1) | 0 → 1 → 2 → 3 → 4 → 6 |
| リリース前(Week 5 / M5) | 全部 + `npm run package:mac` でクリーン環境検証 |
