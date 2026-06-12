# 実機 Zoom E2E 検証チェックリスト

作成日: 2026-06-12
対応: [MVP リリースロードマップ](./mvp-release-roadmap.md) Week 1 / M1(実機 E2E Go/No-Go 判定)
目的: 「実際の Zoom 商談で 音声 → STT → 反論検知 → オーバーレイ表示 が通しで動くか」に答えを出す。

## 0. 前提準備(検証当日より前に)

- [ ] macOS 26 Tahoe + Apple Silicon の実機(SpeechAnalyzer 必須要件)
- [ ] `npm run native:audio:build && npm run native:speech:build` が成功する
- [ ] Anthropic API キーを設定画面から登録済み(`secrets` 経由、Keychain 保存)
- [ ] 模擬商談の相手役を確保(別端末 + ヘッドフォン推奨。AEC 検証のため最低 1 回はスピーカー出しも試す)
- [ ] 反論セリフ台本を印刷 or 別画面に用意(§4)

## 1. 起動とログ収集

ログは stdout に JSON Lines で出る。必ずファイルに残す:

```bash
npm run dev 2>&1 | tee /tmp/salestalk-e2e-$(date +%Y%m%d-%H%M).log
```

- [ ] Control ウィンドウが開く
- [ ] 設定 → STT モードが `local_first` になっている
- [ ] 起動ログに `resolved stt provider` が出て `providerKind: "apple_speech_analyzer"` である
  - `deepgram_streaming` + `degradedReason: "apple_speech_analyzer_unavailable"` の場合は縮退で動いている。原因(macOS バージョン / helper バイナリ)を記録

## 2. 権限フロー

- [ ] 初回起動で Screen Recording 権限の誘導が出る → 許可 → 再起動後に有効
- [ ] Microphone 権限の誘導が出る → 許可
- [ ] 権限を一度剥奪(システム設定で OFF)→ アプリが検知してエラー表示するか(§26 ベストエフォート)

## 3. 通し動作(模擬商談 30 分)

Zoom 通話を開始し、Control ウィンドウから商談開始(商材: 任意の1つ)。

- [ ] 商談開始でオーバーレイが表示される(`待機中` 表示)
- [ ] **相手の発話**が transcript に出る(system audio 経由、speaker=counterpart)
- [ ] **自分の発話**が transcript に出る(mic 経由、speaker=self)
- [ ] 相手役に §4 の反論セリフを言ってもらう → 検知バッジ → 切り返し候補が L1→L2 と表示される
- [ ] 相槌(「はい」「なるほど」)では検知が**発火しない**
- [ ] 雑談では検知が発火しない(誤検知したら transcript と一緒に記録)
- [ ] 自分が話し始めると表示が消える(consumed 遷移)
- [ ] L1/L2/L3 切替、ホバーでクリックスルー解除が動く
- [ ] 30 分連続でクラッシュ・音声途切れ・メモリ肥大がない(アクティビティモニタで確認)

### 画面共有時の三段防御

- [ ] Zoom で画面共有を開始 → オーバーレイに `🔒 画面共有保護` バッジ
- [ ] **相手側の画面でオーバーレイが見えていない**ことを相手役に確認してもらう(最重要)
- [ ] Zoom をフルスクリーンにしてもオーバーレイが上に出る

## 4. 反論セリフ台本(相手役用)

検知されるべき発話(商材: 不動産の例。他商材でも type が拾えるか確認):

| # | セリフ | 期待 type |
|---|---|---|
| 1 | 「正直、価格がちょっと高いなと感じています」 | price |
| 2 | 「今すぐではなくて、来期から検討でもいいですか」 | timing |
| 3 | 「私の一存では決められないので、上に確認しないと」 | authority |
| 4 | 「今のやり方で特に困ってないんですよね」 | status_quo |
| 5 | 「他社さんからも似た提案を受けていまして」 | competitor |
| 6 | 「本当に効果が出るのか、正直疑問です」 | trust |

検知されるべきでない発話:

| # | セリフ | 期待 |
|---|---|---|
| 7 | 「はい」「なるほど」「そうですね」 | 検知なし(5文字未満フィルタ) |
| 8 | 「今日は暑いですね。ところで御社のオフィスは渋谷でしたっけ」 | 検知なし(雑談) |

## 5. レイテンシ計測

ログから `objection_pipeline_latency` を抽出する:

```bash
grep objection_pipeline_latency /tmp/salestalk-e2e-*.log | npx -y json5 2>/dev/null || \
grep objection_pipeline_latency /tmp/salestalk-e2e-*.log
```

各検知について記録される項目:

| フィールド | 意味 |
|---|---|
| `detectMs` | Haiku 検知の所要時間 |
| `knowledgeMs` | ナレッジ検索の所要時間 |
| `generateMs` | Sonnet 生成の所要時間 |
| `totalMs` | final transcript 受信 → 切り返し送出(main プロセス内) |

判定基準(PRD §4.6: 発話終了 → 表示 2.5s):

- [ ] `totalMs` の中央値 ≤ 2,000ms(STT 確定遅延 + 描画分の余裕 500ms を残す)
- [ ] STT 確定遅延の体感計測: 相手役の発話終了をストップウォッチで取り、final transcript のログ時刻と突き合わせる(3 回以上)
- [ ] `detectMs` / `generateMs` のどちらが支配的かを記録(Week 2 のチューニング対象決定)

## 6. STT 品質(日本語)

- [ ] 商材固有語が拾えるか: 「重要事項説明」「健康経営優良法人」「補助金」「採択」「利回り」
- [ ] 数字・金額が正しく出るか: 「月額 30 万円」「築 12 年」「2,000 万円」
- [ ] 誤認識が多い場合、`deepgram_fallback` に切り替えて同じ台本で比較し、差分を記録

## 7. 終了処理

- [ ] 商談終了でオーバーレイが消え、STT が停止する
- [ ] 通話履歴に transcript が保存されている(Calls タブ)
- [ ] 監査ログに `recording.started` があり、metadata に `sttProvider: "apple_speech_analyzer"` が入っている
- [ ] アプリ再起動後も履歴・設定が残っている

## 8. Go/No-Go 判定

**Go(Week 2 の品質改善へ進む)**: §3 の通し動作が完走し、致命的クラッシュなし。レイテンシが目標の 2 倍以内。

**No-Go(計画見直し)**: 以下のいずれか。

- system audio が Zoom から取れない → PRD §19.3 プラン B(Core Audio Tap macOS 14.2+)へ後退判断
- SpeechAnalyzer の日本語品質が商談に使えない → Deepgram を MVP 主力へ戻す判断(設定は既に切替可能)
- レイテンシ totalMs 中央値 > 5s → アーキテクチャ見直し(投機開始タイミング、モデル選択)

判定結果と実測値は本ファイル末尾に追記して履歴を残すこと。

## 9. 検証結果記録

| 日付 | 実施者 | 結果 | totalMs 中央値 | 備考 |
|---|---|---|---|---|
| | | | | |
