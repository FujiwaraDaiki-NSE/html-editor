# スライドテンプレート（型）の実装計画

要件と決定は [2026-08-07-slide-template-management.md](./2026-08-07-slide-template-management.md)。本書はその実装手順。

## 順序の考え方

型の適用（枠を差し替えてスロットの中身を移す）が本体だが、それには**スロットが存在すること**と**見た目が型から継承で降ってくること**の2つが前提になる。この2つは既存デッキ全体に波及するので、先に単独で片付けて見た目を確認する。

```
Phase 1  スロット導入 ＋ タイトル＝スライド名   ← 単体で価値が出る（二重入力が消える）
Phase 2  継承の土台                            ← 既存デッキの見た目が変わる。ここで実測
Phase 3  型を templates/ の実ファイルにする
Phase 4  型の変更（適用）＋ 確定前プレビュー     ← 本体
Phase 5  撤去と agent 連携
```

各Phaseはそれ自体でビルド・テストが通り、UIが壊れていない状態で終えること。

---

## Phase 1 — スロット導入とタイトルの一本化

### 変更

**`shared/tailwind-slide.mjs`**
- `migrateSlideHtmlToTailwind` に変換を追加
  - `.hero` を持つ要素に `data-weave-slot="content"` を付ける
  - タイトルスロットが無いスライドには、内容スロットの先頭の見出し（`h1.heading`）を1つだけ引き上げて `<div data-weave-slot="title">` として挿入する。見出しが無い場合は空のタイトルスロットを作る
  - 冪等であること（既にスロットがあれば何もしない）。既存テスト [tests/content-policy.test.mjs:82](../tests/content-policy.test.mjs) と同じ基準

**`app/page.tsx`**
- `blankSlideHtml`（:133）を2スロット構成に
- `addBlock`（:801）の挿入先を `.hero` 決め打ちから `[data-weave-slot="content"]` に変更。`.hero` へのフォールバックは移行が済むまで残す
- タイトル ⇄ スライド名の同期
  - 読み込み経路（:353 と :1090）で、HTMLのタイトルスロットのテキストを `slide.title` に反映する（HTMLが真実）
  - `syncFromDom` でタイトルスロットのテキスト変化を拾い、`slides[].title` を更新する
  - インスペクタの `Title` 欄（:1780）の `onChange` を、`renameSlide` からタイトルスロットのDOM書き換え＋`syncFromDom` に変える
  - フィルムストリップは空タイトルのとき `Untitled` を表示
- タイトルスロットを保護する
  - `outline`（オブジェクトツリー）には出すが `draggable` を外す
  - `deleteSelected`（:840）と `onTreeDrop` でタイトルスロットを対象外にする
  - `canDropInTree` でタイトルスロットの内側を drop 先にしない

### テスト

- `tests/slide-design.test.mjs` — 移行の冪等性、見出しの引き上げ、見出しが無いスライドの扱い
- 新規 — タイトル同期（HTML→title、title→HTML、空タイトル）

### 確認

- タイトルをキャンバス側で編集してフィルムストリップの名前が変わること、逆方向も
- タイトルスロットが削除・ドラッグできないこと
- 既存デッキを開いて移行が1度だけ走り、2回目の起動で差分が出ないこと

---

## Phase 2 — 継承の土台

**このPhaseだけ既存デッキの見た目が変わる。** 単独のコミットにして、前後のスクリーンショットを残す。

### 変更

**`shared/tailwind-slide.mjs`**
- `buildTailwindSlideCss`（:224）の**ユーティリティ列より前**にベース層を追加

  ```css
  .weave-slide :where(h1, h2, h3, p, ul, ol) { margin: 0; font-size: inherit; font-weight: inherit; }
  ```

  `:where()` で詳細度0にするので、後続のユーティリティが必ず勝つ。順序でしか勝負が付かない箇所なので、**ベース層が先・ユーティリティが後**を崩さないこと
- `defaultSlideClasses`（:221）に本文の既定書式（`text-lg` 相当）を持たせ、ルートから配る
- `migrateSlideHtmlToTailwind` に「旧デフォルトと**完全一致する**色・文字サイズのクラスだけを落とす」処理を追加。ユーザーが変えた値は個別指定として残す

