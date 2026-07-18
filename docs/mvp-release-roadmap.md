# SalesTalk MVP リリースロードマップ(Kanary 超え版)

作成日: 2026-06-12
目的: Mac 商談支援(Track A)を実商談で使える品質に仕上げ、β配布まで到達する週次実行計画。
戦略の上位文書は [2軸開発計画](./two-track-development-plan.md)。本書はその Phase 5(Mac リアルタイム高度化)〜配布を実行レベルに分解したもの。

## 0. 現在地(2026-07-18 実態調査)

Mac アプリのコード側はMVP機能をほぼ実装済み。残る最大の不確実性は、実Zoomでの品質検証(M1)と署名・公証を含むβ配布(M5)。

| 領域 | 状態 |
|---|---|
| Swift 音声キャプチャ(ScreenCaptureKit + AVAudioEngine + NAPI) | 完成・ビルド済み |
| STT(Apple SpeechAnalyzer local realtime + batch/file + Deepgram fallback) | 完成。self/counterpart別helper + 自動E2E済み、実Zoom品質は未確認 |
| 反論検知パイプライン(XState / Haiku 検知 / Sonnet 投機生成 + レイテンシ計測) | 完成 |
| 法務ガードレール(3商材 risk_flags + 安全フォールバック) | 完成 |
| Electron Main(IPC / サービス層) | 完成 |
| Renderer(Overlay + Kanary 流三分割 Call Library) | 完成 |
| 議事録(LLM 生成 + [mm:ss] ジャンプリンク + ヒューリスティック縮退) | 完成 |
| 再文字起こし(CAS job / Abort / provider切替 / revision履歴 / 議事録・レビュー再解析) | 完成。原本復帰・組織分離・画面E2E済み |
| ナレッジ / RAG(ハイブリッド検索 + 3商材37件シード + 応答接地) | 完成(クラウド側は β へ) |
| salestalk CLI(record/transcribe/minutes、JSON 出力) | 完成 |
| Shortcuts / Spotlight 連携(salestalk:// URL スキーム) | 完成(実機での状態共有は要検証) |
| 提案カードのナレッジ出典表示(根拠ナレッジ N件 + 関連度%) | 完成 |
| テスト(unit 353 + E2E 8) | 全グリーン |
| 商談前音声 preflight | 完成。Go / Warning / Blocked、原因、復旧案、部分起動cleanup、型付きIPCを自動検証済み |
| 実 Zoom 商談での通し検証 | **未実施(最大リスク)** |
| W5: オンボーディング + electron-updater | 完成、unit / E2E済み。実配布環境での更新確認は未実施 |
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
| 話者分離(自分 / 相手) | あり(チャンネル分離) | あり(system/mic別helper、自動E2E済み) |
| 商談後の議事録自動要約(決定事項・宿題・懸念) | あり | あり(LLM + ヒューリスティック縮退、ワンクリック導線) |
| 音声ファイル取込 → 文字起こし | あり | あり(local STT batch + fallback) |
| ライブ字幕 | あり | あり(話者別 transcript + 商談支援 pipeline) |
| オフライン翻訳 | あり | 未実装。保険営業コンプラMVPの対象外 |
| 再処理・履歴切替 | 要約再生成あり | あり。原本を保持したまま provider 比較、旧版復帰、revision別議事録・レビュー |
| CLI / Agent Skill 連携 | あり(v2.1) | あり(JSON出力CLI) |
| Spotlight / Shortcuts 起動 | あり(v2.1.4) | あり(`salestalk://` URL scheme) |
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
- [x] fake native audio + fake SpeechAnalyzer helper でself/counterpartの2チャネル自動E2E
- [x] 商談前音声 preflight(権限 / native / STT / 2音源 / stale)と Go / Warning / Blocked UI
- [x] native/STT部分起動、監査ログ失敗、start/end競合時に録音を残さないcleanup
- [x] 録音 crash recovery 最小実装(AES-256-GCM checkpoint / finalized asset、safeStorage key wrap、owner-scoped 復旧、pending-audit replay、autonomous audited cleanup、bounded backpressure / symlink guard)
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

- [x] 自動検証で発見したlocal STT話者混同を2helper構成で修正
- [x] 反論検知の precision 回帰基盤(ラベル付きコーパス + 評価ハーネス)
- [x] Overlay UX 改善(L1 loading、risk badge、レイヤー遷移安定化)
- [ ] 相槌・短文の検知抑制と連投抑制の実機チューニング
- [ ] Deepgram fallback の実機切替確認(SpeechAnalyzer 不可環境の擬似テスト)

完了条件: 模擬商談で「提案が出るのが早い・邪魔にならない」と本人が判断できる品質。

### Week 3(6/26〜7/2): Kanary 同等機能の完成

目的: Kanary ができることを全部できるようにする。UI は [Kanary UI リファレンス](./kanary-ui-reference.md) に従う。

- [x] Calls タブを三分割レイアウトへ再構成(経過時間グルーピング / 左右チャットバブル / Summary パネル)
- [x] 商談後の議事録ワンクリック生成(LLM 生成 + ヒューリスティック縮退、[mm:ss] タイムスタンプリンクで該当発話・コンプラ findings へジャンプ)
- [x] Apple SpeechAnalyzer batch/import provider 本接続(Swift file-mode + TS batch provider、実機ビルド検証済み)
- [x] 音声 import の既定 provider を local-first に変更(import-stt-provider-resolver)
- [x] 再文字起こし lifecycle(CAS二重実行防止、provider Abort、キャンセル競合防止、再実行理由、工程目安)
- [x] transcript revision(legacy原本移行、原本↔再処理版切替、revision別議事録・レビュー、組織分離、監査ログ、画面E2E)
- [x] `salestalk` CLI(record start/stop・transcribe・minutes、JSON 出力で Agent Skill 連携可)— [使い方](./cli.md)
- [x] macOS Shortcuts / Spotlight 連携(`salestalk://record/start?product=X` / `salestalk://record/stop` URL スキーム + `--cli` argv ルーティング)
- [ ] 実機: import 音声を local SpeechAnalyzer batch だけで議事録まで通す検証
- [x] URL スキーム経路と GUI 経路の状態共有(`startRecordingSession`/`stopRecordingSession` に一本化。protocol も GUI も同一シングルトンセッションを駆動、二重起動は `already_recording` で抑止)
  - [ ] 実機: 実際に Shortcut → 録音 → GUI 停止が1セッションで通るか最終確認(M1)

完了条件: 「Kanary でできることは SalesTalk でもできる」と言い切れる。upload 音声を local STT だけで処理できる。

### Week 4(7/3〜7/9): RAG 接地 + 商材ナレッジ投入

目的: 切り返し提案の質を「汎用 LLM」から「自社ナレッジ接地」へ引き上げる。

- [x] ナレッジ検索 → Sonnet プロンプトへの接地(knowledge_entries を一次情報源として優先、score passthrough)
- [x] 3商材のナレッジ初期投入(real_estate 13 / kenko_keiei 12 / hojokin 12 = 計37件、seedLocalKnowledge)
- [x] RAG の保存先確定(MVP は local-first 維持、Cloudflare 接続は β フェーズへ)
- [x] 提案カードにナレッジ出典表示(overlay に「根拠ナレッジ N件」+ 関連度% 、`ObjectionResponse.sources` 経由)
- [x] プロンプト強化: 検知 few-shot 例 + confidence 基準、商材別 proactive ガードレール(補助金=最高リスク)、ナレッジ捏造禁止、議事録の創作禁止(prompts.test.ts)
- [ ] ガードレールの実発話テスト(禁止キーワード発話 → 差し替え/トーンダウン確認)※実機検証で
- [ ] 実商談想定の反論 10 パターンで接地提案を確認(実機 / プロンプト評価)

完了条件: 実商談を想定した反論 10 パターンで、ナレッジ接地した提案が出る。

### Week 5(7/10〜7/16): 配布準備 + β リリース

目的: 自分以外の Mac でも動く状態にして配布する。

- [x] 初回起動オンボーディング(権限誘導 → Anthropic キー → 商材選択。`onboardingCompletedAt` で制御、E2E あり)
- [x] electron-updater 実装(商談中は install 遅延 → 15 分後リトライ、通話終了で即時。`UpdateManager` + 6 テスト)
- [x] 配布設定を Apple Silicon (arm64) 専用に確定(universal は壊れた Intel スライスを生むため。Kanary も Apple Silicon 限定)→ [release-build.md](./release-build.md)
- [x] 署名・公証なしで packaging 構成を検証(.app arch / ネイティブ binary 同梱 / Info.plist / ランタイムパス整合)
- [ ] DMG ビルド + Apple Notarize の本番通し(Apple Developer アカウント必須)※実機
- [ ] electron-updater 実機動作確認(実際の GitHub Release で更新が降ってくるか)※実機
- [ ] クリーン環境(別 Mac or 新規ユーザー)でのインストール検証 ※実機
- [ ] 自社営業メンバーへの β 配布と初回フィードバック収集

完了条件: クリーンな Mac に DMG を入れて、初商談で使えるまでを本人以外が完走できる。

### Week 6 以降(並行・順次)

2軸計画 Phase 3〜4 に接続。

- 実商談での継続利用とフィードバックループ(提案採用率の記録)
- Cloudflare β(D1 / R2 / Queues、adapter 切替)— **アカウントライフサイクル + Email Service 送信受付まで実装済み**。残りは実Cloudflare環境で migration → deploy → Email Sending domain onboarding/DNS → invite/reset メール配送の通し確認 → [手順](./cloudflare-beta-deploy.md)
- Mobile Recorder PoC(Track B 入口)— **PWA 版を実装済み + E2E 済み**(録音同意ゲート + MediaRecorder + 署名アップロード。fake audio device で録音フロー全体を Playwright E2E)。`npm run mobile:dev`。ネイティブ iOS(Expo)は需要が見えてから
- 管理者向け月次レポート — **実装済み**(月別のコンプラ検知集計: severity別 / 重大リスク件数 / 処理状況 / 処理済率。レビュータブ上部に表示、unit + E2E)
- 検知精度の回帰テスト基盤 — **実装済み**(ラベル付きコーパス + 評価ハーネス。M1 で実 Haiku 検出器をそのまま採点可能)

### Cloudflare β アカウントライフサイクル(2026-07-16 更新)

- [x] bootstrap 互換に加えて admin-driven 招待 / membership status / password reset flow を実装
- [x] D1 migration `0007_account_lifecycle.sql`: membership status、1 user = 1 membership UNIQUE、must-reset flag、hash-only one-time token table、audit sequence
- [x] Worker API: invite accept、reset complete、users list、invite issue、reset issue、membership active/disabled
- [x] Electron Settings: token承諾 / reset完了、SaaSユーザー一覧、招待メール送信、disable/activate、再設定メール送信
- [x] セキュリティ: 32-byte base64url token、SHA-256 hash保存、invite 72h / reset 30m、raw token/password非監査、disable時の未使用reset token消費 + must-reset解除
- [x] Cloudflare Email Service Workers binding で invite/reset token 送信受付を実装。email mode は admin API/UI に raw token を返さない
- [x] manual_beta は明示設定時だけ raw token 表示を維持。本番不可
- [x] production configをemail固定し、manual_betaを拒否するdeploy guardと旧Worker token responseの新app互換を追加。rolloutは新app → Worker → email mode
- [ ] P2: 同一membershipへの並行reset発行をサーバー側でserializeし、失効済みtokenを含むstale email受付を防ぐ。現状はElectron UI pending中の連続発行のみ抑止
- [ ] 実Cloudflare環境で migration → deploy → Email Sending domain onboarding/DNS → invite/reset email の通し確認
- [ ] `npx wrangler email sending list` が `No zones found` の状態を解消し、送信 domain を onboard する

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
