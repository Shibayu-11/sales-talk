# Apple SpeechAnalyzer ローカルSTT移行計画

作成日: 2026-06-10
更新日: 2026-06-11
目的: SalesTalk / セルログの文字起こし基盤を、Deepgram中心から Apple SpeechAnalyzer 中心へ切り替える。

## 0. 現在地

2026-06-11 時点で、方針転換後の基礎実装は完了している。

完了済み:

- `sttProviderMode` を追加し、Mac MVP の既定を `local_first` に変更
- Dashboard / Settings に Apple SpeechAnalyzer 優先の表示と切替UIを追加
- `STTProvider` resolver を追加し、`local_first` / `deepgram_fallback` / `deepgram_only` / `manual_only` を分離
- `AppleSpeechAnalyzerSTTProvider` を追加
- `src/native/audio-capture` に Swift 製 `speech-analyzer-helper` を追加
- Speech framework の asset 準備、ready handshake、timestamp 正規化、PCM format 変換を実装
- `npm run native:audio:local-stt-smoke` を追加
- 実機で `native capture → Apple SpeechAnalyzer → transcript` を確認
- UI E2E で「診断開始 → STT connected → transcript表示」を確認

直近の残タスク:

- 実アプリ操作で本人の声・Zoom音声を使った transcript 品質確認
- progressive result の確定タイミング調整
- transcript を商談履歴・議事録・コンプラレビューへ保存する運用確認
- system audio / microphone のspeaker扱いを実商談で確認
- model asset 未準備時のUXをDashboardへ出す

## 1. 結論

Macユーザー前提のMVPでは、文字起こしの第一候補を **Apple SpeechAnalyzer / SpeechTranscriber に変更する**。

Deepgram / Cloudflare R2 / Queues は廃止しない。ただし主力ではなく、以下の用途に降格する。

- Apple SpeechAnalyzer 非対応端末のfallback
- iOS / Android / Web / Windows などMac外の入口
- 顧客がクラウドSTTを許容する場合のバッチ処理
- Cloudflare β / Enterprise でのサーバー側非同期処理

プロダクトの訴求は次へ変更する。

```txt
音声データを外部サーバーに預けない
会議Botを呼ばない
Mac上で文字起こしする
AIは文字起こし後のテキストに対して議事録・カンペ・コンプラ判定を行う
```

## 2. 背景

保険営業コンプラSaaSでは、録音データの取り扱いが導入可否に直結する。

従来案は以下だった。

```txt
音声 capture
 ↓
Deepgram / Cloud STT
 ↓
transcript
 ↓
AI議事録 / コンプラ判定
```

新方針は以下。

```txt
音声 capture
 ↓
Apple SpeechAnalyzer on-device STT
 ↓
transcript
 ↓
PII masking / rules
 ↓
AI議事録 / カンペ / コンプラ判定
```

この変更で、音声ファイルを外部に送らない価値を前面に出せる。

## 3. 技術調査まとめ

Apple SpeechAnalyzer は Speech framework の新しい音声解析APIで、`SpeechTranscriber` module を追加することで speech-to-text を行う。

Apple公式情報からの重要点:

- live / recorded speech をテキストへ変換できる
- 長時間・会議・会話・遠距離音声を想定した新しいon-deviceモデル
- 結果は async sequence で返る
- audio timeline / timecode により結果と音声範囲を対応付けられる
- volatile result と finalized result を扱える
- 言語別モデルassetは端末側で管理・取得する
- transcript をLLMへ渡して後続処理する構成と相性が良い

参考:

- Apple WWDC25: https://developer.apple.com/videos/play/wwdc2025/277/
- Apple Documentation: https://developer.apple.com/documentation/speech/speechanalyzer
- Kanary: https://kanary.download/ja/voice

## 4. 設計原則

### 4.1 STT provider を差し替え可能にする

既存の `STTProvider` / `ResilientSTTClient` の思想は維持する。

ただし provider の優先順位を変更する。

