# リリースビルド & 配布手順(macOS)

作成日: 2026-06-15
対応: [MVP リリースロードマップ](./mvp-release-roadmap.md) Week 5 / M5
対象: Apple Silicon (arm64) のみ。理由は §1。

## 1. 配布アーキテクチャの決定

**Apple Silicon (arm64) 専用で配布する。** universal/Intel は対象外。

- 看板機能の Apple SpeechAnalyzer が Apple Silicon 必須(macOS 26 Tahoe+)。
- 競合 Kanary も voice 機能は Apple Silicon + macOS 26 限定。
- ネイティブ binary(`audio_capture.node` / `speech-analyzer-helper`)は現状 arm64 のみ。
  universal を名乗ると Intel スライスが arm64 ネイティブを読めず**起動クラッシュ**するため、
  「動くふりをして壊れる」状態を避ける。
- `minimumSystemVersion: 13.0`(ScreenCaptureKit の下限)。SpeechAnalyzer 非対応 OS では
  Deepgram fallback に縮退する。

Intel 対応が必要になったら、先に NAPI と Swift helper を x86_64 でもビルドして lipo で
universal binary を作り、それから `electron-builder.yml` の `arch` を universal へ戻す。

## 2. 事前準備(初回のみ・柴さん作業)

公証には Apple の有料アカウントと証明書が必須。これがないと §4 の公証ステップで失敗する。

- [ ] Apple Developer Program 登録(年 $99)
- [ ] **Developer ID Application** 証明書を作成し、ログイン Keychain に取り込む
      (electron-builder は `CSC_IDENTITY_AUTO_DISCOVERY` で自動検出する)
- [ ] App Store Connect で **App 用パスワード**(app-specific password)を発行
- [ ] Team ID を控える(メンバーシップ画面)

## 3. 環境変数(公証用)

`package:mac` 実行前にシェルへエクスポート。CI なら Secrets に入れる。**コミット禁止。**

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="XXXXXXXXXX"
# GitHub Release へ publish する場合:
export GH_TOKEN="ghp_..."
```

電子署名証明書は Keychain から自動検出される(`CSC_IDENTITY_AUTO_DISCOVERY` を false にしない)。

## 4. 本番ビルド(署名 + 公証 + DMG)

```bash
npm run lint && npm run typecheck && npm test   # 緑を確認してから
npm run package:mac
```

`package:mac` の中身:
1. `native:audio:build` — NAPI アドオン(arm64)
2. `native:speech:build` — SpeechAnalyzer helper(arm64)
3. `electron-vite build` — main/preload/renderer
4. `electron-builder --mac --arm64` — 署名 → 公証 → DMG(`release/` 出力)

成果物: `release/SalesTalk-<version>-arm64.dmg` と `latest-mac.yml`(updater 用)。

## 5. 署名・公証なしの構成検証(Apple アカウント不要)

設定ミスだけを早期に潰したいとき。実際の配布物にはならない。

```bash
npm run native:audio:build && npm run native:speech:build && npm run build
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --arm64 --dir -c.mac.notarize=false
```

検証ポイント(2026-06-15 実施済み):

- [x] `release/mac-arm64/SalesTalk.app/Contents/MacOS/SalesTalk` が arm64
- [x] `Contents/Resources/native/audio-capture/audio_capture.node`(arm64)が同梱
- [x] `Contents/Resources/native/audio-capture/speech-analyzer-helper`(arm64)が同梱
- [x] Info.plist: `LSMinimumSystemVersion=13.0`、URL スキーム `salestalk`、画面収録/マイク権限文言
- [x] ランタイム解決パス(`process.resourcesPath/native/audio-capture/...`)が同梱先と一致

## 6. 自動更新(electron-updater)

- `publish: github` 設定済み。`npm run package:mac` 後、GitHub Release に DMG と
  `latest-mac.yml` を上げると、起動中アプリが次回チェックで更新を検知する。
- インストールは **商談中は遅延**(15 分ごと再試行、通話終了で即時)。実装は
  `src/main/services/updater.ts`、ポリシーは PRD §32。
- updater はパッケージ版でのみ動作(dev では no-op)。

## 7. クリーン環境での受け入れ確認(M5、実機)

別の Apple Silicon Mac、または新規ユーザーアカウントで:

1. DMG をマウントして `/Applications` へドラッグ
2. 初回起動 → Gatekeeper が「開発元を確認済み」で開けること(公証成功の確認)
3. オンボーディング(権限 → Anthropic キー → 商材)が完走すること
4. [実機 Zoom E2E チェックリスト](./live-zoom-e2e-checklist.md)を別マシンで通すこと

## 8. よくある失敗

| 症状 | 原因 / 対処 |
|---|---|
| 公証で `Team ID` エラー | `APPLE_TEAM_ID` 未設定。§3 を確認 |
| 署名がスキップされる | Developer ID Application 証明書が Keychain に無い |
| Intel Mac で即クラッシュ | 想定どおり(arm64 専用)。配布対象外 |
| 起動時に native module not found | `native:*:build` を流さずパッケージした。`package:mac` を使う |
| updater が動かない | dev ビルドでは no-op。パッケージ版 + GitHub Release が必要 |
