# ワークスペースの資料棚（持ち込んだファイルを案件で共有する）計画

作成日: 2026-08-12

## 目的

チャットに投げたファイルが「そのターン限り」で消えず、ワークスペースの資料としてそこに在り続け、
人もAgentも後から参照できるようにする。

2026-08-12 の [チャットへの素材持ち込み](2026-08-12-chat-file-intake.md) で、ファイルは既に
`workspaces/<slug>/references/` に永続保存され、`references/index.json` という台帳にも記録されている。
だが台帳を読み返す経路が一切ないため、

- 人は「この案件に今どんな資料があるか」を見られない（棚が見えない）
- Agentは「そのターンに添付されたもの」しか知らない（前のターンのPDFは存在しないのと同じ）
- 一度入れた資料を外せない（台帳は追記のみ）

本計画は**保存機構を足さない**。既にある `references/` を「資料棚」として見せ、選び直せるようにする層だけを作る。

## 設計方針: 棚は台帳、添付は指差し

```
references/<hash>-<name>.<ext>   実体（untracked。git履歴に入らない）
references/index.json            台帳（git管理下。棚の構成はブランチごとに版が残る）
```

この2つの役割は変えない。加えるのは意味の分離1つだけ:

| | 意味 | 経路 |
|---|---|---|
| **棚** | この案件が持っている資料一式 | `index.json` を Agent が自分で読む |
| **添付** | このターンで見てほしいもの | 従来通り envelope の `attachments` |

棚の中身は envelope に載せない。棚が育ってもターンあたりのトークンが増えないこと、
「今これを見て」という指差しの意味が薄まらないことの2点を優先する。
Agentへは `agentInstructions` に一文足して、必要なときに `references/index.json` を読ませる。

## 決定事項

1. **棚の一覧は `/api/state` に相乗りさせる。新しいGETルートを作らない**
   `statePayload()` に `references` を足す。プロジェクト切替・ターン後の再取得の配線に既に乗っており、
   棚だけのためのフェッチとエラー処理を増やさない。

2. **各エントリに `missing` を付ける**
   台帳はgit管理下、実体はuntracked。案ブランチへ `checkout` すると台帳だけが巻き戻り、
   逆にプロジェクトを配布すれば台帳だけが残って実体が無い状態が起きる。
   `existsSync` の結果を `missing: true` として返し、UIは「欠落」として出す（消さない）。
   **台帳に無い実体は一覧に出さない。** 台帳を唯一の真実にする。

3. **棚から外す = 台帳から消し、実体も消す**
   実体だけ残しても誰からも見えないゴミになる。`missing` のエントリを外す場合は台帳のみ消す。

4. **UIは 📎 ボタンのポップオーバー1枚。新しいパネルを作らない**
   同じ場所で「棚に足す」と「今回のターンに付ける」が済む。既存の送信前チップは選択状態の表示として残す。
   チャットへのD&D／paste は従来通り＝棚に入り、かつそのターンに添付済みになる。

5. **`duplicateProject` が実体をgitに入れてしまうのを直す**
   [server/project.mjs:873](../server/project.mjs) の `cp` は `references/` の実体もコピーし、
   直後の `git add .` でコピー先ではバイナリがコミットされる。既存のバグ。
   `filter` に「`references/` 直下で `index.json` 以外は複製しない」を足す。
   複製先では台帳だけが残り、全エントリが `missing` として出る（決定事項2の経路にそのまま乗る）。

## 変更対象

| 変更 | 場所 |
|---|---|
| `readReferences()` — `index.json` を読み、各エントリに `missing` を付けて返す | `server/project.mjs`（`importReference` の隣）|
| `removeReference(path)` — 台帳から除き、実体を `unlink`。`isReferencePath` で経路を検証 | `server/project.mjs` |
| `statePayload()` に `references: await readReferences()` | `server/local-api.mjs:96` |
| `POST /api/references/remove` と、ミューテーション許可リストの正規表現への追加 | `server/local-api.mjs:243`, `:329` |
| `agentInstructions` に「`references/index.json` が資料棚の目録である」旨を1文 | `server/project.mjs:94` 付近 |
| `duplicateProject` の `cp` filter | `server/project.mjs:873` |
| 棚の state 反映（`applyServerState` に `setReferenceShelf`） | `app/page.tsx:542` |
| 📎 ポップオーバー（一覧・チェックで添付・＋追加・×で棚から削除・欠落表示） | `app/page.tsx:2393` 付近 |
| `uploadReferences` が棚にも即反映する | `app/page.tsx:1368` |
| ポップオーバーのスタイル | `app/globals.css`（`.reference-attachments` の隣）|

`shared/context.mjs` は**変更しない**。envelope の `attachments` は今の形のままでよい。

## 進め方

- [x] `readReferences()` / `removeReference()`（`server/project.mjs`）
- [x] `statePayload()` への相乗りと `POST /api/references/remove`（`server/local-api.mjs`）
- [x] `agentInstructions` の1文（`server/project.mjs`）
- [x] `duplicateProject` の filter 修正（`server/project.mjs`）
- [x] 棚のクライアント状態と 📎 ポップオーバー（`app/page.tsx` / `app/globals.css`）
- [x] テスト
      - `readReferences` が実体の有無で `missing` を出し分ける
      - `removeReference` が台帳と実体の両方を消す／`references/` の外を指すパスを拒む
      - `duplicateProject` の複製先で `git ls-files references` が `index.json` だけを返す
- [x] `npm run typecheck` / `npm run lint` / `npm test`
- [x] 実機確認（前セッションで持ち込んだPDFが棚に残っている → チェックで再アップロードなしに添付できる）

## 確認結果

- `test` プロジェクトを開くと、前セッションでチャットに投げた `000981792.pdf`（1.1 MB）が棚に並ぶ。
  実装前に持ち込まれたファイルが、台帳だけを頼りにそのまま棚として読めている。
- チェックを入れると送信前チップが立ち、送信ボタンが有効になる。再アップロードは発生しない。
- Esc でポップオーバーが閉じ、フォーカスが 📎 に戻る（既存のポップオーバー契約どおり）。
- 型検査・Lint・ビルド・全154テストが成功。
- 削除・欠落表示・複製先のgit除外はユニットテストで確認（実機では他人の資料を消さないため未実施）。

## 成功条件

1. 資料を入れてページを再読込しても棚に残り、再アップロードせずに次のターンへ添付できる
2. Agentが添付なしのターンでも `references/index.json` を読んで「何があるか」を答えられる
3. 棚から外すと台帳・実体ともに消え、`/api/state` の一覧からも消える
4. 実体が無いエントリが「欠落」として出て、UIが壊れない（案ブランチ往復・プロジェクト複製の両方で確認）
5. プロジェクトを複製しても、複製先のgitに実体が1バイトも入らない
6. 添付なしのターンのプロンプトが、`agentInstructions` の1文以外は従来と変わらない

## 非スコープ

- 棚の中身のプレビュー・サムネイル
- 資料へのタグ付け、フォルダ、並べ替え、検索
- ワークスペースを跨いだ資料の共有（棚はプロジェクトに閉じる）
- Weave側でのPDF/pptxのテキスト抽出（従来通りAgentが自分で開く）
- 棚の実体を別ワークスペースからコピーしてくる導線

## 既知の穴

- 案ブランチで足した資料を `main` に戻ると、台帳から消えて実体だけがuntrackedで残る。
  決定事項2により一覧には出ないが、ディスク上には残り続ける。掃除の導線は本計画では作らない。
- 25MB上限・形式無制限は据え置き。棚に何十件も溜まったときの一覧の畳み方は、溜まってから考える。
