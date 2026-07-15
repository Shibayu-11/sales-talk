# SalesTalk

Zoomビデオ商談中にリアルタイムで反論ハンドリングを支援する macOS アシスタント。

詳細設計: [sales-assistant-prd.md](./sales-assistant-prd.md)
2軸開発計画: [docs/two-track-development-plan.md](./docs/two-track-development-plan.md)
セルログ AI-Native 計画: [docs/selllog-ai-native-plan.md](./docs/selllog-ai-native-plan.md)
ローカルSTT移行計画: [docs/apple-speechanalyzer-stt-plan.md](./docs/apple-speechanalyzer-stt-plan.md)
エージェント協働: [CLAUDE.md](./CLAUDE.md) (Swift/macOS) / [AGENTS.md](./AGENTS.md) (TS/React/DB)

## クイックスタート

```bash
nvm use         # Node 20.11+
npm install
cp .env.example .env   # 開発用キーを記入
npm run dev
```

## スクリプト

| コマンド | 用途 |
|---|---|
| `npm run dev` | electron-vite で開発サーバ起動 |
| `npm run build` | 型チェック + 本番ビルド |
| `npm run typecheck` | TS 型チェックのみ |
| `npm run lint` | ESLint |
| `npm run test` | Vitest(単体) |
| `npm run test:e2e` | Playwright(E2E) |
| `npm run native:audio:build` | macOS native audio capture addon をビルド |
| `npm run native:speech:build` | Apple SpeechAnalyzer helper をビルド |
| `npm run native:audio:smoke -- --duration-ms 5000` | 実機で microphone/system audio chunk 到達を診断 |
| `npm run native:audio:local-stt-smoke -- --duration-ms 8000` | 実機 audio chunk を Apple SpeechAnalyzer へ流してlocal STT疎通確認 |
| `DEEPGRAM_API_KEY=... npm run native:audio:stt-smoke -- --duration-ms 8000` | fallback 用に実機 audio chunk を Deepgram へ送信して STT 疎通確認 |
| `npm run package:mac` | macOS DMG ビルド(Apple Silicon / arm64) |

### Native audio / local STT smoke test

実機で Screen Recording / Microphone 権限と `.node` addon の chunk 到達を確認する。

```bash
npm run native:audio:build
npm run native:audio:smoke -- --duration-ms 5000 --require-microphone
```

Zoom system audio まで必須確認する場合は Zoom を起動してから実行する。

```bash
npm run native:audio:smoke -- --duration-ms 8000 --require-microphone --require-system
```

Apple SpeechAnalyzer まで含めたlocal-first確認は、helperをビルドしてから実行する。発話が必要なため、`--require-transcript` を付ける場合は実行中にマイクへ話す。

```bash
npm run native:speech:build
npm run native:audio:local-stt-smoke -- --duration-ms 8000 --source microphone --require-transcript
```

pipelineまで確認する場合は、反論検知対象である system audio (`counterpart`) を選び、`--require-pipeline` を付ける。microphone (`self`) は文字起こしだけ行い、反論pipelineを発火しない。

```bash
npm run native:audio:local-stt-smoke -- --duration-ms 10000 --source system --require-transcript --require-pipeline
```

Deepgram まで含めた実通し確認は fallback 用。`DEEPGRAM_API_KEY` を環境変数で渡す。発話が必要なため、文字起こし必須確認では実行中にマイクへ話す。

```bash
DEEPGRAM_API_KEY=... npm run native:audio:stt-smoke -- --duration-ms 8000 --require-transcript
```

Zoom system audio を Deepgram に流す場合は Zoom を起動し、Screen Recording 権限を許可してから source を切り替える。

```bash
DEEPGRAM_API_KEY=... npm run native:audio:stt-smoke -- --source system --duration-ms 8000
```

## 構成

```
src/
├── main/            # Electron Main プロセス(TS、Codex 主体)
├── preload/         # contextBridge
├── renderer/
│   ├── overlay/     # 透過オーバーレイ React アプリ
│   └── control/     # 設定・履歴 React アプリ
├── shared/          # 型・IPC 定数・zod スキーマ
└── native/
    └── audio-capture/  # NAPI audio capture + Swift SpeechAnalyzer helper
```

## 現在の開発方針

Mac MVP は `local_first`。Apple SpeechAnalyzer で端末上文字起こしを行い、音声データを外部STTへ送らない。

- system audio と microphone は別々の SpeechAnalyzer helper で処理し、`counterpart` / `self` を入力チャネルで固定する
- Deepgram は fallback / Cloud β / 非Mac入口用
- Anthropic は議事録・カンペ・レビュー生成用で、送るのは transcript テキスト
- コンプラ判定は rule engine first、LLMは補助
- Mac商談支援とスマホ録音コンプラ議事録は、同じ transcript pipeline を使う
