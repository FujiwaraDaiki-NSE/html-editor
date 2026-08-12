# 資料棚にフォルダを置く計画

作成日: 2026-08-12

## 目的

案件フォルダをまるごと棚に置き、Agentに「この一式を見て」と渡せるようにする。

[ワークスペースの資料棚](2026-08-12-workspace-references.md)で単発ファイルの棚はできた。
だが実際の資料は「20個のPDFが入った1つのフォルダ」で来る。1件ずつチャットに投げるのは現実的ではない。

## 設計方針: サーバがディスクからコピーする

ブラウザはドロップされたフォルダの絶対パスを教えてくれない。
そこで**選ばせる側をサーバに寄せる**。UIはサーバのディレクトリ一覧を辿って場所を指し、サーバがその場で `cp` する。

```
人が 📎 → Add folder → ~/Documents/案件A まで降りる → 取り込む
  → サーバが references/案件A/ へ構造ごと複製
  → index.json に kind:"folder" と source（取り込み元の絶対パス）を1行
  → チェックを入れて送ると envelope に1件だけ載る
  → Agent が cwd 相対の references/案件A を自分で ls して読む
```

この形の効き目が3つある。

1. base64でJSONにくるむ既存のアップロード経路を通らない。148MBでもディスク速度で終わる。**フォルダには1ファイル25MBの上限を課さない**
2. `source` を覚えているので**「更新」ボタン**が作れる。コピー方式の弱点（原本を直しても棚が古い）が塞がる
3. ブラウザのファイル選択ダイアログに依存しないので、UIが棚の中に閉じる

## 決定事項

1. **フォルダは1件として渡す。中身は列挙しない**
   envelope は `{ path: "references/案件A", name: "案件A", kind: "folder", bytes, files: 24 }` の1件。
   24件のファイルを並べない。Agentが自分で `ls` する。「Weaveは中身を解釈しない」の一貫。

2. **保存名は元のフォルダ名。中は元の相対パスを保つ**
   単発ファイルの `<hash12>-<名前>` 方式は使わない。フォルダは構造そのものが意味を持つ。
   名前は区切り・制御文字・引用符・空白のみ置換（`normalizeReferenceName` と同じ規則、拡張子の扱いは無し）。
   衝突したら `案件A-2`。

3. **ブラウズは `$HOME` 配下のみ**
   127.0.0.1 に立つAPIとはいえ、全ファイルシステムを一覧させる理由がない。
   `realpath` を取ってから `$HOME` 配下かを判定する（シンボリックリンクでの脱出を防ぐ）。

4. **取り込み時に除外するもの: ドットで始まる名前と、シンボリックリンク**
   `.git` / `.DS_Store` / `.env` がまとめて落ちる。リンクは追わない（棚の外を指し得るため）。

5. **上限は 2000ファイル / 500MB。超えたら取り込まない**
   コピー前に必ず walk して数える。同じ walk の結果をブラウズ画面のフッタ表示にも使う。
   上限に達した時点で walk を打ち切り、「2000+ files」と出して取り込みボタンを塞ぐ。

6. **更新は丸ごと消して再コピー。差分同期はしない**
   `source` が消えていたら更新ボタンを無効化する（`sourceMissing`）。
   **Agentが棚のコピーへ書いた変更も消える。**原本が正、という割り切りをそのまま採る。

7. **棚ではフォルダを展開しない**
   1行のまま。中の1ファイルだけ添付する導線は作らない。単位は「フォルダごと」か「単発ファイル」の二択。

8. **git方針は既存のまま**
   `managedPaths` は `references/index.json` だけ。フォルダの実体はuntrackedのままで、
   `duplicateProject` の除外もディレクトリごと効くので変更不要。

## 変更対象

