# スライド表現力の拡張プラン

作成日: 2026-08-07
前提: concept.md 2.9〜2.11（HTMLが単一の真実／固定1280×720／サイズは意図で持つ）。
対象: 画像・箇条書き・レイアウト・装飾・表・インライン強調・グラフ。

## 0. この計画の前提となる構造

`styles/deck.css` は `buildTailwindSlideCss()` の生成物で、`writeProject` は内容が一致しない保存を
拒否する（[project.mjs:229](../server/project.mjs)）。つまり**スライドに新しい見た目を足す唯一の入口は
`shared/tailwind-slide.mjs` のレジストリ**であり、そこから4つの消費先が同時に動く。

| 消費先 | 何が起きるか |
|---|---|
| `buildTailwindSlideCss()` | 実際のCSS宣言が出る |
| `allowedSlideClasses` | 監査を通るクラスが増える（未登録クラスは保存時エラー） |
| インスペクタ | `slideControlGroups` + control keys がUIになる |
| AGENTS.md | agentが使ってよい語彙 |

**表現力＝この語彙の大きさ**。以降の各フェーズは「レジストリに何を足すか」＋「それをUIのどこに出すか」で書く。

現状のポリシーは意外に緩い。実測（`auditContentPolicy`）で確認済み:

| 入力 | 結果 |
|---|---|
| クラスの無い `<svg>` / `<table>` / `<ul>` | **通る** |
| 未登録クラスを付けた同上 | エラー（`design.unknown-class`） |
| `style=` 属性 | エラー（`design.inline-style`） |
| 外部URL・`<script>`・`on*` | エラー |

したがって不足は「禁止されている」ことではなく、**語彙が無い／挿入UIが無い／デッキのCSSが面倒を見ない**の3点。

## 1. フェーズ一覧

| # | 内容 | 主な追加語彙 | 新規インフラ | 規模 |
|---|---|---|---|---|
| 1 | 画像 | `object-*` `aspect-*` | assets配管（唯一の新規） | 大 |
| 2 | 箇条書き | `list-*` `pl-*` | なし | 小 |
| 3 | レイアウト（比率・grid列・span） | `basis-*` `grid-cols-*` `col-span-*` | なし | 中 |
| 4 | 装飾と表 | `border*` `bg-*`露出 `rounded-*`露出 `mt-*`露出 | なし | 中 |
| 5 | インライン強調 | なし（既存クラスを部分適用） | 選択範囲へのラップ処理 | 中 |
| 6 | グラフ（SVG） | **なし** | なし | 極小 |

フェーズ6は語彙追加ゼロで済むので、**いつ着手してもよい**（実質AGENTS.mdとテストだけ）。
それ以外は 1 → 2 → 3 → 4 → 5 の順を推奨。理由は価値の大きさと、4が3の語彙を再利用するため。

---

## 2. フェーズ1: 画像

スライドツールとして最も欠けている機能。ポリシーは相対パスと data URI を既に許可している
（[content-policy.test.mjs:55](../tests/content-policy.test.mjs)）ので、必要なのは配管とUI。

### 2.1 assets配管（このプランで唯一の新規インフラ）
- プロジェクト内に `assets/` を新設。`POST /api/assets` を追加し、受け取った画像を
  `assets/<内容ハッシュ>.<ext>` として書く。同一内容の再取り込みは同じパスに落ちる（重複排除）。
- `writeProject` のトランザクションは `slides/` ディレクトリごと rename する方式なので、`assets/` は
  その外側にあり影響を受けない。**保存トランザクションの変更は不要**。
- 受け付けるのは png / jpeg / webp / svg / gif。SVGは `<script>` を含みうるので、取り込み時に
  `auditHtmlSafety` を通してから書く。
- 上限サイズを決める（例: 1ファイル10MB）。gitに乗るので、超過は明示エラーにして黙って通さない。

### 2.2 ブロックとUI
- `blockTemplates.image`: `<img class="image w-full rounded-lg" src="assets/…" alt="" data-weave-id="…">`
- 取り込み経路は3つ: キャンバスへのドロップ、ペースト、Add block → Image のファイル選択。
  ドロップ位置はブロックのドロップインジケータをそのまま使う。
- インスペクタに `IMAGE` セクション（`containerLike` と同じ分岐で kind === "image" のとき）:
  **Fit**（Cover / Contain）／**Aspect**（16:9 / 4:3 / 1:1 / Auto）／**Radius**／**Alt text** 入力欄。
- Alt は必須にしない。ただし空のまま保存できることは受け入れ、警告は出さない（品質ゲートを騒がしくしない）。

### 2.3 語彙追加
`object-cover` `object-contain` `object-center`、`aspect-video` `aspect-square` `aspect-auto`、および
`rounded-*`（既存）のUI露出。任意値記法（`aspect-[4/3]`）は監査で弾かれるので、4:3が要るなら
名前付きの1エントリとしてレジストリに足す。Fill/Hug/Fixed の意図モデルは
`<img>` にもそのまま効く（flexアイテムなので `flex-1` / `flex-none` が有効）。高さは Aspect で決める。