```txt
primary: apple_speech_analyzer
fallback: deepgram_streaming
batch fallback: deepgram_prerecorded / cloudflare_queue
manual/dev: manual_transcript
```

### 4.2 音声はローカル、AIは選択式

MVPでは以下を明確に分ける。

| 処理 | MVP方針 | 備考 |
|---|---|---|
| 音声capture | ローカル | ScreenCaptureKit / microphone |
| STT | ローカル | Apple SpeechAnalyzer |
| transcript保存 | ローカル優先 | local JSON / SQLite |
| カンペ生成 | Anthropic | transcriptのみ送信 |
| 議事録生成 | Anthropic | transcriptのみ送信 |
| コンプラ判定 | rules first | LLMは補助 |

営業資料上は「音声は外部送信しない」と言える。

ただし Anthropic を使う限り、transcript テキストは外部APIへ送る。ここは設定で明示する。

### 4.3 コンプラ判定はSTT provider非依存

下流はすべて `TranscriptSegment` を入力にする。

```txt
Apple SpeechAnalyzer
Deepgram
manual transcript
upload transcript
   ↓
TranscriptSegment[]
   ↓
Rule Engine / Minutes / AI Assist / Audit Log
```

## 5. 実装アーキテクチャ

### 5.1 TypeScript側

実装済みの型。

```ts
type SttProviderKind =
  | 'apple_speech_analyzer'
  | 'deepgram_streaming'
  | 'deepgram_prerecorded'
  | 'manual';

interface SttProviderStatus {
  provider: SttProviderKind;
  available: boolean;
  localOnly: boolean;
  requiresNetwork: boolean;
  error?: string;
}
```

既存の `STTProvider` interface は維持する。

```ts
interface STTProvider {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendAudio(chunk: AudioChunk): Promise<void>;
}
```

`createRuntimeConfiguredSTTClient()` は設定に応じて provider を選ぶ。

```txt
settings.sttProvider = local_first
  Apple SpeechAnalyzer available → Apple
  Apple unavailable + fallback enabled → Deepgram
  otherwise → error
```

### 5.2 Swift / NAPI側

実装は Swift を NAPI に直接混ぜず、native 配下の Swift helper を Electron Main から spawn する方式を採用した。

理由:

- SpeechAnalyzer は Swift async API が中心
- 既存 `.node` addon は audio capture に集中させる
- helper を別プロセスにすると、Speech framework 側の失敗をMainプロセスから分離できる
- packaging では `speech-analyzer-helper` を `extraResources` として同梱できる

現在の構成。

```txt
src/native/audio-capture
  ├─ Sources/NAPIBridge.mm                 # native audio capture .node
  ├─ Sources/SpeechAnalyzerHelper/main.swift
  ├─ Package.swift                         # speech-analyzer-helper build
  └─ binding.gyp
```

helper は stdin/stdout JSONL で TS provider と通信する。

```txt
TS AppleSpeechAnalyzerSTTProvider
  ↓ stdin: { type: "audio", data, startMs, sampleRate }
Swift speech-analyzer-helper
  ↓ stdout: { type: "ready", sampleRate }
  ↓ stdout: { type: "transcript", speaker, text, isFinal, startMs, endMs }
  ↓ stdout: { type: "error", code, message }
```

返す transcript は既存 `Transcript` 型へ合わせる。

```ts
{
  speaker: 'counterpart' | 'self',
  text: string,
  isFinal: boolean,
  startMs: number,
  endMs?: number
}
```

### 5.3 Speaker扱い

SpeechAnalyzer単体で商談相手/自分を完全分離できる前提にはしない。

MVPでは現実的に以下で進める。

| 入力 | speaker |
---|---|
| Zoom/system audio | `counterpart` |
| microphone | `self` |
| mixed audio | `counterpart` 近似、後で改善 |

speaker diarization はMVP必須にしない。保険コンプラ価値はまず「発話テキストの取得」と「NG表現検知」で出す。

## 6. 開発フェーズ

### Phase A: 技術検証

目的: Apple SpeechAnalyzer が現行audio captureと接続できるかを確認する。

