# Sales-Talk — Codex(AGENTS.md)プロジェクトコンテキスト

> **Codex(GPT-5.4)向け**: 本ファイルは TypeScript / React UI / Supabase スキーマ / テスト生成 / 繰り返し処理を担うエージェントへのコンテキスト。
> Swift / macOS 固有処理 / 複雑設計判断は CLAUDE.md(Claude Code 担当)を参照。

## 1. プロダクト概要

**Zoomビデオ商談中にリアルタイムで反論ハンドリングを支援する macOS アシスタント**。
複雑商材BtoB営業(不動産・健康経営優良法人・補助金助成金)向け。

詳細設計は [sales-assistant-prd.md](./sales-assistant-prd.md)(7900行、50章)。

## 2. 担当領域(Codex 主体)

- **Electron Main プロセスの TS 実装**(Swift モジュールラッパ・サービス層除く Swift 直接呼び出し以外)
- **React レンダラ**: Overlay ウィンドウ / Control ウィンドウ
- **Tailwind CSS スタイリング**(オーバーレイデザイン §12.3 準拠)
- **Supabase スキーマ**(マイグレーション、RLS、PGroonga インデックス)
- **API クライアント**: Deepgram / Anthropic / Cohere ラッパ(レジリエンシー含む)
- **テスト生成**: Vitest 単体 / Playwright 統合 / プロンプト評価データセット
- **繰り返し処理**: フォームバリデーション、CRUD UI、設定画面、エラーモーダル
- **ロギング・観測**: Pino 設定、Sentry 連携、PostHog イベント発火

Claude Code の担当(Swift/macOS)とは CLAUDE.md で分担明記。

## 3. 技術スタック

| 領域 | 採用 |
|------|------|
| 言語 | TypeScript 5.4+(`strict`、`noUncheckedIndexedAccess`) |
| Electron | 31+(electron-vite ベース、multi-window) |
| UI | React 18 + Tailwind CSS 3 + shadcn/ui(必要時) |
| 状態管理 | XState v5(`setup` API) |
| バリデーション | zod(IPC 入出力 + フォーム両用) |
| HTTP | undici(Node)/ fetch(Renderer は最小限) |
| WebSocket | `ws`(Deepgram Nova-3 ストリーミング) |
| ロギング | Pino(JSON Lines、PII マスキングミドルウェア) |
| 監視 | Sentry(`@sentry/electron`)+ PostHog Cloud |
| DB クライアント | `@supabase/supabase-js`(東京リージョン) |
| Embedding | Cohere SDK(`embed-v4`、1024次元、`input_type` 切替) |
| LLM | `@anthropic-ai/sdk`(Haiku/Sonnet、プロンプトキャッシュ前提) |
| PDF 生成 | `puppeteer-core` + Electron 内蔵 Chromium(議事録 §22) |
| テスト | Vitest(単体) / Playwright(E2E) / カスタム評価ハーネス(プロンプト) |

## 4. 絶対に守る制約

### 4.1 セキュリティ
- API キーは **Electron `safeStorage` + macOS Keychain**。Renderer に絶対渡さない。
- IPC 経由で Main がプロキシ。`window.api` は許可された関数のみ `contextBridge.exposeInMainWorld` で公開。
- LLM/STT 送信前に **PII マスキング**(電話番号・メール・氏名等を正規表現で伏字化)。
- Sentry の `beforeSend` で二重スクラブ。Session Replay は **無効化**。
- Supabase は **Tokyo ap-northeast-1**、全テーブル RLS、`tenant_id` で分離。

### 4.2 IPC(セクション23)
- `src/shared/ipc-channels.ts` に**全チャンネル定数化**(40 程度)。
- 各チャンネルに zod スキーマ(in/out)を `src/shared/schemas.ts` で定義。
- Main 集中・Renderer 薄い:Renderer は `window.api.xxx()` を呼ぶだけ、ロジックは Main。
- 双方向通信は `invoke/handle`、片方向通知は `send/on`。

### 4.3 React UI
- **Overlay**:透過(`bg-transparent`)、`backdrop-blur-xl`、`text-zinc-100`、Hiragino Sans。
  - Layer 1(15文字以内ピーク)/ Layer 2(要点3行)/ Layer 3(完全展開)の3層構造(§12.2)。
- **Control**:通常ウィンドウ、設定 / 商談履歴 / ナレッジ編集 / 商材選択(`real_estate` / `kenko_keiei` / `hojokin`)。
- **アクセシビリティ**:キーボード操作完結、フォーカスリング保持、コントラスト比 AA 以上。
- ホットキーは `globalShortcut`(Main プロセス)、Renderer 側はトリガー受信のみ。

### 4.4 法務ガードレール(LLM 出力フィルタ)
- 出力フィルタは `src/main/services/guardrail.ts` に集約、3商材で共通呼び出し。
- 禁止キーワード検出 + パターンマッチ + risk_flags 付与(§16)。
- フィルタを通過する前のテキストは絶対 UI に表示しない。

