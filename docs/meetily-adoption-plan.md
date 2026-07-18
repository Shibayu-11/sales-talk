# Meetily 採用計画

作成日: 2026-07-15
最終更新: 2026-07-18
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

状態: **2026-07-18 最小安全実装完了**

- Main が受ける PCM `AudioChunk` を 5 秒または 1MiB 単位で AES-256-GCM checkpoint へ保存
- セッション鍵は Electron `safeStorage` で wrap し、manifest / Renderer / log へ平文 PCM・鍵・音声 base64 を出さない
- segment / manifest は tmp → fsync → rename で atomic 確定し、manifest 全体を HMAC 認証
- 正常終了時は native 停止 → checkpoint drain → speaker 別 WAV / AES-256-GCM encrypted audio asset 登録 → call 終了 → audit の順で確定し、全成功後だけ checkpoint を削除
- 異常終了後は `recording` manifest を `recoverable` として検知
- checkpoint は作成者 user / membership owner に紐づけ、agent は自分の未完了録音のみ復旧・破棄・保持期限変更可能
- manager / admin は組織 checkpoint を管理でき、auditor は組織 checkpoint を閲覧のみ可能
- Dashboard から復旧、破棄、保持期限 1 / 7 / 30 日を選択可能
- 復旧時は暗号化 segment を逐次検証・復号し、self / counterpart 別 mono WAV をストリーミング生成してローカル audio asset へ登録
- 復旧 WAV は一時領域だけに materialize し、確定後のローカル audio asset は AES-256-GCM encrypted at rest とする
- 1 call / 1 speaker / 全 checkpoint の容量上限、bounded backpressure、symlink guard を設け、長時間復旧時の Main process OOM とパス逸脱を防止
- 期限切れ checkpoint はユーザー操作に依存しない autonomous maintenance が全 checkpoint organization を巡回し、system-scoped audit 成功後だけ削除
- checkpoint degraded / finalized / recovered / discarded / expired / retention updated を audit log に記録
- retention 変更は pending-audit outbox に認証保存し、audit 失敗時は pending を残して次回 maintenance で idempotent replay する
- audit 失敗時は checkpoint 破棄などの破壊操作を確定しない

音声原本は local-first を維持し、Cloud へ自動送信しない。

### Phase 3: 再文字起こし

- [x] 既存 STT job に工程目安、Abortキャンセル、再実行理由、stale-running復旧を追加
- [x] SpeechAnalyzer / Deepgram の provider 固定比較再処理
- [x] transcript revision を保持し、legacy原本を明示revisionへ移行して上書きしない
- [x] CAS run token で二重実行・cancel/complete競合を防止
- [x] revision別にコンプラ判定・議事録・レビューを保存し、旧版復帰時も整合させる
- [x] 会社・テナント境界、ユーザー操作監査、Call Libraryの切替E2Eを追加

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
3. 実 Zoom 中断ケースで checkpoint 復旧の WAV 登録と議事録再生成の運用手順を確認
4. 実音声で SpeechAnalyzer / Deepgram の同一音源比較と revision 切替を確認
5. 長時間録音で checkpoint サイズ、復旧時間、保持期限 UI の実測値を記録

この順序により、新機能を増やす前に「実商談で動かないとき、何が悪いか分かる」状態を作る。
