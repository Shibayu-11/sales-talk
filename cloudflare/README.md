# Cloudflare API

SalesTalk のマルチテナントクラウドAPIです。

## 接続先

- Worker: `https://sales-talk-api.lively-violet-0704.workers.dev`
- D1: `sales-talk-prod`（APAC）

## 初期設定

`API_TOKEN` は初回ユーザー資格情報設定専用です。通常APIはユーザーログインで発行される署名済みセッションだけを受け付けます。

```sh
npx wrangler secret put API_TOKEN
npx wrangler secret put SESSION_SIGNING_KEY
```

秘密値はコマンド引数やリポジトリへ保存せず、Wranglerの対話入力を使用してください。
Electron側では設定画面の `Cloudflare bootstrap token` を保存後、`初回資格情報設定` でユーザー別パスワードを登録します。
ログイン後のセッショントークンは Main プロセスが `safeStorage` へ保存し、Renderer には公開しません。
初回資格情報設定は未設定ユーザーに対して一度だけ実行できます。設定後の変更はログイン状態で `パスワード更新` を使用します。

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
パスワード更新とログアウト時はセッションバージョンを更新し、既存セッションを失効させます。
