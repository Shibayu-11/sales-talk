# セルログ AI-Native 業務API 計画

作成日: 2026-05-26
目的: SalesTalk を「Mac商談支援」だけでなく、保険営業向けの `セルログ` として成立する AI-Native 業務システムへ再設計する。

## 1. 結論

最初に作るべきものは、汎用AI基盤ではない。

最初に作るべきものは、保険営業の会話・議事録・コンプラ判定・上長レビューを扱う **業務API** である。

UI、スマホ録音、Macリアルタイム支援、AIチャット、将来の音声エージェントは、すべて同じ業務APIを使うクライアントとして扱う。

```txt
ユーザー
 ├─ 画面UI
 ├─ スマホ録音
 ├─ Macリアルタイム支援
 └─ LLM Chat / Voice / Agent
        ↓
      業務API
        ↓
   ルールエンジン / 権限 / 監査ログ
        ↓
       Storage
```

## 2. プロダクト定義

### 名前

`セルログ`

意味付け:

- Sell Log: 営業活動の記録
- Sales Compliance Log: 保険営業コンプラの証跡
- Cell Log: 組織単位・担当者単位の活動ログ

### 一文定義

保険営業の録音・文字起こし・議事録・コンプライアンス判定・上長レビュー・監査証跡を、AIと業務APIで一体化する SaaS。

### 狙う提供価値

- 営業マンを「監視」するのではなく、あとから問題になる発話から守る
- 管理者が全件を読むのではなく、要確認案件だけ確認できる
- 会社ごとの募集ルールを、現場会話の改善に落とし込む
- 監査時に「誰が、いつ、何を確認したか」を証跡として出せる

## 3. AI-Native の設計原則

### 3.1 UIもAIも同じAPIを叩く

AIは特別な裏口からDBを直接読まない。UIと同じ業務APIを、同じ権限・同じ監査ログの下で呼ぶ。

```txt
画面UI → API → 業務ロジック → Storage
AI     → API → 業務ロジック → Storage
LINE   → API → 業務ロジック → Storage
音声   → API → 業務ロジック → Storage
```

### 3.2 AIに判断させすぎない

保険営業コンプラでは、LLMを最終判定者にしない。

- NG表現、必須説明、会社別ルールはルールエンジンで判定する
- LLMは要約、言い換え、説明、レビュー補助に使う
- 管理者の承認・差戻しを最終判断として記録する

### 3.3 不変条件はAPI側に置く

以下はフロントやLLMプロンプトではなく、API側の業務ロジックで保証する。

- 権限チェック
- 会社・テナント分離
- コンプラルール適用
- 監査ログ
- PIIマスキング
- APIキー非露出
- レビュー状態遷移

## 4. 中核ドメインモデル

MVP の中核は以下に絞る。

| モデル | 役割 |
|---|---|
| `Call` | 商談・面談・訪問記録の親 |
| `TranscriptSegment` | 発話単位の文字起こし |
| `ComplianceRule` | 会社別・商品別の禁止/注意/必須説明ルール |
| `ComplianceFinding` | ルールに引っかかった検知結果 |
| `MeetingMinutes` | 議事録、要約、顧客課題、次アクション |
| `ReviewTask` | 上長レビュー、差戻し、教育タスク |
| `AuditLog` | 操作・判定・承認の証跡 |
| `PresentationBlock` | UI/AI共通で返す安全な表示JSON |

## 5. コアAPI設計

最初から REST の完全実装にこだわらず、内部 service / IPC / 将来の HTTP API が同じ責務を持つように切る。

```txt
POST /calls
営業記録を作成

POST /calls/{id}/audio
音声ファイルを紐付ける

POST /calls/{id}/transcribe
音声を文字起こしする

POST /calls/{id}/analyze
コンプライアンス判定を実行する

POST /calls/{id}/minutes
議事録を生成する

POST /calls/{id}/review
管理者レビューを作成・更新する

POST /rulesets
会社ごとのコンプラルールを登録する

POST /present
UI/AI向けの表示JSONを返す
```

## 6. AIが使えるツール

AIチャットはDBを直接触らない。以下のような tool を通じて業務APIを呼ぶ。

