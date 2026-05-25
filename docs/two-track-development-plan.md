# SalesTalk 2軸開発計画

作成日: 2026-05-25  
目的: 既存の Mac 商談支援に加えて、保険営業向けのスマホ録音 + コンプラ議事録を同じ基盤で進める。

## 1. 方針

2つの入口を持つが、処理基盤は分けない。

| 軸 | 入口 | 主な利用シーン | 提供価値 | 優先顧客 |
|---|---|---|---|---|
| Track A | Mac 商談支援 | Zoom / オンライン商談 | リアルタイム反論対応、商談品質向上 | 複雑商材BtoB営業 |
| Track B | スマホ録音 + コンプラ議事録 | 訪問 / 対面の保険営業 | 募集品質管理、NG発話検知、上長レビュー効率化 | 保険代理店、保険会社、募集管理部門 |

共通の中核は `Meeting Intelligence Platform` として扱う。

```mermaid
flowchart LR
  A["Track A: Mac / Zoom audio"] --> C["Transcript Pipeline"]
  B["Track B: Mobile / Uploaded audio"] --> C
  C --> D["Rule & Knowledge Engine"]
  D --> E["Realtime Assist"]
  D --> F["Compliance Review"]
  F --> G["Minutes / Tasks / Audit Trail"]
  G --> H["Manager Review"]
```

## 2. プロダクト定義

### Track A: Mac 商談支援

現行 SalesTalk の継続線。

- Zoom 音声を取得
- Deepgram でリアルタイム文字起こし
- 反論検知
- Overlay で切り返し候補を表示
- 商談後に議事録、タスク、ナレッジ化

### Track B: 保険営業コンプラ支援

訪問営業に合わせた新しい入口。

- スマホで録音開始
- 録音ファイルをアップロード
- transcript 化
- 会社別・商品別ルールに照合
- NG / 要注意 / 必須説明不足を検知
- 議事録にコンプラレビューを追加
- 上長が確認、差し戻し、教育に使う

最初から商談中リアルタイム警告を狙わない。訪問商談ではスマホ画面を見続ける UX が弱いため、MVP は商談後レビューを主軸にする。

## 3. 共通アーキテクチャ

### 3.1 Meeting Source

すべての入力を `MeetingSource` として扱う。

| source | 内容 | 優先度 |
|---|---|---|
| `zoom_desktop` | Mac アプリの Zoom 音声 | 既存継続 |
| `mobile_recording` | スマホ録音 | Track B MVP |
| `uploaded_audio` | 音声ファイル手動投入 | mobile 前の検証入口 |
| `manual_transcript` | transcript 手動投入 | 開発・デモ用 |

### 3.2 共通データモデル

追加・整理する主要概念。

- `meeting_sessions`
  - `id`
  - `source`
  - `industry`
  - `company_id`
  - `product_id`
  - `started_at`
  - `ended_at`
- `transcript_segments`
  - `meeting_id`
  - `speaker`
  - `text`
  - `start_ms`
  - `end_ms`
  - `confidence`
- `compliance_rules`
  - `company_id`
  - `industry`
  - `product_category`
  - `severity`
  - `rule_type`
  - `pattern`
  - `reason`
  - `recommended_phrase`
- `compliance_findings`
  - `meeting_id`
  - `rule_id`
  - `transcript_segment_id`
  - `severity`
  - `quoted_text`
  - `reason`
  - `recommended_action`
  - `review_status`
- `meeting_minutes`
- `tasks`
- `manager_reviews`

### 3.3 ルールエンジン

MVP はルールベースを主軸にする。LLM は補助判定。

| 判定方法 | 用途 | MVP採用 |
|---|---|---|
| 禁止語・正規表現 | 明確なNG発話 | 採用 |
| 必須説明チェック | 説明漏れ検知 | 採用 |
| 商品別ルール | 会社・商品ごとの差分 | 採用 |
| LLM分類 | 文脈依存の曖昧判定 | 補助 |
| 管理者レビュー学習 | 誤検知改善 | Phase 2 |

## 4. 保険営業向けユースケース

### 4.1 現場営業

1. スマホで録音開始
2. 顧客同意のチェックを記録
3. 商談終了
4. 自動で文字起こし
5. コンプラリスクと議事録が生成される
6. 必要なら上長確認に回る

### 4.2 上長・募集管理部門

1. 要確認商談だけを見る
2. リスク発話と該当ルールを確認
3. 問題なし / 要修正 / 要教育 / 重大リスクで分類
4. 営業マンへフィードバック
5. 月次で傾向を見る

### 4.3 営業教育

1. よくあるNG表現を集計
2. 言い換え例を提示
3. 新人の商談を重点レビュー
4. 会社ルールを現場会話に落とし込む

## 5. MVP スコープ

### MVP 1: 共通基盤の整理

目的: Mac / mobile / upload を同じ transcript pipeline に乗せる。

