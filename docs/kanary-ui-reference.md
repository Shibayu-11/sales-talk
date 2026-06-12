# Kanary UI リファレンス(SalesTalk への移植メモ)

作成日: 2026-06-12
出典: Kanary v2(kanary.download)のアプリ UI / LP スクリーンショット
対象: 主に Control アプリの Calls(履歴)タブと議事録ビュー。リアルタイムオーバーレイは対象外(うちの独自領域)。

## 1. アプリ UI から盗むパターン

### 1.1 三分割レイアウト(履歴詳細画面)

```
[左: 録音リスト] [中央: プレイヤー + transcript] [右: Summary]
```

- 左サイドバー: Today / Yesterday / Past 7 days / Past 30 days の**経過時間グルーピング**。各行はタイトル + 長さ + 時刻だけ
- 中央: タイトル(インライン編集)+ 日時・長さ・状態(`transcribed`)+ 波形プレイヤー + transcript
- 右: 折りたたみ可能な Summary パネル + Regenerate ボタン

→ SalesTalk の Calls タブをこの構成に寄せる。現状のリスト+詳細より商談の「読み返し」体験が圧倒的に良い。

### 1.2 話者分離 = 左右チャットバブル

- 自分の発話は右寄せ、相手は左寄せ。色も微妙に変える
- **AI 話者推定に頼らない構造的分離**(マイク vs スピーカー)を UI でそのまま見せている
- うちは既に `speaker: self | counterpart` を持っているので実装コストはスタイルだけ

### 1.3 タイムスタンプリンク(最重要)

- Summary の Decisions が `[00:49] Onboarding redesign is the headline item for July.` の形式
- タイムスタンプをクリックすると該当 transcript 位置(+ 音声再生位置)へジャンプ
- **SalesTalk での応用が Kanary 超えポイント**:
  - 議事録の決定事項・宿題 → 該当発話へジャンプ
  - **反論検知の記録 → 「この瞬間に price 反論が出て、この提案を出した」へジャンプ**(Kanary にない)
  - **Track B: コンプラ違反 finding → 該当発話へジャンプ**(上長レビューの核。severity バッジ付き)

### 1.4 transcript ツールバー

- `Regenerate / Copy / Re-transcribe / Follow Playback(チェックボックス)`
- Follow Playback: 再生位置に transcript が自動スクロール、現在発話をハイライト
- Re-transcribe: provider を変えて再文字起こし(うちなら apple ⇄ deepgram 切替再実行に対応)

### 1.5 Summary パネルの構成

```
Overview(3〜4文の段落)
Key points(箇条書き)
Decisions([mm:ss] 付き)
Action items([mm:ss] 担当者 — タスク)
```

- うちの `meeting_minutes` 出力をこの構成に合わせる + 商談用に「反論と対応」「ネクストアクション」「リスクフラグ」セクションを追加
- 右上に Regenerate(いつでも再生成できる安心感。プロンプト改善後の再実行にも効く)

### 1.6 その他

- Start Recording がウィンドウ右上に常時ある(録音開始までの距離が短い)
- 設定はタブ切替の単一ウィンドウ(Move & Resize / App Hotkeys / Input Mode / About)

## 2. LP・訴求コピーから盗む点

- ヘッドライン構造: 「会議にゲストはいない。**録音に許可はいらない。**」— 課題の言い換え + 太字で差別化点
- サブコピー: 「ボットの承認も、ホストの許可も、相手への断りも要らない。録音・文字起こし・要約まで、すべてあなたの Mac の中で。」
- 3 ピラー構成: 録音 / 文字起こし / 要約 — 各 2〜3 行
- 機能カードに **対応 macOS バッジ**(macOS 26+)を正直に出している
- SalesTalk 版の訴求軸(案): 「録音しているだけでは、商談は勝てない。」— 事後ツール(Kanary 等)との対比で**商談中**に価値が出ることを推す。プライバシー訴求(ローカル STT)は同等に併記

※ 注意: 「相手への断りも要らない」は SalesTalk ではそのまま使わない。うちは録音同意フロー(consent attestation)を価値として持っており、BtoB 商談・保険募集では同意取得が前提(2軸計画 §9)。

## 3. 実装マッピング(ロードマップ対応)

| Kanary パターン | SalesTalk 実装先 | 時期 |
|---|---|---|
| 三分割レイアウト + 経過時間グルーピング | Control / Calls タブ再構成 | Week 3 |
| 左右チャットバブル | Calls 詳細 + ダッシュボードの live transcript | Week 3 |
| Summary パネル(Overview/Decisions/Action items) | 議事録ワンクリック生成の出力 UI | Week 3 |
| タイムスタンプリンク(議事録→発話) | minutes / findings → transcript セグメントジャンプ | Week 3〜4 |
| 反論イベントのタイムラインジャンプ | objection 記録に startMs を保存して transcript へリンク | Week 4 |
| Re-transcribe(provider 切替) | STT ジョブ再実行 UI | Week 3(音声 import と同時) |
| Follow Playback + 波形 | 音声再生は AudioAsset がある通話のみ(realtime 通話は録音保存が AES-256-GCM ローカルのみ・任意) | Week 4 以降 |
| LP コピー構造 | β 配布時の紹介ページ | Week 5 |