タスク:

1. [x] macOS / Xcode / deployment target の要件確認
2. [x] SpeechAnalyzer helper 実装
3. [x] microphone buffer → SpeechAnalyzer → transcript
4. [ ] system audio buffer → SpeechAnalyzer → transcript の実商談品質確認
5. [x] 日本語モデルasset準備処理
6. [x] `native:audio:local-stt-smoke` 追加

完了条件:

- [x] Mac実機で日本語発話が transcript になる
- [ ] system audioでも transcript が安定して出る
- [x] transcriptが既存 `handlePipelineTranscript()` と同じ経路へ流せる

### Phase B: provider統合

目的: アプリ設定からApple / Deepgramを切り替えられる状態にする。

タスク:

1. [x] `SttProviderKind` / settings schema追加
2. [x] `AppleSpeechAnalyzerSTTProvider` をMain側から呼べるようにする
3. [x] `createRuntimeConfiguredSTTClient()` をlocal-first化
4. [x] Dashboardに現在のSTT provider表示
5. [x] Deepgram key未設定warningをlocal-first表示へ変更
6. [x] E2E更新

完了条件:

- [x] Deepgram keyなしでもローカルSTT診断が動く
- [x] Apple unavailable時だけfallback案内が出る
- [x] UIの「診断開始」から transcript が表示されるE2Eがある

### Phase C: 保険営業MVPへ接続

目的: ローカルSTTで作った transcript から議事録・コンプラレビューまで流す。

タスク:

1. [ ] realtime transcript保存のprovider metadata整理
2. [ ] local transcript → minutes generation の実データ確認
3. [ ] local transcript → compliance analysis の実データ確認
4. [ ] audit log に `stt.provider=apple_speech_analyzer` を記録
5. [ ] export / review UI へ接続

完了条件:

- 音声を外部送信せず、Macだけで transcript 生成
- transcriptから議事録・コンプラレビュー生成
- audit log にローカルSTT利用が残る

## 7. リスクと対策

| リスク | 内容 | 対策 |
|---|---|---|
| OS要件 | SpeechAnalyzer が最新OS前提 | 対応OSをMVP要件に明記、Deepgram fallback |
| モデルasset | 初回に言語asset downloadが必要 | onboardingで事前準備、診断画面で状態表示 |
| 話者分離 | SpeechAnalyzer単体ではspeaker分離が不足する可能性 | system/mic入力別speaker、diarizationはPhase 2 |
| 精度 | 保険用語・固有名詞で誤認識 | ルール側を表記揺れ対応、必要ならfallback STT |
| Swift実装量 | async sequence / audio format変換が必要 | helper方式で分離、smoke/E2Eで固定 |
| progressive result | live STTの確定タイミングが不安定 | TS側で短いprefix重複を抑制、実商談で調整 |
| AI外部送信 | transcriptをAnthropicへ送ると完全ローカルではない | 音声非送信とテキスト送信を明示、将来local LLM option |

## 8. 直近タスク

2026-06-11 時点の次タスク。

1. 実アプリを起動し、本人の声で「診断開始 → transcript表示」を手動確認
2. Zoom / system audio source で transcript が取れるか確認
3. transcript の重複・確定タイミングをUI上で調整
4. `stt.provider` / `stt.localOnly` を transcript metadata / audit log に残す
5. local transcript から議事録・コンプラレビュー生成までワンクリック確認
6. model asset 未準備・非対応OS・helper missing のDashboard UXを整理

## 9. 方針変更の扱い

これは後退ではない。

これまで作った以下はそのまま活きる。

- audio capture
- transcript pipeline
- `STTProvider` 抽象
- Deepgram fallback
- Anthropic議事録/カンペ生成
- compliance rule engine
- review / audit log
- Cloudflare β

変わるのは「第一STT provider」と「売り文句」。

```txt
Before: Cloud STTで高精度に文字起こし
After: 音声を外部送信せず、Mac上で文字起こし。AIは議事録・カンペ・レビューに使う
```
