# バグ監査指摘の修正計画

状態: 実施中

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
