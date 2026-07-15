# Cloudflare API

SalesTalk のマルチテナントクラウドAPIです。

## 接続先

- Worker: `https://sales-talk-api.lively-violet-0704.workers.dev`
- D1: `sales-talk-prod`（APAC）

## 初期設定

`API_TOKEN` は既存ローカルseedの手動bootstrap互換用です。通常APIはユーザーログイン、招待承諾、またはパスワード再設定完了で発行される署名済みセッションだけを受け付けます。

```sh
npx wrangler secret put API_TOKEN
npx wrangler secret put SESSION_SIGNING_KEY
npx wrangler secret put DEEPGRAM_API_KEY
```

秘密値はコマンド引数やリポジトリへ保存せず、Wranglerの対話入力を使用してください。
Electron側では設定画面の `Cloudflare bootstrap token` を保存後、互換用の `初回資格情報設定` でseed済みユーザーのパスワードを登録できます。
ログイン後のセッショントークンは Main プロセスが `safeStorage` へ保存し、Renderer には公開しません。
β運用では、管理者が `Cloudflare SaaS ユーザー管理` から招待tokenまたは再設定tokenを発行し、対象ユーザーが token + 新パスワードで完了します。
この手動配送 token は bearer secret です。token を見た管理者は受信者として操作できるため、一般本番前に検証済みメール配送へ置き換える必要があります。
初回資格情報設定は未設定ユーザーに対して一度だけ実行できます。設定後の通常変更はログイン状態で `パスワード更新` を使用します。

## アカウントライフサイクル

`0007_account_lifecycle.sql` で次を追加します。

- `organization_memberships.status`: `active` / `invited` / `disabled`。既存行は `active`、status index あり。
- MVP の identity model は「1 user = 1 organization_membership」。`organization_memberships(user_id)` の UNIQUE index で、同じ credential/user を別 tenant / organization に再所属させません。
- `auth_credentials.must_reset_password`: reset 発行後の通常ログイン遮断フラグ。
- `auth_action_tokens`: 招待 / パスワード再設定の一回限り token。D1 には SHA-256 hash と claim request id のみ保存し、平文 token はレスポンスで一度だけ返します。
- `audit_logs.sequence`: server lifecycle audit 用の tenant 内連番。hash payload に sequence を含め、同一 sequence の競合 insert は UNIQUE index で batch rollback させます。既存の sequence NULL 行は初期 baseline として残します。

Token TTL:

- 招待: 72時間
- パスワード再設定: 30分

管理権限:

- `agency_admin`: 自組織のみ管理可能。`insurer_admin` を割り当て不可。
- `insurer_admin`: 同一 tenant 内の組織を管理可能。
- `manager` / `agent` / `auditor`: アカウントライフサイクル操作不可。

保護:

- 自分自身の disable は拒否。
- 組織内の最後の active admin disable は status UPDATE 条件内で拒否。
- disable と password reset 発行は `session_version` を進め、既存セッションを失効。
- password reset 発行は `must_reset_password=1` にし、reset 完了まで通常ログインと既存セッション解決を拒否。
- invite/reset 完了は token 消費時に unique claim request id を保存し、user / credential / membership / audit の後続更新をその claim id に条件付けます。
- disable は同じ batch で対象 membership/user の未使用 invite/reset token を消費し、credential がある場合は `must_reset_password=0` に戻します。これにより、再有効化後に古い reset 要求が残って永久ログイン不能になる状態を防ぎます。
- 完了監査ログの actor は target user ではなく `action_token`。発行管理者 ID は metadata に残し、平文 token と password は metadata/log に入れません。

## コマンド

```sh
npm run cloudflare:types
npm run cloudflare:typecheck
npm run cloudflare:migrate:local
npm run cloudflare:migrate:remote
npm run cloudflare:deploy:dry
npx wrangler deploy
```

## API認証

初回資格情報設定:

- `Authorization: Bearer <API_TOKEN>`
- `POST /v1/auth/bootstrap`

通常ログイン:

- `POST /v1/auth/login`
- メールアドレスと12文字以上のパスワード

