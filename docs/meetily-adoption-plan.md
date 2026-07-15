# Meetily 採用計画

作成日: 2026-07-15
対象: [Zackriya-Solutions/meetily](https://github.com/Zackriya-Solutions/meetily)
参照時点: `0281737d87d26352fb0adc78c8c0975f691b23d1`

## 0. 結論

Meetily は SalesTalk の置き換え先ではなく、ローカル会議基盤を強化するための OSS リファレンスとして採用する。

- Electron + Swift + Apple SpeechAnalyzer の現行構成を維持する
- Tauri / Rust への全面移行は行わない
- Meetily の実装をそのままコピーせず、安定している設計を既存境界へ移植する
- SalesTalk の差別化は、リアルタイム支援、会社別コンプラルール、議事録、管理者レビュー、監査証跡に置く
- 音声を外部 STT に送らない `local_first` を第一方針として維持する

Meetily は汎用会議アシスタントの基盤、SalesTalk は営業・保険募集業務を安全に実行する業務システムという位置付けにする。

## 1. 現在地

SalesTalk は既に以下を実装済み。

- ScreenCaptureKit + AVAudioEngine による system / microphone 音声取得
- Apple SpeechAnalyzer によるローカル文字起こし
- self / counterpart のチャンネル分離
- Deepgram fallback
- リアルタイム反論検知と切り返し Overlay
- 音声 import、再処理用 STT job、議事録生成
- 会社別・商品別コンプラルール、レビュー、監査ログ
- 音声診断 UI の権限、native module、STT、chunk 数表示

最大の未解決リスクは、実 Zoom 商談での長時間安定性と、問題発生時に利用者自身が原因を判断できる診断能力である。

## 2. 採用マトリクス

| Meetily の要素 | 判断 | SalesTalk での使い方 | 優先度 |
|---|---|---|---|
| 音声デバイス診断 | 採用 | 商談開始前の Go / Warning / Blocked 判定と復旧案 | P0 |
| chunk checkpoint / crash recovery | 採用 | 長時間商談の音声・transcript 復旧 | P1 |
| import / retranscription job | 拡張採用 | provider 切替、進捗、キャンセル、再解析 | P1 |
| Whisper / Parakeet local STT | 条件付き | SpeechAnalyzer 非対応環境の将来 fallback | P2 |
| JSON 議事録テンプレート | 採用 | 会社・商品・監査用途別の議事録形式 | P2 |
| Tauri / Rust アプリシェル | 不採用 | 現行 Electron 資産を維持 | 対象外 |
| `audio_v2` の未完了実装 | 不採用 | TODO / placeholder を本番コードへ持ち込まない | 対象外 |
| SQLite スキーマ一式 | 不採用 | 既存 Repository / tenant / audit モデルを維持 | 対象外 |

## 3. 実装順序

### Phase 1: 音声 preflight

状態: **2026-07-15 実装完了**

既存の `AudioCaptureStatus` を、状態表示から意思決定可能な診断へ引き上げる。

- `Go`: system / microphone の両方を受信し、STT が接続済み
- `Warning`: 相手音声未受信、STT 再接続中、chunk が一定時間停止
- `Blocked`: 権限不足、native module 不正、STT failure、開始後も microphone 未受信
- UI に原因と次アクションを日本語で表示
- 判定は Main の純関数に集約し、unit test で固定
- fake native audio + fake SpeechAnalyzer の E2E で `Go` まで確認

実装結果:

- 権限、native module、native capture、STT、self / counterpart、音声鮮度を個別判定
- native capture と STT の部分起動時は両方を停止し、録音を残さない
- 監査ログを記録できない場合は録音を開始せず、作成済み call も終了状態へ戻す
- 本通話と standalone 診断の所有権を分離し、診断停止から本通話を停止できないようにした
- start / end を直列化し、開始中の終了操作でも無音の通話状態を残さない
- IPC 入出力を zod schema と shared type で固定
- unit 266 件、E2E 7 件、Electron / Mobile / Cloudflare build、native addon build を通過

Phase 1 は疎通診断であり、音質や文字起こし精度を保証するものではない。

### Phase 2: 長時間商談の復旧性

- 暗号化された短時間 checkpoint を定期保存
- 正常終了時に最終音声へ統合
- 異常終了後に未完了セッションを検知
- 復旧、破棄、保持期限を利用者が選択
- 復旧操作と結果を audit log に記録

音声原本は local-first を維持し、Cloud へ自動送信しない。

### Phase 3: 再文字起こし

- 既存 STT job に進捗、キャンセル、再実行理由を追加
- SpeechAnalyzer / Deepgram の比較再処理
- transcript revision を保持し、監査上の原本を上書きしない
- 再処理後にコンプラ判定と議事録を再生成

### Phase 4: ローカル fallback とテンプレート

- Whisper / Parakeet は sidecar provider として評価し、主経路に混ぜない
- 速度、日本語精度、配布サイズ、モデルライセンスを実測して採否判断
- 会社・商品別の議事録テンプレートを JSON で管理
- テンプレートの変更履歴と承認状態を監査可能にする

## 4. ライセンス方針

Meetily 本体は参照時点で MIT License。商用利用、改変、再配布は可能だが、コードまたは substantial portion を取り込む場合は著作権表示と許諾文を保持する。

実装時は次を必須とする。

1. コピーではなく設計参考だけか、コード取り込みかを PR 単位で記録する
2. コード取り込み時は `THIRD_PARTY_NOTICES.md` に対象ファイル、commit、著作権表示を追加する
3. Whisper / Parakeet のモデル weight はリポジトリ本体と別にライセンス確認する
4. FFmpeg、ONNX Runtime、submodule、git dependency を個別監査する
5. GPL / AGPL / SSPL 系の混入は既存 `npm run license:audit` 方針に従って拒否する

## 5. 受入基準

- 現行の Apple SpeechAnalyzer local-first 経路を変更しない
- Renderer に API key や生のネイティブ情報を無制限に公開しない
- 音声・transcript を診断ログへ出力しない
- 既存の録音同意、tenant、audit、guardrail を迂回しない
- unit / E2E / Electron build / mobile build / Cloudflare typecheck を維持する
- 実 Zoom E2E で 30 分通話を完走し、診断結果と実測値を記録する

## 6. 現在の次タスク

1. 実 Zoom E2E で商談前チェックの Go / Warning / Blocked と復旧案を実測
2. 30 分商談で片側停止、Zoom 再起動、権限剥奪時の挙動を記録
3. Phase 2 の暗号化 checkpoint / crash recovery の保存単位と復旧契約を確定
4. 未完了セッションの検知、復旧、破棄、保持期限 UI を実装
5. checkpoint と復旧操作を audit log に追加

この順序により、新機能を増やす前に「実商談で動かないとき、何が悪いか分かる」状態を作る。
