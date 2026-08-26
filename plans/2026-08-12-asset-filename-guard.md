# 2026-08-12 スライドHTMLの画像が読み込めないバグ

## 症状

`workspaces/test/slides/*.html` が参照する `assets/<sha256>.jpeg` が
プレビューでもサムネイルでも表示されない。ファイルはディスク上に存在する。

実機確認:

```
$ curl -s http://127.0.0.1:4317/api/assets/05ed...53cbb.jpeg
{"error":"Asset not found."}
```

## 原因

`server/project.mjs:750` の資産名ガードがハッシュ形状の完全一致になっている。

```js
const assetFilenamePattern = /^[0-9a-f]{64}\.(?:png|jpg|webp|svg|gif)$/;
```

- 拡張子リストに `jpeg` がない。`importImageAsset` 経由なら `image/jpeg` → `jpg`
  に正規化されるが、Agentがネットワークから取得した画像を `assets/` へ直接書くと
  `.jpeg` のまま残る（`workspaces/test/assets/` の5件すべてが該当）。
- ベース名を sha256 64桁に限定している。`workspaces/northstar/assets/60d970719b3607e5.png`
  のような短いハッシュ名も弾かれる。

このガードは配信経路すべての入口にあるため、1か所の不一致が全経路の404になる。

- `server/local-api.mjs:72` `sendAsset` → `/api/assets/<name>`（プレビュー）
- `server/local-api.mjs:272` → `/api/projects/<slug>/assets/<name>`（プロジェクト一覧サムネイル）
- `app/page.tsx:710` プレビューDOMの `img[src^="assets/"]` 差し替え先
- `app/page.tsx:1811` オフラインエクスポートの画像インライン化（`response.ok`
  でないと書き出し自体が失敗する）

加えて `sendAsset` のMIME表と `rewriteThumbnailAssets` の正規表現も同じ拡張子リストを
別々に持っており、同じずれを繰り返している。

## 方針

ガードの目的は「assets ディレクトリの外へ出さないこと」であって
「sha256であること」ではない。ハッシュ形状の検査をやめ、パス安全性の検査にする。
拡張子リストは1か所に集約し、`jpeg` を含める。

## 変更

1. `server/project.mjs`
   - 拡張子→MIMEの単一の表を `export` する（`png/jpg/jpeg/webp/svg/gif`）。
   - `assetFilenamePattern` を単一パスセグメントの安全名に緩める。
     - 許可: `^[A-Za-z0-9][A-Za-z0-9._-]*\.(png|jpg|jpeg|webp|svg|gif)$`
     - `/`・`\`・`..`・先頭ドット・制御文字を含む名前は引き続き拒否。
   - `rewriteThumbnailAssets` の正規表現を同じ拡張子リストから組み立てる。
2. `server/local-api.mjs`
   - `sendAsset` のローカルMIME表を廃止し、`server/project.mjs` の表を使う。
   - `/api/assets/<name>` は `sendAsset` 内の検査に加え、`join` の前に
     ファイル名を検証してからパスを組む（`/api/projects/...` 側と揃える）。
3. `importImageAsset` の書き込み名は `jpg` のまま変更しない（既存資産の互換のため
   読み取り側だけを広げる）。

## 検証

- `tests/project-management.test.mjs` に `.jpeg` 資産と短いハッシュ名の
  サムネイル書き換えケースを追加。
- 資産名ガードのユニットテストを追加: `../`、`a/b.png`、`.hidden.png`、
  拡張子なし、`x.exe` を拒否し、`<sha256>.jpeg`・`60d970719b3607e5.png` を許可。
- `npm run lint` / `npm test`。
- 実機: `curl http://127.0.0.1:4317/api/assets/05ed...53cbb.jpeg` が200になり、
  プレビューで画像が表示されること。
