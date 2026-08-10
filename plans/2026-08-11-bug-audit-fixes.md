# バグ監査指摘の修正計画

状態: 完了

## 目的

`docs/2026-08-11-bug-audit.html` で確認した不具合を、再現テストを伴う小さな変更として修正する。

## 実施順

1. HTML/CSS監査を強化し、危険な埋め込み・entity・CSSコメント回避を拒否する。
2. 保存・状態再取得・画像アップロードの非同期競合からローカル編集を保護する。
3. プロジェクト保存・作成・復元を直列化および完全同期する。
4. Codex切断、イベント再接続、プロジェクト単位Turn競合を修正する。
5. HTTP method、JSONエラー、Variation失敗時の後始末を修正する。
6. Undo、drag/drop、metrics、固定寸法、offline exportを修正する。
7. TypeScriptとCloudflare bindingの設定不整合を修正する。
8. lint、型検査、unit test、production buildを実行し、監査資料を更新する。

## 完了条件

- 各指摘に対する回帰テスト、または再現可能な静的検証がある。
- `npm run lint`、`npm run typecheck`、`npm test` が成功する。
- 修正結果と残存リスクをユーザー向けHTMLへ反映する。
- 変更を機能単位でコミットし、`dev/general` に統合する。

## 実施結果

- HTML/CSS監査と表示時サニタイズを追加し、危険な埋め込みとCSS汚染を遮断した。
- 編集世代、保存mutex、アップロード対象固定、Codex再接続・イベントgap処理を追加した。
- managed tree復元、HTTP method・JSON境界、Variation後始末、各UI不具合を修正した。
- offline HTMLへ画像をdata URLとして埋め込み、固定スライド寸法を維持した。
- Cloudflare bindingと型定義を揃え、`typecheck` scriptを追加した。
- `npm run lint`、`npm run typecheck`、`npm test`（production build、148 tests）が成功した。
