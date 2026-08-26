# チャットへの素材持ち込み（あらゆるファイルをAgentへ渡す）計画

作成日: 2026-08-12

## 目的

チャット欄にPDF・pptx・画像など任意のファイルを投げ、Agentがそれを読んだうえでスライドを編集できるようにする。

現状、チャット欄はプレーンな `textarea` 1つで、ファイルの受け口がない（[app/page.tsx:2356](../app/page.tsx)）。
ファイルが入る経路は「キャンバスへの画像D&D → `assets/`」と「JSONバンドルのimport」だけで、どちらもチャットではない。

## 設計方針: Weaveは中身を解釈しない

Codex app-serverの `UserInput` が受け取れるのは `text / image / localImage / audio / localAudio / skill / mention` の7種のみで、
汎用のファイル型は存在しない。PDFやpptxをAgentへ渡す唯一の方法は **ディスク上のパスを教え、Agentが自分で開く** ことである。

本機能もこの分担をそのまま採用する。

```
人がチャットにPDFをドロップ
  → Weaveが references/<hash>-<元の名前>.pdf に保存
  → 送信時、envelope に attachments: [{ path, name, bytes }] を載せる
  → contextPromptRules に「ディスク上のパスである。中身は渡していない」と書く
  → Agent が cwd=projectRoot / workspaceWrite sandbox の中で自分で読む
```

Weave側にパーサを一切持たない。対応形式を増やすたびに実装が増える構造にしない。
画像だけは例外で、`localImage` としてAgentの目に直接入れる（Codexが対応している唯一の非テキストモダリティであるため）。

## 決定事項

1. **保存先は `references/`。`assets/` とは分ける**
   `assets/` は「スライドHTMLに `assets/<hash>.<ext>` で埋め込まれる画像」専用で、
   サムネイル用のパス書き換え（`rewriteThumbnailAssets`）とSVGのcontent-policy検査が乗っている。
   持ち込み素材はスライドの構成要素ではないので、この機構に混ぜない。

2. **形式のホワイトリストを設けない。上限はサイズのみ（25MB）**
   Weaveが中身を読まない以上、拡張子で絞る技術的理由がない。
   ファイル名から拡張子を取り、パス区切り・制御文字・引用符・空白のみ置換する。日本語のファイル名は保つ。

3. **実体はgit管理外。パスの記録だけgit管理下に置く**
   - `references/<hash>-<name>.<ext>` は `managedPaths` に入れない → `commitIfChanged` の `git add` 対象外なので永久にuntrackedのまま残る。案ブランチの `git checkout` でも消えない。
   - `references/index.json`（パス・元の名前・ハッシュ・サイズ・追加時刻の追記のみの台帳）だけを `managedPaths` に **ファイル単位で** 追加する。
   - これにより履歴を遡ると「そのターンに何を渡したか」は完全に残り、実体だけが無い状態になる。リポジトリはバイナリで肥大しない。
   - プロジェクトに `.gitignore` は不要（`git add` が `managedPaths` 限定のため、書かなくても実体は入らない）。

4. **アップロードはドロップ/選択の時点で行う**
   既存の `uploadImage` と同じタイミング。送信せずに終えた場合ファイルはuntrackedで残るが、gitに入らないので害がない。

## 変更対象

| 変更 | 場所 |
|---|---|
| `importReference()` — 保存、ハッシュ、名前の正規化、`index.json` 追記 | `server/project.mjs`（`importImageAsset` の隣）|
| `referencesRoot()` / `managedPaths` に `references/index.json` を追加 | `server/project.mjs` |
| `POST /api/references` と、ルート許可リストへの追加 | `server/local-api.mjs`（`/api/assets` の隣）|
| `editorEnvelope` に `attachments` ブロック、`contextPromptRules` に2文 | `shared/context.mjs` |
| `textInput()` → `turnInput(prompt, attachments)`。画像添付は `{ type: "localImage", path: 絶対パス }` を追加 | `server/codex/service.mjs:12` |
| `startTurn` / `steerTurn` が `attachments` を受け取り `turnInput` へ渡す | `server/codex/service.mjs` |
| 添付UI（📎ボタン / chat-boxへのdrop / paste、送信前チップ、×で外す）と `sendMessage` のペイロード拡張 | `app/page.tsx`（`chat-box` 周辺）|

## 進め方

- [ ] `references/` の保存と `index.json` 台帳（`server/project.mjs`）
- [ ] `POST /api/references` とルート許可（`server/local-api.mjs`）
- [ ] envelope の `attachments` と `contextPromptRules` の追記（`shared/context.mjs`）
- [ ] `turnInput` と画像の `localImage` 化（`server/codex/service.mjs`）
- [ ] チャットUI（📎 / drop / paste / チップ / 送信ペイロード）（`app/page.tsx`）
- [ ] AGENTS.md のプロジェクト指示に「素材の読み方」を1段落追加
- [ ] テスト（保存・名前正規化・envelope・localImage組み立て）
- [ ] 実機確認（PDF・pptx・画像をそれぞれ投げてAgentが読めるか）

## 成功条件

1. PDF / pptx / 任意の拡張子のファイルをチャット欄にドロップでき、Agentがそのパスを知り、自力で開ける
2. 画像を添付するとAgentが「見た」うえで応答する（パスを知るだけではない）
3. `references/` の実体がgitのコミットに一切入らない。`references/index.json` は入る
4. `assets/` の既存経路（キャンバスD&D、スライドへの埋め込み、サムネイルのパス書き換え）が壊れていない
5. 添付なしのターンの挙動・プロンプトが従来と1バイトも変わらない

## 非スコープ

- Weave側でのPDF/pptxのテキスト抽出（Agentがホストのツールで読む。読めなければAgentがそう言う）
- 添付ファイルのプレビュー表示
- チャットログ上での過去ターンの添付履歴カード（送信前チップのみ）
- `mention` 型の使用（envelope経由のパス受け渡しで足りる）

## 既知の穴

pptx / docx / xlsx はzipなので `unzip` でXMLを読めるが、**PDFのテキスト抽出はホスト依存**（pdftotextやpypdfが無いと読めない）。
本計画ではWeave側で肩代わりせず、AGENTS.mdに読み方のヒントを書くところまでとする。

なお 2026-08-12 に sandbox の `networkAccess` を `true` へ変更したため、Agentはターン中に必要なツールを取得できる。
Weave側で抽出を持たない判断はこれで維持しやすくなった。