- `MeetingSource` 型を追加
- transcript segment の共通保存
- local / Supabase 両対応の repository 境界
- 議事録生成を source 非依存にする
- compliance finding の型とスキーマを追加

完了条件:

- dev transcript 注入、Mac audio、upload transcript が同じ downstream に流れる
- E2E で source 違いを確認できる

### MVP 2: 保険コンプラルールエンジン

目的: key なしでも会社別ルールで発話を検知できる。

- ルール CRUD
- 禁止表現検知
- 要注意表現検知
- 必須説明チェック
- finding を議事録に出す
- severity: `critical` / `high` / `medium` / `low`

完了条件:

- 「絶対儲かります」「告知しなくて大丈夫」などを検知
- 議事録にコンプラレビュー欄が出る
- 管理者レビュー用の一覧が見られる

### MVP 3: 音声ファイルアップロード

目的: スマホアプリ前に、訪問商談の検証を始める。

- `.m4a` / `.mp3` / `.wav` import
- Deepgram batch / streaming どちらでも処理できる抽象化
- transcript を meeting session に紐付け
- コンプラ議事録生成

完了条件:

- iPhone ボイスメモ等で録った音声を取り込める
- 保険コンプラレポートが生成される

### MVP 4: Mobile Recorder

目的: 訪問営業で録音開始からアップロードまで完結する。

- iOS 優先
- 録音開始 / 停止
- 顧客同意チェック
- 録音メタデータ入力
- アップロード
- 処理状況表示

完了条件:

- 営業マンが訪問先で録音し、管理画面に議事録とコンプラ結果が出る

## 6. 開発ロードマップ

### Phase 0: 現状維持と土台整理

期間目安: 1週

- 既存 Mac app の keyless E2E 維持
- `MeetingSource` 設計
- compliance finding schema
- local repository の整理
- README / PRD の2軸化

### Phase 1: 保険コンプラMVP

期間目安: 2週

- 保険向け rule engine
- 会社別ルール登録
- transcript へのルール照合
- 議事録への compliance review 追加
- 管理者レビュー UI の最小版

### Phase 2: Upload Audio MVP

期間目安: 1〜2週

- 音声ファイル import
- STT ジョブ化
- transcript 保存
- compliance report 生成
- CSV / PDF export の検討

### Phase 3: Mobile Recorder MVP

期間目安: 3〜4週

- iOS 録音アプリ
- 認証または簡易テナントコード
- 音声アップロード
- 処理ステータス
- 同意取得チェック

### Phase 4: Mac リアルタイム高度化

期間目安: 並行継続

- 実 Zoom audio smoke
- Deepgram 実 key 疎通
- Anthropic 本番回答生成
- Cohere / Supabase RAG
- Overlay UX 改善

## 7. 実装優先順位

次に手を動かす順番。

1. `MeetingSource` / `MeetingSession` 型追加
2. `ComplianceRule` / `ComplianceFinding` 型追加
3. local compliance rule store
4. rule engine
5. 議事録への compliance review 欄
6. 管理者レビュー UI
7. 音声ファイル import UI
8. STT job abstraction
9. iOS recorder PoC
10. Supabase 永続化

## 8. あなたがやる必要がある作業

開発以外で必須。

- 保険会社・代理店の具体ルール例を入手
- 会社別に「禁止」「注意」「必須説明」のサンプルを10〜30件作る
- 録音同意の運用方針を決める
- 保険募集コンプラに詳しい人へ初期レビュー依頼
- Deepgram / Anthropic / Cohere / Supabase key 発行
- iOS 配布するなら Apple Developer Program
- 実際の訪問商談録音サンプルを用意

## 9. リスクと対策

| リスク | 内容 | 対策 |
|---|---|---|
| 録音同意 | 無断録音への懸念 | 録音前チェック、同意文言、ログ保存 |
| 営業マンの反発 | 監視ツールに見える | 「営業マンを守る」訴求、教育用途を前面に |
| 誤検知 | 文脈を見ずにNG扱い | severity分け、上長レビュー、LLM補助 |
| 会社別ルール差分 | ルールが会社ごとに違う | company_id / product_category で分離 |
| 法務責任 | 判定が法的助言に見える | 「要確認」扱い、最終判断は管理者 |
| スマホ録音UX | 訪問中に操作が増える | 録音開始/停止だけに絞る |

## 10. 成功指標

### Track A

- 商談中の提案採用率
- 反論検知 precision
- 回答生成 latency
- 商談後議事録の修正時間

### Track B

- 要確認商談の抽出率
- 上長レビュー時間の削減
- 重大リスク発話の検知件数
- 営業マンへの差し戻し件数
- 新人教育での改善率

## 11. 現時点の結論

2軸で進める。ただし実装は2プロダクトに分裂させない。

- Mac はリアルタイム商談支援の入口
- スマホは訪問録音とコンプラ議事録の入口
- transcript / rule engine / minutes / tasks / review は共通

直近の開発は、保険向け `ComplianceRule` と `ComplianceFinding` を共通基盤に追加するところから始める。