```ts
tools: [
  searchCustomer,
  getCallTranscript,
  analyzeComplianceRisk,
  generateMinutes,
  suggestSaferTalk,
  createManagerReviewTask,
  presentComplianceReport,
]
```

各 tool は以下を必ず通す。

- 認証・認可
- tenant / company scope
- zod schema validation
- 監査ログ
- PIIマスキング
- rate limit / cost guard

## 7. Presentation JSON DSL

AIやAPIがReactを生成しない。安全な JSON DSL を返し、UIが描画する。

MVP では最小限の block に絞る。

```json
{
  "type": "compliance_report",
  "title": "面談コンプライアンス判定",
  "riskLevel": "high",
  "summary": "元本保証に近い表現が2箇所検出されました。",
  "sections": [
    {
      "type": "risk_item",
      "label": "断定表現",
      "quote": "絶対に損しません",
      "severity": "critical",
      "suggestion": "将来の運用成果は保証できない旨を明示してください。"
    },
    {
      "type": "action_list",
      "items": ["上長レビューに回す", "顧客向け説明補足を作成する"]
    }
  ]
}
```

MVP block:

- `summary_card`
- `risk_item`
- `transcript_quote`
- `action_list`
- `review_decision`
- `metric_card`
- `table`

## 8. 技術要件

### 8.1 Frontend

| 領域 | 方針 |
|---|---|
| Mac | 既存 Electron / React を継続 |
| 管理画面 | まず Electron Control に実装。SaaS化時に Next.js へ分離可能にする |
| Mobile | 最初は upload UI / PWA 寄り。録音専用は Expo / React Native を検討 |
| Presentation | `PresentationBlock` を React renderer で安全に描画 |

### 8.2 Backend

MVP は local-first。クラウド化は Cloudflare を第一候補にする。

| フェーズ | Backend | 目的 |
|---|---|---|
| Local MVP | Electron Main services | keyなし・低コストで検証 |
| Cloud β | Cloudflare Workers | API公開、スマホ/管理画面接続 |
| Enterprise | AWS adapter | 大手・閉域・個別セキュリティ要件 |

### 8.3 Storage

Supabase 前提は外す。Repository interface を先に切る。

| データ | Local MVP | Cloudflare β | Enterprise |
|---|---|---|---|
| call metadata | local JSON / SQLite | D1 | Aurora PostgreSQL / DynamoDB |
| transcript | local JSON / SQLite | D1 | Aurora PostgreSQL |
| ruleset | local JSON / SQLite | D1 | Aurora PostgreSQL |
| minutes | local JSON / SQLite | D1 | Aurora PostgreSQL |
| audio file | local file | R2 | S3 |
| pdf/export | local file | R2 | S3 |
| audit log | local JSONL | D1 / R2 archive | CloudWatch / S3 / OpenSearch |

### 8.4 AI / STT

| 用途 | 第一候補 | 備考 |
|---|---|---|
| STT | Deepgram | 現行実装と相性が良い |
| 議事録・要約 | Anthropic | ガードレール通過後にUI表示 |
| structured output / tool use | Anthropic or OpenAI | API tool 呼び出し設計に合わせる |
| embedding | Cohere | ナレッジ検索が必要になった段階 |

### 8.5 Security / Compliance

必須要件:

- APIキーは main process / backend のみ保持
- Renderer / mobile に secret を渡さない
- 音声・transcript・議事録は tenant / company scope で分離
- ルール適用結果とレビュー操作は audit log に記録
- LLM送信前にPIIマスキング
- LLM出力は guardrail 通過前にUI表示しない
- 「法的判定」ではなく「要確認リスク」として表示する

## 9. Cloudflare 採用方針

Cloudflare はセルログの β 版に向いている。

| Cloudflare | 用途 |
|---|---|
| Workers | 業務API |
| D1 | calls / transcripts / rules / findings / minutes / review tasks |
| R2 | audio / pdf / export / archive |
| Queues | STT / minutes / compliance report の非同期処理 |
| KV | feature flag / 軽い設定 / cache |
| Access | 管理画面・社内ツール保護 |
| Turnstile | 公開フォーム・招待導線のbot対策 |