**`app/page.tsx`**
- `blockTemplates`（:91）から色・文字サイズを除去。構造と、その種類固有の意味を持つクラス（`font-semibold` `tracking-tight` など）は残す
- `slideControlGroups` の継承する各グループ（fontSize / fontWeight / lineHeight / color / textAlign / listMarker）に `className: ""` の選択肢を先頭に追加
  - ラベルは継承するプロパティは「継承」、しないものは「なし」
- `setUtility`（:859）に空文字ガードを1行足す（`classList.add("")` は例外を投げる）

### 影響の見積り

見出しと本文の間は現在、`h1` の margin(0.67em ≒ 40px) ＋ `gap-6`(24px) ＋ `p` の margin(1em ≒ 18px) が三重に効いている。リセット後は gap の24pxだけになるので**縦に詰まる**。余白の出どころが gap 一本になり、インスペクタの Gap が素直に効くようになる。

### テスト

- 生成CSSでベース層がユーティリティより前にあること
- 移行で旧デフォルトのみが落ち、変更済みの値が残ること、冪等であること
- 「継承」を選ぶとクラスが外れ、再度読むと「継承」が返ること（往復不変）

### 確認

- **ブラウザで前後比較**。既存デッキを開き、詰まり方が許容範囲か目視する
- 色やサイズを個別に設定 → 「継承」で解除 → 型の値に戻ること

---

## Phase 3 — 型を実ファイルにする

### 変更

**`server/project.mjs`**
- `templatesRoot = join(projectRoot, "templates")` を追加
- `readTemplates()` — `templates/*.html` を読む。名前と役割はファイル自身の属性で持ち、マニフェストは増やさない

  ```html
  <main class="weave-slide …" data-weave-template="title-page" data-weave-template-name="表紙">
  ```
- `ensureProject`（:518）で、既存の3背景（orbit / grid / plain）を初期の型として `templates/` に書き出す。`styles/deck.css` を正準へ書き直す既存処理（:534）と同じ形で、無ければ作る・違えば直す
- `writeProject`（:242）のトランザクションに `templates/` を含める
- `commitIfChanged`（:332）の対象パスに `templates` を追加
- `templates/*.html` も `auditContentPolicy` と `auditTailwindSlideHtml` を通す

**`server/local-api.mjs`**
- `/api/state` の返却に型の一覧を含める

**`app/page.tsx`**
- スライドの `<main>` に `data-weave-template` で出自を記録する
- インスペクタの `SLIDE BACKGROUND` セクション（:1783）を `SLIDE LAYOUT` に置換。現在の型名を表示し、押すと一覧
- 一覧は**実HTMLをそのまま縮小表示**する（サムネイル画像は生成しない）

### テスト

- `tests/project-transaction.test.mjs` — `templates/` を含む保存のロールバック
- 型の初期書き出しが冪等であること

---

## Phase 4 — 型の適用

ここが本体。

### 変更

**`app/page.tsx`**
- `applyTemplate(templateId)`
  1. `checkpoint()`
  2. 型のHTMLをパースし、現スライドの2スロットの中身（`innerHTML`）を新しい枠のスロットへ移す
  3. `<main>` のクラスと `data-weave-template` を新しい型のものに差し替える
  4. `data-weave-id` は保持する（選択状態とUndoの一貫性のため）
  5. `syncFromDom()`
- 新規スライド作成を `addSlide`（:952）から「型を選んで空のスライドを作る」に変更。フィルムストリップの「＋」で型を選ぶ
- **確定前プレビュー** — 一覧の候補にホバー／選択でキャンバスに当てた状態を表示し、Esc または選択解除で元に戻す。`checkpoint()` はクリックで確定したときだけ呼ぶ。プレビュー中は `syncFromDom` を走らせない

### テスト

- 型を変えても2スロットの中身が保たれること
- 型を変えて元に戻すと元のHTMLに一致すること（往復不変）
- プレビューを中断したときに何も保存されていないこと（`saved` フラグと履歴が動かない）

### 確認

- 3種類の型を順に当てて、中身が消えないこと
- Undo一発で型変更前に戻ること

---

## Phase 5 — 撤去と agent 連携

### 変更

**`app/page.tsx`** — 旧 Slide library を撤去
- `templateKey` / `templateStore`（:66-82）、`saveSlideTemplate`（:1006）、`insertTemplate`（:1012）
- ツールバーの `Save template` / `Library`（:1637）とモーダル（:1848）
- 背景選択の残骸（`backgrounds` / `backgroundClasses` / `setSlideBackground` :903）
- 旧 `localStorage` のデータは移行しない（中身入りのコピーで、型とは別物のため）