保護API:

- `Authorization: Bearer <SIGNED_SESSION>`

Workerは署名済みセッションとD1の `organization_memberships` を照合し、リクエストヘッダーによるユーザー・テナント・組織のなりすましを拒否します。セッション有効期限は12時間です。
ログインとセッション解決は `organization_memberships.status='active'` かつ `auth_credentials.must_reset_password=0` を必須にします。
パスワード更新・ログアウト・disable・reset発行時はセッションバージョンを更新し、既存セッションを失効させます。disable 時は未使用 reset token の消費と同時に `must_reset_password=0` へ戻します。

アカウントライフサイクルAPI:

- `GET /v1/organizations`
  - 管理者のみ。招待先 selector 用。`insurer_admin` は同一 tenant、`agency_admin` は自組織のみ。
- `GET /v1/organization/users`
  - 管理者のみ。`insurer_admin` は同一 tenant、`agency_admin` は自組織のみ。
- `POST /v1/organization/invitations`
  - body: `email`, `displayName?`, `role`, `organizationId?`
  - returns: 72時間有効の招待 `token`。D1 は hash のみ保存。
- `POST /v1/auth/invitations/accept`
  - public body: `token`, `password`, `displayName?`
  - credential 作成、membership active 化、token 消費、署名セッション返却。
- `POST /v1/organization/password-resets`
  - body: `membershipId`
  - 既存セッション失効、`must_reset_password=1`、30分有効 token 返却。
- `POST /v1/auth/password-resets/complete`
  - public body: `token`, `password`
  - credential/session version 更新、`must_reset_password=0`、token 消費、署名セッション返却。
- `POST /v1/organization/memberships/:id/status`
  - body: `{ "status": "active" | "disabled" }`
  - disable 時は既存セッション失効、未使用 invite/reset token 消費、`must_reset_password=0` への復帰。`invited` の完了は招待承諾APIを使います。

Electron の Settings UI は、生成された invite/reset bearer token を一度だけ表示します。Renderer persistence や logs には保存せず、期限到来で画面から消します。手動共有時は token だけでなく対象メール・期限・操作種別を併せて伝えてください。この手動配送はβ限定であり、管理者が token を見られる限り受信者になりすませるため、一般本番では検証済みメール配送が必須です。

## 外部API secrets

- `DEEPGRAM_API_KEY`: 音声アップロード後のSTT worker / queue処理で使用します。Electron側にも同じkeyを `safeStorage` へ保存します。

## 音声アップロード / STT Queue

Cloudflare βでは、認証済みセッションで音声をWorkerへ送信し、WorkerがR2保存とD1メタデータ作成を行います。その後 `sales-talk-stt-jobs` QueueへSTT jobを投入し、consumerがDeepgram prerecorded STTを実行します。

リソース:

- R2 bucket: `sales-talk-audio-prod`
- Queue: `sales-talk-stt-jobs`
- D1 tables: `audio_assets`, `stt_jobs`, `transcript_segments`

API:

- `POST /v1/audio-upload-urls`
  - `Authorization: Bearer <SIGNED_SESSION>`
  - body: `fileName`, `mimeType`, `sizeBytes`, `productId`
  - returns: 15分有効・一回限りの `PUT uploadUrl`
- `PUT /v1/audio-upload-urls/{token}`
  - `Authorization` 不要。署名token、期限、D1の未使用状態、`content-length` 一致を検証
  - 成功時にR2保存、D1メタデータ作成、Queue投入を行う
- `POST /v1/audio-assets`
  - `Authorization: Bearer <SIGNED_SESSION>`
  - body: 音声バイナリ
  - headers: `content-type`, `content-length`, `x-file-name`, `x-product-id`
  - returns: `callId`, `audioAssetId`, `sttJobId`, `status: queued`
- `GET /v1/stt-jobs/{id}`
  - STT jobの状態確認
- `GET /v1/calls/{id}/transcripts`
  - STT完了後のtranscript取得

互換用にWorker直アップロードも残しています。スマホ・管理画面は署名URL方式を優先します。