ただし、Cloudflare 固定にはしない。`local` / `cloudflare` / `aws` adapter を差し替え可能にする。

## 10. 実装フェーズ

### Phase 0: 構想・要件・境界整理

目的: いきなり実装せず、AI-Native業務APIとしての境界を固定する。

タスク:

- このドキュメントを基準にする
- `docs/two-track-development-plan.md` をセルログ前提に更新
- Supabase 必須記述を Cloudflare / local-first 方針へ修正
- `Call` / `ReviewTask` / `AuditLog` / `PresentationBlock` の型方針を決める
- Repository interface の境界を決める

完了条件:

- 実装順が明確
- Cloudflare へ移行できる抽象化方針が明確
- Mac / mobile / AI chat が同じAPIを使う方針が文書化されている

### Phase 1: Local セルログ MVP

目的: keyなしでも保険営業コンプラの価値を見せる。

タスク:

- `Call` / `MeetingSession` を統合整理
- local `CallRepository`
- local `ComplianceRepository`
- local `MinutesRepository`
- local `ReviewTaskRepository`
- `PresentationBlock` 型
- コンプラレポート表示
- 管理者レビュー画面

完了条件:

- 手動 transcript / dev transcript からコンプラ議事録が出る
- 要レビュー案件一覧が見える
- 承認 / 差戻し / 要教育 の状態管理ができる

### Phase 2: Audio Upload MVP

目的: スマホアプリ前に、実録音データで価値検証する。

タスク:

- audio upload/import UI
- audio metadata
- STT job abstraction
- transcript 保存
- compliance analyze job
- minutes generation job
- report export

完了条件:

- iPhoneボイスメモ等の音声を取り込み、コンプラレポートまで生成できる

### Phase 3: Cloudflare β

目的: 複数端末・スマホ・管理画面を接続する。

タスク:

- Workers API skeleton
- D1 schema
- R2 audio upload
- Queues worker
- tenant / company scope
- audit log
- local adapter と cloudflare adapter の切替

完了条件:

- Mac / mobile / admin が Cloudflare API 経由で同じ call を扱える

### Phase 4: AI Operator

目的: AIチャットが業務APIを安全に操作できる状態にする。

タスク:

- tool schema
- tool execution gateway
- permission guard
- audit log
- presentation JSON response
- AI chat UI

完了条件:

- 「今月の高リスク面談を出して」などの自然言語指示が、権限付きAPI経由で処理される

## 11. 実装タスク分解

### P0: すぐやる

1. 計画書更新
2. `PresentationBlock` shared type / zod schema
3. `ReviewTask` shared type / zod schema
4. local review task store
5. Dashboard に要レビュー一覧
6. 議事録の compliance finding から review task を作る
7. E2E: NG発話 → 議事録 → 要レビュー表示

### P1: 次にやる

1. `CallRepository` interface
2. `MinutesRepository` interface
3. `ComplianceRepository` interface
4. local adapter へ整理
5. Supabase 直接依存を optional / legacy 扱いにする
6. upload transcript / audio import の入口
7. STT job abstraction

### P2: β化

1. Cloudflare Workers API
2. D1 migrations
3. R2 upload signed URL
4. Queue job worker
5. tenant / company / user role model
6. audit logs
7. admin web app 分離

## 12. やらないこと

初期段階ではやらない。

- 汎用AIアプリ基盤
- 全ステップシリーズ共通基盤
- AWS本番構成
- 完璧なスマホアプリ
- LLMだけでのコンプラ最終判定
- 複雑な権限管理
- 大量分析BI

## 13. ユーザー側で必要な準備

開発以外で必要。

- 保険募集ルールの実例
- 禁止表現 / 注意表現 / 必須説明のサンプル
- 録音同意の文言案
- 実録音または疑似録音サンプル
- 保険代理店の管理者ヒアリング
- Deepgram / Anthropic key
- Cloudflare アカウントと Workers / D1 / R2 利用方針

## 14. 現時点の判断

セルログを中核にする。
Mac商談支援は残すが、主戦場は `スマホ録音 + コンプラ議事録 + 管理者レビュー + 監査ログ` に置く。

実装は、AI-Native共通基盤からではなく、セルログ専用の業務APIから始める。