**`server/project.mjs`**
- `agentInstructions`（:23）に追記
  - `templates/<id>.html` が型であること
  - スライドは `data-weave-slot="title"` と `data-weave-slot="content"` を持ち、タイトルスロットのテキストがスライド名であること
  - 見た目は型から継承するので、ブロックに色や文字サイズを書かないこと
  - 型を変えるときはスロットの中身を移すこと

これで「この型で5枚作って」がagentに通るようになる。

---

## 進め方

- 作業ブランチから worktree を作り、Phase ごとにコミットして作業ブランチへマージする
- 各Phaseの完了条件: `npm run build` / lint / 型チェック / 既存テストが緑、かつ上記の「確認」を実施
- Phase 2 は見た目が変わるので、マージ前に必ず目視確認を挟む

## 実装の記録（2026-08-08 完了）

5つのPhaseをこの順にコミットし、各Phaseで `npm run test:unit` / lint を通した。最後に `npm run build` を確認。計画と変えた点だけ残す。

**Phase 1 — 移行の当て先が実物と違っていた。** 計画は `.hero` と `h1.heading` を前提にしていたが、`workspaces/northstar` の4枚はどちらも持っていない（agentが書いたHTMLで、内容領域は `flex-1` を持つ素の `<section>`、見出しは素の `<h1>`）。`.hero` → 無ければ `<main>` 直下の `flex-1` を内容スロットとし、見出しはクラスを問わず最初の `<h1>` を拾う。

**見出しは持ち上げず、その場に印を付ける。** 内容領域は `justify-center` で子を中央に寄せるので、見出しを `<main>` 直下に出すとブランド行の直下に隙間なく貼り付き、seededデッキでは eyebrow が見出しの下に回る。Phase 1 は見た目を変えない約束なので、位置を動かすのは型を当てるとき（Phase 4）の仕事にした。タイトルは移動・削除だけを禁じ、その前後にブロックを置くことは許す。

**Phase 2 — 落とせたのは heading と paragraph だけ。** 理由は要件側 D4 に追記した。タイトルスロットも、型が寸法を持つようになるまでは自前のクラスを保つ。ルートには `text-lg` と併せて `leading-normal` を置く。`text-lg` の行高は `1.75rem` という絶対値で、継承させると72pxの見出しが28pxの行に潰れるため。

**Phase 3 — `writeProject` のトランザクションには入れていない。** クライアントから型を書く経路がこのPhaseに無く、書き手のいないディレクトリのロールバックを作ることになるため。読み・初期書き出し・コミット・監査だけを入れた。UI（`SLIDE LAYOUT`）は、選んでも何も起きない状態を作らないようPhase 4へ寄せた。

**Phase 4 — 差し替えはHTML文字列に対する純粋関数にした**（`shared/slide-slots.mjs` の `applyTemplateToSlideHtml`）。コンポーネント内のDOM操作にするとブラウザ無しでは試せない。スロット探索のヘルパは移行処理と共有している。プレビューは注入用のrefに載せ、`slides` state を一切通さない。

**Phase 5 — `localStorage` の中身は捨てた。** 要件 未決4 の結論。

### 確認したこと

実物の4枚を、変更前のコードと変更後のコードでそれぞれ描画して並べた。Phase 2 は計画どおり縦に詰まるだけで、文字寸法・色・アクセントは保たれる。型の適用は4枚すべてで内容（SVG図、表、カード、リスト）が消えずに移り、背景・ブランド・ページ番号・タイトルの書式が新しい枠のものに入れ替わる。

キャンバス上での操作（プレビューのホバーとEsc、適用のUndo、フィルムストリップの＋）はエディタを起動しての確認が残っている。開発サーバのポート（3000 / 4317）が使用中だったため。

## このPhaseでは扱わないもの

- 型の追加・リネーム・削除UI（ファイルを置けば増える。要件 未決2）
- 複数スライドへの一括適用（フィルムストリップに複数選択の仕組みが無い）
- アクセントカラーの継承化（`--weave-accent` は既にあるが、`setSlideAccent` の全子孫書き換え方式の置き換えは別件）
- 型ごとの背景装飾を増やす手段（要件 未決1。推奨は inline SVG）
- ページ番号 `01 / 01` の再採番（型の枠が持つ要素になるので、Phase 3 で触るなら一緒に直してもよい）
