# Cloudflare API

SalesTalk のマルチテナントクラウドAPIです。

## 接続先

- Worker: `https://sales-talk-api.lively-violet-0704.workers.dev`
- D1: `sales-talk-prod`（APAC）

## 初期設定

保護APIを有効化するには、Cloudflare側とElectron設定画面へ同じAPIトークンを保存します。

```sh
npx wrangler secret put API_TOKEN
```

トークンはコマンド引数やリポジトリへ保存せず、Wranglerの対話入力を使用してください。
Electron側では設定画面の `Cloudflare API token` からmacOS Keychainへ保存します。

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

保護APIは以下を要求します。

- `Authorization: Bearer <API_TOKEN>`
- `x-tenant-id`
- `x-organization-id`
- `x-user-id`

WorkerはD1の `organization_memberships` を照合し、テナント・組織境界を強制します。