### 4.5 ロギング(セクション29)
- **Pino** 採用、JSON Lines。
- PII マスキング:**送信前自動**(`pino.transport` または custom serializer)。
- 商談中ログレベル:`info` 以上のみ。`debug` は商談データを含めない。
- ログローテーション:日次、30日保持、暗号化保存。

### 4.6 エラーハンドリング(セクション25、4分類)
| レベル | 例 | 挙動 |
|-------|---|------|
| Critical | API キー無効、Screen Recording 権限剥奪 | Overlay 停止、Control に致命エラー表示 |
| High | Deepgram 切断 30 秒+、Sonnet API 連続失敗 | サイレント劣化、インジケータで警告 |
| Medium | Haiku タイムアウト、ナレッジ検索失敗 | フォールバック、ログのみ |
| Low | UI フォーカス失敗、ホットキー一時不通 | 黙って再試行 |

商談中は基本サイレント劣化、エラー画面を出さない。

### 4.7 プロンプトキャッシュ(セクション16)
- Anthropic API 呼び出し時、システムプロンプト + ナレッジを **min 4,096 tokens** にして cache_control 指定。
- キャッシュヒット率 >80% を目標。商材切り替え時のみキャッシュ更新。
- Haiku 検知は発話単位トリガー(500ms 毎ではない、§11 決定事項)。

### 4.8 XState(セクション14)
- `setup({ types, actions, guards, actors })` で型推論。
- 並列ステート(`type: 'parallel'`)で Audio/Pipeline/Overlay を独立。
- 全状態遷移をログ(イベントソーシング、§14.11)。
- リアクト連携は `@xstate/react` の `useActor`。

## 5. ディレクトリ構造

```
sales-talk/
├── CLAUDE.md
├── AGENTS.md                    # 本ファイル
├── sales-assistant-prd.md       # 設計書
├── package.json
├── electron.vite.config.ts
├── electron-builder.yml
├── tsconfig.json
├── tailwind.config.ts
├── src/
│   ├── main/                    # Electron Main(Codex 主体、Swift 統合は CLAUDE.md)
│   │   ├── index.ts
│   │   ├── ipc/                 # IPC ハンドラ
│   │   │   ├── audio.ts
│   │   │   ├── permissions.ts
│   │   │   ├── settings.ts
│   │   │   └── ...
│   │   ├── windows/
│   │   │   ├── overlay.ts       # Overlay 生成・管理
│   │   │   └── control.ts
│   │   ├── audio/               # Swift モジュールラップ(NAPI 呼び出し)
│   │   ├── services/            # Deepgram / Claude / Supabase クライアント
│   │   │   ├── deepgram.ts      # ResilientSTTClient(§15.7)
│   │   │   ├── claude.ts        # Haiku/Sonnet ラッパ、プロンプトキャッシュ
│   │   │   ├── supabase.ts
│   │   │   ├── cohere.ts        # embedding
│   │   │   └── guardrail.ts     # 出力フィルタ
│   │   ├── machines/            # XState マシン定義
│   │   │   ├── app.machine.ts
│   │   │   ├── objection-pipeline.machine.ts
│   │   │   └── ...
│   │   ├── logger.ts            # Pino + PII マスク
│   │   └── crypto.ts            # AES-256-GCM、Keychain 連携
│   ├── preload/
│   │   ├── overlay.ts
│   │   └── control.ts
│   ├── renderer/
│   │   ├── overlay/
│   │   │   ├── index.html
│   │   │   └── src/
│   │   │       ├── main.tsx
│   │   │       ├── App.tsx
│   │   │       └── components/
│   │   └── control/
│   │       ├── index.html
│   │       └── src/
│   │           ├── main.tsx
│   │           ├── App.tsx
│   │           ├── pages/
│   │           │   ├── Setup.tsx
│   │           │   ├── Settings.tsx
│   │           │   ├── History.tsx
│   │           │   ├── Knowledge.tsx
│   │           │   └── Tasks.tsx
│   │           └── components/
│   ├── shared/
│   │   ├── types.ts
│   │   ├── ipc-channels.ts      # IPC 定数(zod スキーマと対応)
│   │   ├── schemas.ts           # zod
│   │   └── constants.ts
│   └── native/                  # Swift(CLAUDE.md 担当)
├── prompts/
│   ├── haiku/
│   │   ├── detection.ja.yaml
│   │   └── ...
│   └── sonnet/
│       ├── response.real_estate.ja.yaml
│       ├── response.kenko_keiei.ja.yaml
│       ├── response.hojokin.ja.yaml
│       └── meeting_minutes.ja.yaml
├── supabase/
│   └── migrations/
│       ├── 0001_init.sql
│       ├── 0002_knowledge.sql
│       └── ...
├── scripts/
│   └── license-audit.ts
└── tests/
    ├── unit/
    ├── integration/
    └── e2e/
```

## 6. コーディング規約

### TypeScript
- `strict: true`、`noUncheckedIndexedAccess: true`、`exactOptionalPropertyTypes: true`。
- 例外は型定義(`type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E }` パターン推奨)。
- `any` 禁止、`unknown` 経由で zod 検証。
- IPC 入出力は zod。スキーマから型推論(`z.infer<typeof schema>`)。

