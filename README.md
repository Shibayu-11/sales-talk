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
| `npm run package:mac` | macOS DMG ビルド(universal) |

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