### 2.4 決めきっていない点
- 画像の差し替え（同じブロックのsrcを変える）UIは、Alt欄の隣に「Replace」ボタンで足りるか。
- assets の孤児回収。どのスライドからも参照されなくなったファイルを消すかどうかは、保存が
  git コミットである以上「消さない」で始めてよい（履歴から復元できる）。

---

## 3. フェーズ2: 箇条書き

- `blockTemplates.list`: `<ul class="list list-disc pl-6 text-lg leading-normal text-slate-300" data-weave-id="…"><li>…</li></ul>`
- 語彙追加: `list-disc` `list-decimal` `list-none` `pl-6` `pl-8`。
- インスペクタ: TEXT の既存コントロール（Size/Weight/Leading/Align/Color）は `ul` に効くのでそのまま使える。
  加えて **Marker**（Bullet / Number / None）の1行を TEXT セクションに追加。
- 編集は contenteditable。Enterで `<li>` が増えるのはブラウザ既定の挙動に乗る。
  ただし現行のテキスト編集は「改行＝`<br>`」を前提にしている（[html-format.mjs:8](../shared/html-format.mjs)）ので、
  **リストだけは Enter を `<br>` に変換しない**分岐が要る。ここが唯一の実装上の注意点。
- `<li>` は `data-weave-id` を持たせない。オブジェクトツリーに項目が並ぶと木が荒れるだけで、
  移動も削除もテキスト編集で足りる。

---

## 4. フェーズ3: レイアウト

### 4.1 比率分割（Row限定）
現状 Row の子は `flex-1`（Fill）か `flex-none`（Hug）の二択で、60:40 が表現できない。

- `sizeIntents` に4つ目 **Ratio** を追加。書き込みは `flex-none basis-1/2` の形。
- 分数は Fixed の Measure と同じ流儀で、**Ratio を選んだときだけ直下にインライン**で
  1/4・1/3・1/2・2/3・3/4 を出す（concept 2.11 決定B）。
- `readSize` は `basis-*` を `max-w-*` より先に見て `ratio` を返す。**往復不変**（`applySize`→`readSize` で
  同じ意図が返る）はここでも絶対条件で、既存テストを3意図×2軸から4意図に広げる。
- **Ratio は親が Row のときだけ出す**。Column では `basis` は高さになり、固定キャンバス上で
  意味が変わってしまうため。Column と grid では Width 行に Ratio を並べない。

### 4.2 grid の列数と span
- Direction に第3の選択肢 **Grid** を追加し、`setDirection` を `flex` / `flex-row` / `flex-col` /
  `grid` / `grid-cols-*` を**排他で書き換える**実装にする。
  → これで [TASK.md](../TASK.md) の「metrics の Direction が display を壊す」既存不具合が同時に解消する。
  metrics は列数固定のブロックではなく、単に Grid 方向のコンテナとして扱えるようになる。
- Direction = Grid のときだけ直下に **Columns**（2 / 3 / 4）を出す。語彙は `grid-cols-2/3/4` が既にCSSにある。
- grid の子には Width 行の代わりに **Span** 行を出す（`col-span-2` `col-span-3` `row-span-2` を追加）。
  これで「大1つ＋小3つ」の非対称グリッドが作れる。concept 2.11 の残課題「gridセルにサイズを付ける
  手段がない」に対する回答もこれで足りる（Measure を戻すのではなく Span を与える）。

### 4.3 上の余白
`mt-2/4/6/8` は既にCSSにあるがUIに無い。BLOCK セクションに **Space above**（0/2/4/6/8）を1行追加する。
`px-*` `py-*` の個別パディングは足さない（3節「やらないこと」参照）。

---

## 5. フェーズ4: 装飾と表

囲みと表は同じ材料（border語彙）で解けるので1フェーズにまとめる。

### 5.1 装飾
- 語彙追加: `border` `border-2` `border-t` `border-b` `border-slate-700` `border-slate-300`
  `border-transparent`、`bg-transparent`。`bg-slate-800/900/950` `bg-white` `rounded-md/lg/xl`
  `shadow-lg` は**既にCSSにあるのでUIへ露出するだけ**。
- インスペクタ CONTAINER セクションに **Background** / **Border** / **Radius** / **Shadow** を追加。
  これでカード・囲み枠・区切り線（`border-t` だけの空Row）が作れるようになる。

### 5.2 表
- 語彙追加: `border-collapse`（`border-collapse: collapse`）。セルは既存の `p-2` `text-left` `text-sm`
  `border-b` で足りる。
- `blockTemplates.table`: 2列×3行（`<thead>` 1行＋`<tbody>` 2行）の雛形。`<table>` に `data-weave-id`、
  セルには振らない。