### React
- 関数コンポーネントのみ。class component 禁止。
- カスタムフック命名 `useXxx`、`@xstate/react` の `useActor` で XState 連携。
- メモ化は計測してから(早すぎる最適化禁止)。
- スタイリングは Tailwind、複雑なものは `clsx` + variants。

### コミットメッセージ
- Conventional Commits(`feat:` / `fix:` / `chore:` / `docs:` / `refactor:` / `test:`)。
- 1コミット1論点。PR は機能単位で小さく。

### コメント
- WHY のみ書く。WHAT は型と命名で表現。
- 「PRD §X.Y に準拠」のように、設計書参照を残す。

## 7. テスト方針(セクション30)

| レイヤー | 採用 | 対象 |
|---------|------|------|
| 単体 | Vitest | サービス層、ガードレール、ステート遷移、ユーティリティ |
| 統合 | Vitest + msw | 外部 API モック(Deepgram/Anthropic/Supabase) |
| E2E | Playwright | Electron アプリ起動、UI 操作 |
| プロンプト評価 | カスタムハーネス | 反論検知 100 件、切り返し品質 50 件、ガードレール |

- **AI 生成コードは必ずテストとセット**で出す(Codex に明示プロンプト)。
- カバレッジは目安 70%、重要なパス(ガードレール、課金、PII)は 90%+。

## 8. 禁止事項

- ❌ Renderer から API キー/Supabase service_role キー直接アクセス
- ❌ `console.log` を商談データに対して使う(必ず `logger.info` 経由、PII マスク前提)
- ❌ `dangerouslySetInnerHTML` の使用
- ❌ npm install 時の `--force` / `--legacy-peer-deps`(Phase 2 の依存解決時に検討)
- ❌ `any` を使った型回避
- ❌ IPC で生のオブジェクトを渡す(必ず zod 検証)
- ❌ 商談中の自動アップデート(`autoUpdater.checkForUpdates()` を商談中に呼ばない)
- ❌ Session Replay の有効化(PostHog 設定で off)

## 9. PRD セクション参照表

| 何をするとき | 参照セクション |
|------------|---------------|
| Overlay UI | §12 |
| ステートマシン | §14 |
| Deepgram 接続 | §15 |
| プロンプト | §16 |
| ナレッジベース(Supabase) | §17, §18 |
| 議事録 + PDF + タスク | §22 |
| IPC | §23 |
| オンボーディング | §24 |
| エラー横串 | §25 |
| 権限剥奪 UX | §26 |
| アプリ設定管理 | §28 |
| ロギング | §29 |
| テスト | §30 |
| マイグレーション | §31 |
| アップデート | §32 |
| 多ユーザー / RLS | §33 |
| KPI / PostHog | §21 |

## 10. 開発フロー

1. PRD 該当セクションを読む(設計の根拠を理解)
2. 既存の命名・ディレクトリ規約に合わせる
3. 実装 + テストを同一 PR で
4. `npm run lint && npm run typecheck && npm test` を通してから PR
5. CodeRabbit + 人間最終レビュー
6. Claude Code 担当領域(Swift)に踏み込む場合は事前に CLAUDE.md 確認

## 11. エージェント協働

- **Codex(本ファイル)**: TS / React / DB / テスト / 繰り返し処理
- **Claude Code(CLAUDE.md)**: Swift / macOS / 複雑設計
- **相互レビュー**: 一方の生成コードを他方に批評させる(セクション27)
- **重複作業を避ける**: ファイル単位で担当を意識、Swift モジュールは Claude Code、TS は Codex

## 12. 重要な決定事項(意思決定ログ §11 抜粋)

- 2026-04-21: XState 採用、`type: 'parallel'` で Audio/Pipeline/Overlay 並列
- 2026-04-21: Cohere embed-v4(1024次元、MRL、`input_type` 使い分け)
- 2026-04-21: PGroonga(日本語FTS)、RRF ハイブリッド検索
- 2026-04-22: Pino 採用、商談中は info+ のみ
- 2026-04-22: API キー Electron safeStorage + Keychain
- 2026-04-23: 議事録 + PDF + タスクの3本柱(セクション22)
- 2026-04-23: タスクは own/customer/joint の3分類
- 2026-04-24: マイグレーションで既存カラム削除禁止(deprecated_ プレフィックス→3ヶ月後削除)
- 2026-04-24: 商談中の自動アップデート禁止、15分後リトライ
- 2026-04-27: VibeVoice-ASR は Phase 2 検討候補(MVP は Deepgram 維持)

## 13. 困ったとき

- PRD セクション参照(本ファイル §9 表)
- TypeScript 型エラーで詰まったら zod スキーマから型推論を疑う
- React レンダリング不具合は Devtools(Components)で props/state 確認
- IPC で値が届かない → zod スキーマ検証エラー、`logger` で捕捉
- Supabase クエリが遅い → EXPLAIN ANALYZE、PGroonga インデックス確認
