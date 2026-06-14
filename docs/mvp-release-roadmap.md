# SalesTalk MVP リリースロードマップ(Kanary 超え版)

作成日: 2026-06-12
目的: Mac 商談支援(Track A)を実商談で使える品質に仕上げ、β配布まで到達する週次実行計画。
戦略の上位文書は [2軸開発計画](./two-track-development-plan.md)。本書はその Phase 5(Mac リアルタイム高度化)〜配布を実行レベルに分解したもの。

## 0. 現在地(2026-06-12 実態調査)

Mac アプリ単体では **約90%** が実装済み(2026-06 中旬時点、Week 3/4 機能を消化)。
残る最大の不確実性は実機検証(M1)と β 配布(M5)。

| 領域 | 状態 |
|---|---|
| Swift 音声キャプチャ(ScreenCaptureKit + AVAudioEngine + NAPI) | 完成・ビルド済み |
| STT(Apple SpeechAnalyzer local realtime + batch/file + Deepgram fallback) | 完成、実機ビルド検証済み |
| 反論検知パイプライン(XState / Haiku 検知 / Sonnet 投機生成 + レイテンシ計測) | 完成 |
| 法務ガードレール(3商材 risk_flags + 安全フォールバック) | 完成 |
| Electron Main(IPC / サービス層) | 完成 |
| Renderer(Overlay + Kanary 流三分割 Call Library) | 完成 |
| 議事録(LLM 生成 + [mm:ss] ジャンプリンク + ヒューリスティック縮退) | 完成 |
| ナレッジ / RAG(ハイブリッド検索 + 3商材37件シード + 応答接地) | 完成(クラウド側は β へ) |
| salestalk CLI(record/transcribe/minutes、JSON 出力) | 完成 |
| Shortcuts / Spotlight 連携(salestalk:// URL スキーム) | 完成(実機での状態共有は要検証) |
| 提案カードのナレッジ出典表示(根拠ナレッジ N件 + 関連度%) | 完成 |
| テスト(unit 189 + E2E 4) | 全グリーン |
| 実 Zoom 商談での通し検証 | **未実施(最大リスク)** |
| W5: オンボーディング + electron-updater | **保留中(cowork で次に着手予定だった)** |
| DMG 配布・公証 | 未着手 |

## 1. 競合ベンチマーク: Kanary v2

[Kanary](https://kanary.download/)(Kenn Ejima 氏、無料 macOS アプリ)は本プロダクトと同じ土台
(システム音声キャプチャ + Apple SpeechAnalyzer ローカル STT + 自分/相手チャンネル分離)を持つ。
2026-05 末リリース、macOS 26 Tahoe + Apple Silicon 必須。

### Kanary が持つ機能(= 最低限並ぶライン)

| 機能 | Kanary | SalesTalk 現状 |
|---|---|---|
| Bot 不要のシステム音声録音 | あり | あり(ScreenCaptureKit) |
| ローカル文字起こし(SpeechAnalyzer) | あり | あり |
| 話者分離(自分 / 相手) | あり(チャンネル分離) | あり(2ストリーム) |
| 商談後の議事録自動要約(決定事項・宿題・懸念) | あり | プロンプトあり(`meeting_minutes.ja.yaml`)、ワンクリック導線が未整備 |
| 音声ファイル取込 → 文字起こし | あり | あり(ただし local STT batch 未接続) |
| CLI / Agent Skill 連携 | あり(v2.1) | なし |
| Spotlight / Shortcuts 起動 | あり(v2.1.4) | なし |
| 価格 | 無料 | — |

### Kanary が持たない機能(= 勝ち筋、既にほぼ実装済み)

- 商談**中**のリアルタイム文字起こし表示・反論検知・AI 切り返し提案(2.5 秒以内)
- 3商材特化ナレッジ RAG による回答接地
- 法務ガードレール(宅建業法 / 行政書士法 / 健康経営)+ risk_flags
- 画面共有に映らないオーバーレイ(NSWindowSharingNone)
- コンプラレビュー / 監査ログ / 上長レビュー(Track B 基盤)

### 「Kanary 超え」の定義(リリース判定基準)

1. Kanary の主要機能(録音・ローカル STT・議事録・取込)と同等以上
2. リアルタイム支援が実 Zoom 商談で安定動作(相手発話終了 → 表示 2.5 秒以内)
3. 非対応環境(macOS 26 未満 / Intel)でも Deepgram fallback で動く(Kanary は動かない)
4. CLI / Shortcuts 連携を提供(Kanary 初期ユーザーに最も刺さった機能)

## 2. 週次ロードマップ

順序は **検証 → 品質 → 機能 → 配布**。最大リスク(実機 E2E)を先頭で潰す。

### Week 1(6/12〜6/18): 実機 E2E 検証 — Go/No-Go 判定

目的: 「実際の Zoom 商談で通しで動くか」に答えを出す。

- [x] 実機検証チェックリスト作成 → [live-zoom-e2e-checklist.md](./live-zoom-e2e-checklist.md)
- [ ] Zoom テスト通話で system audio → local STT → transcript 表示を確認
- [ ] 反論を意図的に発話 → Haiku 検知 → Sonnet 生成 → Overlay 表示の通し確認
- [x] レイテンシ計測ログを pipeline に仕込む(`objection_pipeline_latency` メトリクス)
- [ ] レイテンシ実測(発話終了 → 表示。目標 2.5s)
- [ ] 画面共有中にオーバーレイが相手に映らないことを確認(三段防御)
- [ ] 発見した不具合の一覧化と優先度付け
- [x] audit log の recording metadata に `sttProvider` / `sttDegradedReason` を記録(計画書 §7-2)

完了条件: 模擬商談 30 分を通しで実行し、検知 → 表示が破綻なく動く。レイテンシ実測値が出ている。

### Week 2(6/19〜6/25): 品質修正 + リアルタイム精度

目的: Week 1 で見つかった問題を潰し、コア体験を磨く。

- [ ] Week 1 検出バグの修正
- [ ] 反論検知の precision 確認(模擬商談 transcript でプロンプト評価、誤検知・過検知の調整)
- [ ] Overlay UX 改善(表示タイミング、自動消去、クリックスルー、ホバー操作)
- [ ] 相槌・短文の検知抑制と連投抑制の実機チューニング
- [ ] Deepgram fallback の実機切替確認(SpeechAnalyzer 不可環境の擬似テスト)

完了条件: 模擬商談で「提案が出るのが早い・邪魔にならない」と本人が判断できる品質。

### Week 3(6/26〜7/2): Kanary 同等機能の完成

目的: Kanary ができることを全部できるようにする。UI は [Kanary UI リファレンス](./kanary-ui-reference.md) に従う。

- [x] Calls タブを三分割レイアウトへ再構成(経過時間グルーピング / 左右チャットバブル / Summary パネル)
- [x] 商談後の議事録ワンクリック生成(LLM 生成 + ヒューリスティック縮退、[mm:ss] タイムスタンプリンクで該当発話・コンプラ findings へジャンプ)
- [x] Apple SpeechAnalyzer batch/import provider 本接続(Swift file-mode + TS batch provider、実機ビルド検証済み)
- [x] 音声 import の既定 provider を local-first に変更(import-stt-provider-resolver)
- [x] `salestalk` CLI(record start/stop・transcribe・minutes、JSON 出力で Agent Skill 連携可)— [使い方](./cli.md)
- [x] macOS Shortcuts / Spotlight 連携(`salestalk://record/start?product=X` / `salestalk://record/stop` URL スキーム + `--cli` argv ルーティング)
- [ ] 実機: import 音声を local SpeechAnalyzer batch だけで議事録まで通す検証
- [ ] 実機: URL スキーム経路と GUI 経路の状態共有(protocol record/stop が GUI 起動セッションを停止できるか。現状は別インスタンス生成で activeCallId 等を共有しない懸念 → M1 で確認)

完了条件: 「Kanary でできることは SalesTalk でもできる」と言い切れる。upload 音声を local STT だけで処理できる。

### Week 4(7/3〜7/9): RAG 接地 + 商材ナレッジ投入

目的: 切り返し提案の質を「汎用 LLM」から「自社ナレッジ接地」へ引き上げる。

- [x] ナレッジ検索 → Sonnet プロンプトへの接地(knowledge_entries を一次情報源として優先、score passthrough)
- [x] 3商材のナレッジ初期投入(real_estate 13 / kenko_keiei 12 / hojokin 12 = 計37件、seedLocalKnowledge)
- [x] RAG の保存先確定(MVP は local-first 維持、Cloudflare 接続は β フェーズへ)
- [x] 提案カードにナレッジ出典表示(overlay に「根拠ナレッジ N件」+ 関連度% 、`ObjectionResponse.sources` 経由)
- [ ] ガードレールの実発話テスト(禁止キーワード発話 → 差し替え/トーンダウン確認)※実機検証で
- [ ] 実商談想定の反論 10 パターンで接地提案を確認(実機 / プロンプト評価)

完了条件: 実商談を想定した反論 10 パターンで、ナレッジ接地した提案が出る。

### Week 5(7/10〜7/16): 配布準備 + β リリース

目的: 自分以外の Mac でも動く状態にして配布する。

- [ ] DMG ビルド + Apple Notarize の通し確認(universal binary)
- [ ] 初回起動オンボーディング(Screen Recording / Microphone 権限誘導、API キー設定)
- [ ] electron-updater 動作確認(商談中更新禁止 → 15 分後リトライ)
- [ ] クリーン環境(別 Mac or 新規ユーザー)でのインストール検証
- [ ] 自社営業メンバーへの β 配布と初回フィードバック収集

完了条件: クリーンな Mac に DMG を入れて、初商談で使えるまでを本人以外が完走できる。

### Week 6 以降(並行・順次)

2軸計画 Phase 3〜4 に接続。

- 実商談での継続利用とフィードバックループ(提案採用率の記録)
- Cloudflare β(D1 / R2 / Queues、adapter 切替)
- Mobile Recorder PoC(iOS、Track B 入口)
- 管理者向け月次レポート強化

## 3. マイルストーン

| マイルストーン | 期限目安 | 判定基準 |
|---|---|---|
| M1: 実機 E2E Go | 6/18 | 模擬商談 30 分通し成功、レイテンシ実測 |
| M2: コア品質 OK | 6/25 | 本人が実商談に投入してよいと判断 |
| M3: Kanary 同等 | 7/2 | 議事録 / 取込 / CLI / Shortcuts が揃う |
| M4: ナレッジ接地 | 7/9 | 反論 10 パターンで接地提案 |
| M5: β 配布 | 7/16 | 他人の Mac で初商談まで完走 |

## 4. ユーザー(柴さん)側の準備タスク

- [ ] Anthropic API キー(本番用)
- [ ] 模擬商談の相手役確保(Week 1〜2 で最低 2 回)
- [ ] 3商材の反論・切り返しナレッジの素材出し(Week 4 までに各 20 件目安)
- [ ] β 配布先メンバーの選定(Week 5)
- [ ] Apple Developer Program(公証に必須、未取得なら即時)

## 5. リスクと先手

| リスク | 対策 |
|---|---|
| 実機 E2E で重大不具合 | Week 1 に最優先で実施し、Week 2 をまるごと修正に充てられる構成 |
| SpeechAnalyzer の日本語精度が商談品質に届かない | Deepgram fallback 即切替を Week 2 で検証済みにする |
| macOS 26 必須が配布の壁 | fallback 構成を「Kanary が動かない環境でも動く」訴求に転換 |
| 検知の誤発火で商談の邪魔になる | Week 2 のプロンプト評価 + 確信度しきい値チューニング |
| 公証・配布で想定外の躓き | Week 5 冒頭に通しビルドを最初に実行(機能追加より先) |
