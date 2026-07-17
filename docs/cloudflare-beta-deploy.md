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
| 認証(PBKDF2 + 署名セッション、アカウントロック、招待 / reset token email delivery) | 実装済み |
| D1 マイグレーション 8本 | 実装済み |
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

## 3. シークレット設定(必須・3種 + email mode)

**リポジトリにもコマンド引数にも残さない。** wrangler の対話入力を使う。

```bash
# セッション署名鍵(32バイトのランダム)
openssl rand -hex 32 | npx wrangler secret put SESSION_SIGNING_KEY

# 初回資格情報設定だけに使う bootstrap トークン(任意の強いランダム文字列)
openssl rand -hex 24 | npx wrangler secret put API_TOKEN

# Deepgram(クラウド STT に使用。Deepgram ダッシュボードで発行)
npx wrangler secret put DEEPGRAM_API_KEY
```

Email delivery を使う場合:

```bash
npx wrangler email sending list
npx wrangler email sending enable recustep.com
npx wrangler email sending dns get recustep.com
```

現時点の実アカウントは `npx wrangler email sending list` が `No zones found` なので、`recustep.com` の送信 domain onboarding / DNS が未完了。Cloudflare Email Sending は Public Beta かつ Workers Paid plan が前提。root `wrangler.jsonc` は production の `AUTH_EMAIL_DELIVERY_MODE=email`、送信元 `noreply@recustep.com`、`allowed_sender_addresses` 同値で固定する。別domainを使う場合は送信元2箇所を同時に変更する。

## 4. マイグレーションとデプロイ

```bash
npm run cloudflare:typecheck       # 型チェック(緑を確認)
npm run cloudflare:guard:production # productionがemail modeか確認
npm run cloudflare:deploy:dry      # バンドル検証(認証不要)
npm run cloudflare:migrate:remote  # D1 スキーマ適用(デプロイ後)
npx wrangler deploy                # 本番デプロイ
```

`0007_account_lifecycle.sql` は新 Worker が参照する `organization_memberships.status`、
`auth_credentials.must_reset_password`、`auth_action_tokens.consumed_by_request_id`、
`audit_logs.sequence`、および MVP の `organization_memberships(user_id)` UNIQUE 制約を追加するため、
既存稼働環境では **migration → deploy** の順で適用する。
既存 Worker は追加カラムを参照しないので、先に migration しても互換性がある。
`0008_auth_email_delivery.sql` は `auth_action_deliveries` と `auth_credentials.active_password_reset_token_id` を追加する。delivery table には平文 token / 本文 / 宛先メールを保存しない。

互換性を守るproduction rollout順:

1. 旧Workerがmanual responseを返している間に、新Electron appを先行配布する
2. `0008` migrationを適用する
3. tokenなしemail responseを返す新Workerをdeployする
4. domain onboarding/DNS完了後、production email modeで通し確認する

新appは旧Workerの `mode` / `deliveryId` なしtoken responseを `manual_beta` として読みます。旧appは新email Workerのtokenなしresponseを扱えないため、**新app → Worker → email mode** の順序を崩しません。

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

Email delivery SaaS 管理:

1. admin でログイン
2. Settings → `Cloudflare SaaS ユーザー管理` で `email / displayName / role / organization` を指定して `招待メール送信`
3. email mode では管理者 UI に raw token は出ず、`送信受付済み` と masked recipient / deliveryId のみ表示
4. 対象ユーザーはメール本文の token を Settings の `メールで届いた token` に貼り付け、新パスワードで `招待を承諾`
5. reset は admin が `再設定メール送信` → 対象ユーザーがメールの token で `パスワード再設定を完了`
6. 商談履歴の「Cloudへアップロード」で音声 → クラウド STT → transcript を確認

接続先 URL が既定と違う場合は `cloudflare-api.ts` の `DEFAULT_API_URL` を自分の Worker URL に変更。

招待 / reset token は raw 値を D1 に保存しない。Worker は32 random bytesをbase64url化し、D1にはSHA-256 hashとclaim request idのみ保存する。email mode は raw token を admin API response / Electron UI に返さない。Email Service の戻り値は送信受付であり、最終到達ではない。

manual_beta 互換:

- `AUTH_EMAIL_DELIVERY_MODE=manual_beta` を明示した場合のみ raw token を一度だけ返す。
- token 手動共有は bearer secret の共有なので本番不可。
- manual_beta でも delivery record は `cancelled` として残し、email delivery への切替漏れを監査可能にする。
- production guardがroot configのmanual_betaを拒否するため、ローカルだけ `.dev.vars` または `npx wrangler dev --var AUTH_EMAIL_DELIVERY_MODE:manual_beta` で明示する。

## 6. ローカル開発(任意)

```bash
npm run cloudflare:migrate:local   # miniflare のローカル D1 にスキーマ適用
npm run cloudflare:dev             # wrangler dev(ローカル Worker)
# または: npx wrangler dev --var AUTH_EMAIL_DELIVERY_MODE:manual_beta
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
- [ ] Admin: 招待メール送信 → 送信受付済み → メール token 承諾 → users一覧 active 反映
- [ ] Admin: 再設定メール送信 → 通常ログイン拒否 → メール token reset完了 → 新session取得
- [ ] Admin: disable → 既存session失効 / 未使用 invite-reset token 消費 / `must_reset_password=0` 復帰 / self-disable と last active admin が拒否される
- [ ] Deepgram `mip_opt_out=true`(Model Improvement Program オプトアウト)を確認(PRD §4.2)

## 8. 注意

- **音声がクラウド(R2)と Deepgram に渡る**経路。ローカル STT(Apple SpeechAnalyzer)とは
  プライバシー前提が異なるので、顧客同意と設定画面の文言で明確に区別すること(2軸計画 §3.5)。
- アカウントライフサイクル token / password / session はログや監査metadataへ平文保存しない。監査ログには actor、scope、target、token種別、token ID、期限のみを残す。
- token 完了監査の actor は target user ではなく `action_token`。発行管理者 ID は metadata に残す。
- membership disable 監査には、未使用 token 消費と `must_reset_password` 解除を metadata に残す。再有効化後に古い reset 要求でログイン不能にならないことを確認する。
- email mode では API/UI に raw token を出さない。manual_beta は明示設定時だけの互換で、本番不可。
- 同一membershipへのreset並行発行は、後続tokenが先行tokenを失効させた後に先行メールだけ受付されるstale emailが起こり得る既知P2制約。Electron UIはglobal pendingと同一membership guardで連打を抑止するが、複数管理者/API間のserializationは未実装。
- β は Cloudflare、Enterprise は AWS adapter を想定(2軸計画 §3.4)。`Repository` interface で差し替え可能。