- インスペクタ `TABLE` セクション: **行を追加 / 削除**、**列を追加 / 削除** の4ボタンのみ。
  セル内容は contenteditable で編集する。それ以上の表機能（結合・整列・幅指定）は持たない。
  複雑な表が要るときは agent に書かせる方が速い。
- ベースCSSにtable系の宣言が無いままだとUA既定で描かれるので、雛形が `border-collapse` と
  セルクラスを必ず伴うことが表の見た目の担保になる。

---

## 6. フェーズ5: インライン強調

段落中の一語だけ色や太字にする手段が今は無い（`metrics` だけが例外的に `strong`/`span` を持つ）。

- contenteditable 中の選択範囲を `<strong>` または `<span class="text-amber-400">` で包む処理を実装。
  `document.execCommand` は使わず、Range に対して自前でラップ/アンラップする。
- 出せるのは **Bold** と **Accent color** の2つだけにする。Cmd+B と、インスペクタ TEXT セクションの
  「選択中の文字に適用」ボタン。フローティングツールバーは作らない。
- 既存の `metrics` が `strong`/`span` で問題なく往復しているので、フォーマッタ（Prettier,
  `htmlWhitespaceSensitivity: "css"`）はインライン要素の空白を保つ。ただし Prettier が見るのは
  **既定のdisplay**であってこのプロジェクトのCSSではないため、インライン要素に `flex` 等の
  displayを変えるクラスを付けた場合だけ空白の扱いが変わりうる。テストで固定する。

---

## 7. フェーズ6: グラフ（語彙追加ゼロ）

`<script>` は禁止（[content-policy.mjs:67](../shared/content-policy.mjs)）なので、ランタイム描画は原理的に不可。
これは意図した設計で維持する。残る道は静的SVGで、**クラスを付けなければ今日でも保存を通る**（実測確認済み）。

不足しているのは2点だけで、どちらも語彙追加を伴わない:

1. **色がアクセントに追随しない** — `--weave-accent` は定義済み（[tailwind-slide.mjs:181](../shared/tailwind-slide.mjs)）
   なのに、SVGからは `fill="#fbbf24"` とハードコードするしかない。`fill="currentColor"` を使えば
   既存の `text-*` クラスで色が決まり、アクセント切替にも追随する。**規約で解決する**。
2. **サイズの指定手段** — `style` 禁止のため、フェーズ1で入る `aspect-video` と既存の `w-full` を使う。

対応は AGENTS.md への追記のみ:
「グラフや装飾図形は `<svg>` を直接書く。色は `fill="currentColor"` と `text-*` クラスで指定し、
生の16進数を書かない。サイズは `w-full` + `aspect-*` で決め、`width`/`height` 属性に頼らない。
SVGルートには `data-weave-id` を付け、人間が選択・移動できるようにする。」

人間向けのSVG編集UIは作らない。中身はagentが書き、人間はブロックとして位置とサイズだけ触る。

---

## 8. 横断的に触るもの

- **`shared/tailwind-slide.mjs`**: 全フェーズの本体。語彙が約1.7倍になるが、生成される deck.css は
  数KB増える程度で問題にならない。
- **`server/project.mjs` の `agentInstructions`**: 新語彙、SVG規約、リスト/表の書き方、`assets/` の
  参照方法を追記。
- **`migrateSlideHtmlToTailwind`**: 変更不要。新語彙は既存デッキのHTMLに現れない。
- **テスト**: `tests/slide-design.test.mjs` に往復不変の拡張（4意図×2軸）、`content-policy.test.mjs` に
  新語彙と img/table/ul/svg のケース、assets エンドポイントのテストを追加。
- **`readSelection` の kind 判定**（[page.tsx:257](../app/page.tsx)）: `image` `list` `table` を配列に足す。
  ここは文字列配列のハードコードなので、フェーズごとに追記漏れが起きやすい。ブロックレジストリから
  導出するように直しておくと以降の追加が data だけで済む。

## 9. やらないこと（と、その理由）

- **フルブリード画像・重ね合わせ** — `absolute inset-0` を任意ブロックに許すと、フロー保証
  （concept 2.6「自由配置は採用しない」）が崩れる。全面写真は concept 2.7 の**背景レイヤー側の
  拡張**として扱うのが筋で、コンテンツ側の語彙には入れない。大きく画像を見せる用途は
  フェーズ1の Fill + Aspect で足りる。
- **`px-*` / `py-*` の個別パディング** — Padding（全辺）＋ Gap ＋ Space above で実用上は足りる。
  4辺個別まで開くとインスペクタが CSS の写経になる。詰まってから足す。
- **表の高度な機能（セル結合・列幅・整列）** — agent に書かせる方が速い領域。
- **チャートライブラリ** — `<script>` 禁止は維持する。
- **語彙の任意値化（`[...]`）** — 監査で弾く方針を維持。任意値を許すとレジストリが真実である
  という前提そのものが消える。
