# Cloudflare β デプロイ手順

作成日: 2026-06-15
対応: [2軸開発計画](./two-track-development-plan.md) Phase 4 / [MVP ロードマップ](./mvp-release-roadmap.md) Week 6 以降
目的: アップロード音声 → Deepgram STT → transcript → 議事録 をクラウド(Workers/D1/R2/Queues)で回す β を立ち上げる。

## 0. 現状(2026-06-15 検証済み)

コード側は**デプロイ可能**。`npm run cloudflare:deploy:dry` が認証なしで成功し、Worker(161KiB)が
D1 / R2 / Queue の全バインディングを解決することを確認済み。残るブロッカーは**アカウントとシークレットの準備だけ**(柴さん作業)。

| 要素 | 状態 |
|---|---|
| Worker(`cloudflare/src/index.ts`、13 エンドポイント + Queue consumer) | 実装済み |
| 認証(PBKDF2 + 署名セッション、アカウントロック) | 実装済み |
| D1 マイグレーション 6本 | 実装済み |
| 署名付きアップロードURL → R2 → STT job → transcript | 実装済み・テスト済み |
| Electron クライアント(`cloudflare-api.ts`) | 実装済み・テスト済み |
| `wrangler.jsonc`(root、D1/R2/Queue バインディング) | 設定済み |
| Cloudflare アカウント / リソース実体 | **未確認(要準備)** |
| シークレット 3種 | **未設定(要準備)** |

接続先(README より): Worker `https://sales-talk-api.lively-violet-0704.workers.dev` / D1 `sales-talk-prod`。

## 1. 前提:どのアカウントに出すか

`wrangler.jsonc` の D1 `database_id` は既存リソース(`fe4a14d0-...`)を指している。2通り:

- **A. 既存リソースを使う**: そのアカウントの API トークンで `wrangler login`。リソースは作成済みなので §3 のシークレット設定から。
- **B. 自分のアカウントに新規作成**: §2 でリソースを作り直し、`wrangler.jsonc` の `database_id` / bucket / queue 名を差し替える。

β を一人で立てるなら B が素直(他人のリソースに相乗りしない)。

## 2. リソース作成(アカウント B の場合のみ)

```bash
npx wrangler login                       # ブラウザ認証
npx wrangler d1 create sales-talk-prod    # → 出力の database_id を wrangler.jsonc に貼る
npx wrangler r2 bucket create sales-talk-audio-prod
npx wrangler queues create sales-talk-stt-jobs
```

`wrangler.jsonc` の `database_id` を新しい値に更新する(name は同じでよい)。

## 3. シークレット設定(必須・3種)

**リポジトリにもコマンド引数にも残さない。** wrangler の対話入力を使う。

```bash
# セッション署名鍵(32バイトのランダム)
openssl rand -hex 32 | npx wrangler secret put SESSION_SIGNING_KEY

# 初回資格情報設定だけに使う bootstrap トークン(任意の強いランダム文字列)
openssl rand -hex 24 | npx wrangler secret put API_TOKEN

# Deepgram(クラウド STT に使用。Deepgram ダッシュボードで発行)
npx wrangler secret put DEEPGRAM_API_KEY
```

## 4. デプロイ

```bash
npm run cloudflare:typecheck       # 型チェック(緑を確認)
npm run cloudflare:deploy:dry      # バンドル検証(認証不要)
npx wrangler deploy                # 本番デプロイ
npm run cloudflare:migrate:remote  # D1 スキーマ適用(デプロイ後)
```

疎通確認:

```bash
curl https://<your-worker>.workers.dev/health
# 期待: {"ok":true,...}
```

## 5. Electron 側の接続

1. クラウド側で **bootstrap トークン**(= §3 の `API_TOKEN`)を控える
2. アプリの設定 → `Cloudflare bootstrap token` に保存
3. `初回資格情報設定` でユーザー別メール + パスワードを登録(未設定ユーザーに一度だけ)
4. 以降は `ログイン` で署名セッションを取得(Main プロセスが safeStorage 保管、Renderer 非公開)
5. 商談履歴の「Cloudへアップロード」で音声 → クラウド STT → transcript を確認

接続先 URL が既定と違う場合は `cloudflare-api.ts` の `DEFAULT_API_URL` を自分の Worker URL に変更。

## 6. ローカル開発(任意)

```bash
npm run cloudflare:migrate:local   # miniflare のローカル D1 にスキーマ適用
npm run cloudflare:dev             # wrangler dev(ローカル Worker)
```

ローカルではシークレットを `.dev.vars`(gitignore 済みであること)に置く。

## 7. β チェックリスト

- [ ] アカウント決定(A 既存 / B 新規)
- [ ] (B のみ)D1 / R2 / Queue 作成 + `wrangler.jsonc` 更新
- [ ] シークレット 3種設定
- [ ] `wrangler deploy` 成功
- [ ] `migrate:remote` でスキーマ適用
- [ ] `/health` が ok
- [ ] Electron: bootstrap → ログイン → 音声アップロード → transcript 取得まで通し
- [ ] Deepgram `mip_opt_out=true`(Model Improvement Program オプトアウト)を確認(PRD §4.2)

## 8. 注意

- **音声がクラウド(R2)と Deepgram に渡る**経路。ローカル STT(Apple SpeechAnalyzer)とは
  プライバシー前提が異なるので、顧客同意と設定画面の文言で明確に区別すること(2軸計画 §3.5)。
- β は Cloudflare、Enterprise は AWS adapter を想定(2軸計画 §3.4)。`Repository` interface で差し替え可能。
