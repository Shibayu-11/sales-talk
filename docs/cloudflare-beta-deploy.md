# Cloudflare β デプロイ手順

作成日: 2026-06-15
対応: [2軸開発計画](./two-track-development-plan.md) Phase 4 / [MVP ロードマップ](./mvp-release-roadmap.md) Week 6 以降
目的: アップロード音声 → Deepgram STT → transcript → 議事録 をクラウド(Workers/D1/R2/Queues)で回す β を立ち上げる。

## 0. 現状(2026-06-15 検証済み)

コード側は**デプロイ可能**。`npm run cloudflare:deploy:dry` が認証なしで成功し、Worker(161KiB)が
D1 / R2 / Queue の全バインディングを解決することを確認済み。残るブロッカーは**アカウントとシークレットの準備だけ**(柴さん作業)。

| 要素 | 状態 |
|---|---|
| Worker(`cloudflare/src/index.ts`、account lifecycle + STT endpoints + Queue consumer) | 実装済み |
| 認証(PBKDF2 + 署名セッション、アカウントロック、招待 / reset token) | 実装済み |
| D1 マイグレーション 7本 | 実装済み |
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

## 4. マイグレーションとデプロイ

```bash
npm run cloudflare:typecheck       # 型チェック(緑を確認)
npm run cloudflare:deploy:dry      # バンドル検証(認証不要)
npm run cloudflare:migrate:remote  # D1 スキーマ適用(デプロイ後)
npx wrangler deploy                # 本番デプロイ
```

`0007_account_lifecycle.sql` は新 Worker が参照する `organization_memberships.status`、
`auth_credentials.must_reset_password`、`auth_action_tokens.consumed_by_request_id`、
`audit_logs.sequence`、および MVP の `organization_memberships(user_id)` UNIQUE 制約を追加するため、
既存稼働環境では **migration → deploy** の順で適用する。
既存 Worker は追加カラムを参照しないので、先に migration しても互換性がある。

疎通確認:

```bash
curl https://<your-worker>.workers.dev/health
# 期待: {"ok":true,...}
```

## 5. Electron 側の接続 / アカウント発行

互換 bootstrap:

1. クラウド側で **bootstrap トークン**(= §3 の `API_TOKEN`)を控える
2. アプリの設定 → `Cloudflare bootstrap token` に保存
3. `初回資格情報設定` でseed済みユーザーのメール + パスワードを登録(未設定ユーザーに一度だけ)
4. 以降は `ログイン` で署名セッションを取得(Main プロセスが safeStorage 保管、Renderer 非公開)

β / 手動配送 SaaS 管理:

1. admin でログイン
2. Settings → `Cloudflare SaaS ユーザー管理` で `email / displayName / role / organization` を指定して `招待発行`
3. 表示された招待 bearer token を一度だけコピーし、対象ユーザーへ手動共有
4. 対象ユーザーは Settings の `招待 / パスワード再設定トークン` に token + 新パスワードを入力し `招待を承諾`
5. reset は admin が `reset発行` → token 手動共有 → 対象ユーザーが `パスワード再設定を完了`
6. 商談履歴の「Cloudへアップロード」で音声 → クラウド STT → transcript を確認

接続先 URL が既定と違う場合は `cloudflare-api.ts` の `DEFAULT_API_URL` を自分の Worker URL に変更。

招待 / reset token は raw 値を D1 に保存しない。Worker は32 random bytesをbase64url化して一度だけ返し、D1にはSHA-256 hashとclaim request idのみ保存する。
token をメールやチャットで共有する場合、期限(招待72h / reset30m)と操作種別を明記し、使用後は破棄する。
ただし手動配送 token は bearer secret であり、token を見た管理者は受信者として承諾 / reset 完了できる。この caveat は未解決なので、一般本番前に検証済みメール配送へ置き換えること。

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
- [ ] `migrate:remote` でスキーマ適用
- [ ] `wrangler deploy` 成功
- [ ] `/health` が ok
- [ ] Electron: bootstrap互換またはadmin招待 → ログイン → 音声アップロード → transcript 取得まで通し
- [ ] Admin: 招待発行 → 承諾 → users一覧 active 反映
- [ ] Admin: reset発行 → 通常ログイン拒否 → reset完了 → 新session取得
- [ ] Admin: disable → 既存session失効 / 未使用 invite-reset token 消費 / `must_reset_password=0` 復帰 / self-disable と last active admin が拒否される
- [ ] Deepgram `mip_opt_out=true`(Model Improvement Program オプトアウト)を確認(PRD §4.2)

## 8. 注意

- **音声がクラウド(R2)と Deepgram に渡る**経路。ローカル STT(Apple SpeechAnalyzer)とは
  プライバシー前提が異なるので、顧客同意と設定画面の文言で明確に区別すること(2軸計画 §3.5)。
- アカウントライフサイクル token / password / session はログや監査metadataへ平文保存しない。監査ログには actor、scope、target、token種別、token ID、期限のみを残す。
- token 完了監査の actor は target user ではなく `action_token`。発行管理者 ID は metadata に残す。
- membership disable 監査には、未使用 token 消費と `must_reset_password` 解除を metadata に残す。再有効化後に古い reset 要求でログイン不能にならないことを確認する。
- 現行UIの token 手動配送はβ用。検証済みメール配送が入るまで、一般本番としては扱わない。
- β は Cloudflare、Enterprise は AWS adapter を想定(2軸計画 §3.4)。`Repository` interface で差し替え可能。
