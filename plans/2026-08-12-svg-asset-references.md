# 2026-08-12 SVG `<image>` の資産参照が書き換えられない

`plans/2026-08-12-asset-filename-guard.md` の資産名ガードを直したあと、
ブラウザ実機で確認して見つかった二つ目のバグ。

## 症状

スライド1 (cover) の画像が出ず、ネットワークログに次が残る。

```
GET http://localhost:3000/assets/2421976f...321e61.jpeg → 404
```

ホストがAPI (`127.0.0.1:4317`) ではなくVite devサーバになっている。
つまり資産URLの書き換えが一切かかっていない。

## 原因

`assets/` 参照の書き換えが `img` 要素の `src` しか見ていない。実際のスライドと
テンプレートは SVG の `<image href="assets/...">` でも画像を参照する
(`workspaces/test/slides/cover.html:45`、`templates/kearney-space-cover.html:27`)。

これは事故ではなく想定された書き方で、`server/project.mjs` のAGENTS.mdテンプレートが
「Graphs and decorative diagrams are static inline SVG」とAgentに指示している。

クライアントでスライドHTMLをDOMへ流し込む経路は4つあり、うち3つが未対応だった。

| 経路 | 状態 |
| --- | --- |
| `app/page.tsx` キャンバス注入 | `img` のみ対応 |
| `app/page.tsx` `templatePreview` (インスペクタ / 新規スライド) | 未対応 |
| `app/page.tsx` 発表者モード | 未対応（発表中に画像が全部出ない） |
| `app/page.tsx` `thumbHtml` | プロジェクト一覧はサーバ書き換え済み。新規プロジェクトのテンプレートギャラリーは未対応 |

サーバの `rewriteThumbnailAssets` とオフラインエクスポートも `src=` のみだった。

## 方針

対象範囲を `shared/asset-path.mjs` に集約し、`img src` と SVG `image` の
`href` / `xlink:href` のうち、値が `assets/` で始まる安全な資産名のものだけを扱う。
`clip-path="url(#...)"`、`href="#..."`、`<a href>` は対象外。

書き換え方はDOMを読み戻すかどうかで分ける。

- **キャンバス**は保存往復があるためDOM操作。元の相対パスを `data-asset-path`、
  元の属性名を `data-asset-attribute` に保持し、`serializeEditorNode` で相対参照へ戻す。
  ここを文字列置換にすると絶対URLがスライドHTMLへ焼き付く。
- **表示専用**の3経路 (テンプレートプレビュー、発表者モード、テンプレートギャラリー) は
  読み戻しがないので注入直前に文字列置換する (`displayAssetHtml`)。
  サニタイズ後に書き換えて、サニタイザが絶対URLを落とさない順序にする。
- サーバ書き換え済みの `item.thumbnailHtml` には二重適用しない。

## 検証

- `npm run lint` / `npm test` / `npm run typecheck`。
  `npm test` は `tsc` を通さないので typecheck を別途必ず実行する。
- 実機: キャンバス・テンプレートプレビュー・発表者モードで画像が表示され、
  Code表示 (保存と同じ `serializeEditorNode` 経路) に絶対URLが現れないこと。