| 変更 | 場所 |
|---|---|
| `isReferencePath` を階層許可へ（各セグメントが空・`.`・`..`・`\` でないこと）。正規表現1本ではなく関数で書く | `shared/context.mjs` |
| envelope の attachment に `kind`（`"file"` \| `"folder"`）と `files` を通す。`kind: "folder"` は `files` が数値であることを必須にする | `shared/context.mjs` |
| `contextPromptRules` に「folder の attachment はプロジェクト内のディレクトリで、中身は列挙していない」の1文 | `shared/context.mjs` |
| `walkReferenceFolder(source)` — 除外規則つきで再帰し `{ files, bytes, capped }` を返す（上限で打ち切り） | `server/project.mjs` |
| `listFolders(path)` — `$HOME` 判定、サブディレクトリ一覧、`walkReferenceFolder` の集計、親パス | `server/project.mjs` |
| `importReferenceFolder({ source })` — 検証・集計・`cp`・台帳追記 | `server/project.mjs` |
| `syncReferenceFolder(path)` — コピーを消して `source` から再取得 | `server/project.mjs` |
| `readReferences()` が `kind` を必ず返し、フォルダには `sourceMissing` も付ける | `server/project.mjs` |
| `removeReference(path)` がディレクトリにも効く（`rm -r`） | `server/project.mjs` |
| `GET /api/folders?path=`、`POST /api/references/folder`、`POST /api/references/folder/sync`、許可リスト | `server/local-api.mjs` |
| `turnInput` が `kind: "folder"` を `localImage` にしない | `server/codex/service.mjs` |
| 棚のFOLDERS/FILES2段化、ブラウズ画面、更新ボタン | `app/page.tsx` |
| ブラウズ画面のスタイル | `app/globals.css` |

## 進め方

- [ ] `isReferencePath` の階層許可と envelope の `kind` / `files`（`shared/context.mjs`）
- [ ] `walkReferenceFolder` / `listFolders`（`server/project.mjs`）
- [ ] `importReferenceFolder` / `syncReferenceFolder` と `readReferences` / `removeReference` の拡張（`server/project.mjs`）
- [ ] 3つのAPIと許可リスト（`server/local-api.mjs`）
- [ ] `turnInput` のフォルダ除外（`server/codex/service.mjs`）
- [ ] 棚2段化とブラウズ画面（`app/page.tsx` / `app/globals.css`）
- [ ] テスト
      - `isReferencePath` が階層を通し `..` と絶対パスと `\` を弾く
      - envelope が `kind: "folder"` を通し、`files` の無いフォルダを落とす
      - 取り込みでドットファイルとシンボリックリンクが落ち、構造が保たれる
      - 上限超過が取り込まれない
      - `$HOME` の外のパスが `listFolders` / `importReferenceFolder` の両方で弾かれる（`realpath` 経由の脱出も）
      - `syncReferenceFolder` が原本の追加・削除を反映する
      - `removeReference` がディレクトリを消し、台帳からも消える
      - `turnInput` がフォルダを `localImage` にしない
- [ ] `npm run typecheck` / `npm run lint` / `npm test`
- [ ] 実機確認（実フォルダを取り込み、Agentが `ls` して中のPDFを読む。更新が効く）

## 成功条件

1. 📎 → Add folder → ホーム配下を辿ってフォルダを選び、取り込める
2. 取り込んだフォルダをチェックして送ると、Agentが `references/<名前>` を `ls` して中の資料を読む
3. 原本にファイルを足して「更新」を押すと、棚にも増える
4. `$HOME` の外は、UIからもAPIを直接叩いても取り込めない
5. フォルダの実体がgitのコミットに一切入らない。`references/index.json` だけが入る
6. 既存の単発ファイルの棚・添付・削除が壊れていない

## 非スコープ

- フォルダのドラッグ&ドロップ（`webkitGetAsEntry` で可能だが、ブラウズがあるので急がない）
- 原本の監視と自動同期
- 除外パターンのユーザー設定
- 棚でフォルダを展開して中の1ファイルだけ添付する導線
- 差分同期（更新は常に全消し再コピー）

## 既知の穴

- 更新はAgentが棚のコピーへ加えた変更も消す。決定事項6のとおり原本を正とする割り切りで、UI上は警告を出さない。
- `source` が外付けドライブやネットワークボリュームだと、未マウント時に `sourceMissing` になる。復帰すれば更新は再び効く。
- 500MB上限は棚1件あたり。棚全体の合計は見ていない。溜まってから考える。
