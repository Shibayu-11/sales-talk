# SalesTalk

Zoomビデオ商談中にリアルタイムで反論ハンドリングを支援する macOS アシスタント。

詳細設計: [sales-assistant-prd.md](./sales-assistant-prd.md)
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
| `npm run native:audio:smoke -- --duration-ms 5000` | 実機で microphone/system audio chunk 到達を診断 |
| `DEEPGRAM_API_KEY=... npm run native:audio:stt-smoke -- --duration-ms 8000` | 実機 audio chunk を Deepgram へ送信して STT 疎通確認 |
| `npm run package:mac` | macOS DMG ビルド(universal) |

### Native audio smoke test

実機で Screen Recording / Microphone 権限と `.node` addon の chunk 到達を確認する。

```bash
npm run native:audio:build
npm run native:audio:smoke -- --duration-ms 5000 --require-microphone
```

Zoom system audio まで必須確認する場合は Zoom を起動してから実行する。

```bash
npm run native:audio:smoke -- --duration-ms 8000 --require-microphone --require-system
```

Deepgram まで含めた実通し確認は `DEEPGRAM_API_KEY` を環境変数で渡す。発話が必要なため、文字起こし必須確認では実行中にマイクへ話す。

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
    └── audio-capture/  # Swift + NAPI(Claude Code 主体)
```
