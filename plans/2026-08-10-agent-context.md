# agentへ渡すコンテキスト 再設計 実装計画

作成日: 2026-08-10
関連: [concept.md](../concept.md) 2.1 / 2.5 / 2.10、[docs/annotation-layer-design.md](../docs/annotation-layer-design.md) D2 / D4

## 進め方

- 作業ブランチは `feat/annotation-layer`。**ユーザーはこのブランチだけを見る**
- 各フェーズはworktree（`../html-editor.worktree/`）で実装し、完了時に作業ブランチへマージ
- 実装はcodexに任せ、こちらは成果物をレビューする
- フェーズ内でも細かくコミットする

### モデルの目安

| フェーズ | 難易度 | 理由 |
|---|---|---|
| P1 | 高 | 書き込み経路の分岐を増やす。トランザクションとポリシーゲートに触れる |
| P2 | 中 | 撤去作業。参照箇所の洗い出しが主 |
| P3 | 中 | 純関数の切り出しと配線。仕様が確定している |
| P4 | 中 | DOM計測。既存の `liveAnnotationBoxes` に相乗り |
| P5 | 低 | 既存経路への穴埋め |

---

## 1. 目的

agentへコンテキストを渡す経路が4つあり、役割の割り当てが決まっていない。同じスライドHTMLが3経路（envelope・`current-buffer.json`・注釈の `target.html`）で届き、不変のCSSが毎ターン12.7KB載り、「真実」の宣言が2箇所にある。1ターンあたりの envelope は約18KB。

原因は、注釈レイヤーだけがコンテキストのパイプライン（`shared/annotation.mjs` にスキーマとプロンプト規則を対で持ち、テストと設計文書がある）を持っていて、それ以外は場当たりに生えたことにある。

## 2. 決定：経路を「そこでしか運べないもの」で分ける

圧縮とは情報量を減らすことではなく、**冗長な経路を消して、その経路でしか運べないものだけを残す**こと。この基準で3層に割り当てる。

| 層 | 運ぶもの | 根拠 |
|---|---|---|
| **契約**（スレッド開始時・不変） | 編集契約。`baseInstructions` | 変わらないものを毎ターン運ばない |
| **データ**（agentが取りに行く） | `slides/*.html`、`.weave/deck.json`、`styles/deck.css`、`templates/`、`assets/`、git履歴 | ファイルにある。agentは読める |
| **視点**（毎ターン渡す） | 選択・注釈・破綻シグナル | ブラウザにしか無い |

目標は envelope 1KB未満（現状 約18KB）。

### D1: ライブDOMは「送信の瞬間に」ファイルへ落とす

agentの書き込み先はファイルしかない。ライブDOMを読ませると、読んだ文字列（`clone.outerHTML`）と書く先（prettier整形済みファイル）が食い違い、**読みと書きのチャネルが割れる**。`formatSlideHtml` は人間の保存経路とagentの直接書き込みの両方を通して乖離を防ぐために置かれている（[shared/html-format.mjs](../shared/html-format.mjs) 冒頭コメント）。ファイルはDOMとは別物ではなく、**DOMを正規形に落としたもの**である。

またライブDOMはアクティブスライド1枚しか持たない。他スライド・テンプレート・CSS・履歴は全部ファイルにしかないので、DOMを主にしても読み口が2つに増えるだけになる。

2.10 で「真実は `slides/*.html`、人間はライブDOM上で編集し保存時に同じファイルへ書き戻す」と決めた線をそのまま使う。**変えるのは書き戻す頻度だけ**：保存ボタンのときだけでなく、チャット送信のときにも書く。

### D2: `.weave/current-buffer.json` は廃止する

これは「未保存状態もagentに見せたいが `slides/*.html` は保存ボタンの持ち物にしたい」の折衷として生えたもので、結果としてagentは **Aを読んでBを編集する**ことになっていた。D1でファイルが常に送信時点のキャンバスと一致するので、存在理由が消える。

真実の宣言が1つになる（現状は `baseInstructions` が「buffer が authoritative」、envelope ヘッダが「envelope が authoritative」と二重）。

### D3: envelopeは許可リストで組み、HTMLとCSSを載せない

現状はクライアントが送ってきたオブジェクトをサーバが素通しで `JSON.stringify` している（[server/local-api.mjs:106](../server/local-api.mjs)）。フィールドの検証もバージョンもなく、外側の `.slice(0, 120_000)` は整形済みJSONを途中で切るので**壊れたJSONがそのままプロンプトに載る**。

`shared/context.mjs` を新設し、注釈と同じ形（envelope生成関数＋プロンプト規則＋テスト）で持つ。

| 落とすもの | 理由 |
|---|---|
| `activeSlideHtml`（最大30KB） | ファイルにある（D1） |
| `css`（12.7KB） | `styles/deck.css` は生成物・編集禁止・不変。契約に「登録簿はここ」と1行書けば足りる |
| 注釈の `target.html` | 同上。`weaveId` で引ける。D4は元々「idと食い違ったらid優先」としている |
| `revision` | 保存の楽観ロック用の値。モデルには無意味 |
| `selected.label` | `kind` の複製 |

| 足すもの | 理由 |
|---|---|
| `slide`（スライドid） | 現状は番号でファイル名に解決できない |
| `selected.text` | 短い抜粋。何を指したかがその場で読める |
| 注釈の `elementKind` / `textExcerpt` | すでに取得済みなのに envelope で落としていた |
| `overflowing`（P4） | HTMLから復元できない唯一の情報 |

### D4: steer中はファイルを書かない

steer時はagentがファイルを編集中なので、人間側のDOMを書き込むとagentの作業を潰す。steerで運ぶのは「どこを指しているか」であって「何を編集したか」ではない、と割り切る。

ターン中の人間の編集はもともと 2.1 で「保存前バッファは一切保護しない／無条件上書き」と決めており、新しい欠落ではない。

### D5: 破綻シグナルはpushする（pullしない）

レンダリング結果（実座標・はみ出し）はDOMにしか無く、agentはブラウザを持たないので自力では取れない。スライドエディタでは「1行に収まったか」が品質そのものなので、これは渡す価値がある。

運び方は2つある。

- **push** — envelopeに毎ターン載せる。数十バイト、既存経路のまま
- **pull** — 計測用エンドポイントを生やし、agentが要るときだけ聞く

いまは push を採る。ブラウザまで往復する経路の新設に見合うほど幾何の要求が無い。増えたら pull へ上げる。

**マークアップの経路は増やさない。** ライブDOMに値打ちがあるのは計測としてであって、2つ目のマークアップ供給源としてではない（D1）。

### D6: ポリシー検査はコミットの門であって、書き込みの門ではない

D1でチャット送信時にもファイルを書くことになるが、`writeProject` は content-policy 監査と `deck.css` 検査を抱えている（[server/project.mjs:331](../server/project.mjs)）。このまま呼ぶと、違反した状態のときに **`codex.startTurn` へ到達する前に422で落ち、「直して」という依頼自体がagentに届かない**。

そもそもこのゲートは `slides/*.html` を守れていない。agentは自分のファイル編集ツールで直接書くので `writeProject` を通らず、違反HTMLは普通にファイルに入る。実際そうなっていて、ターン完了処理の `writeProject` がそこで初めてゲートに当たり `{status: "error"}` を publish して終わる（[server/local-api.mjs:155](../server/local-api.mjs)）。ファイルは違反したまま残り、**更新後のデッキがクライアントへ届かないので人間は結果を見ることすらできない。**

ゲートが実際に守っているのは **commit（保存ボタンとvariation確定）だけ**である。ならば書き込み経路ではなくコミット経路に置く。

副次的に次が直る。

- 違反した生成結果もキャンバスに出る。`quality` 表示（[app/page.tsx:434](../app/page.tsx)）が違反を指し、保存だけが止まる。**直す前に見られる**
- agentが直接書いたときと、Weaveが人間のDOMを書いたときで、同じファイルに違う基準がかかる不整合が消える

---

## P1: 書き込みとゲートを分け、ターン開始でスライドファイルまで書く

**やること**

- `writeProject` からポリシー検査と `deck.css` 検査を外す（[server/project.mjs:331](../server/project.mjs)）。**書くだけの関数**にする
- 外した検査を `assertCommittable()` として切り出し、**コミットの直前**で呼ぶ。コミット経路は2つだけ
  - `/api/save`（[server/local-api.mjs:226](../server/local-api.mjs)）
  - variation完了時の `commitIfChanged`（[server/local-api.mjs:160](../server/local-api.mjs)）
- `writeProject` の `bufferOnly` 引数を落とし、`/api/codex/turn/start` でスライドファイルまで書く（[server/local-api.mjs:280](../server/local-api.mjs)）
- `/api/codex/turn/steer` はファイルを書かない。理由をコメントで残す（D4）

**確認すること**

- 起動時の seed / legacy migration も `writeProject` を通る（[server/project.mjs:586](../server/project.mjs) 他）。ゲートが外れると、違反を含む既存プロジェクトでも起動できるようになる（改善方向）
- ターン開始でファイルを書くと作業ツリーが未コミットになる。checkout系は `activeProjectTurn()` でガード済み（[server/local-api.mjs:235](../server/local-api.mjs)）。通常ターンは完了後もコミットしないので今も未コミットにはなっており、新種の状態ではないことを確認する
- ターンが起動に失敗した場合、書き込んだファイルは残る。これも既存挙動と同じであることを確認する

**テスト**

- ターン開始後、`slides/*.html` が送信したキャンバス内容と一致する
- ポリシー違反のHTMLでもターンは開始でき、キャンバスにも反映される
- `/api/save` は従来どおり422で弾く
- 違反したvariationはコミットされない
- steerはファイルを書かない

**コミット単位**: ゲートの切り出し / コミット経路への配置 / `bufferOnly` の撤去とturn startの切り替え / テスト

---

## P2: `.weave/current-buffer.json` の撤去

**やること**

- `agentInstructions` から「Before editing, read .weave/current-buffer.json …」を削除し、真実の所在を `slides/*.html` に一本化する（[server/project.mjs:69](../server/project.mjs)）
- `bufferPath` / `bufferJson` を撤去する。P1で `bufferOnly` が落ちているので、`writeProject` の引数は `expectedRevision` だけになる
- `excludeCurrentBuffer()` と `ensureProject` の関連migrationを撤去（[server/project.mjs:533](../server/project.mjs)）
- `commitPaths` の `.weave/current-buffer.json` 特別扱いを撤去（[server/project.mjs:411](../server/project.mjs)）
- `workspaces/northstar/.weave/current-buffer.json` を削除
- `.git/info/exclude` の後始末は不要（無害な残骸として残す。新規プロジェクトには書かれなくなる）

**確認すること**

- `tests/project-transaction.test.mjs` と `tests/architecture.test.mjs` の参照を洗う
- ターン完了時の `readProject()` → `writeProject()`（[server/local-api.mjs:155](../server/local-api.mjs)）がそのまま成立すること

**コミット単位**: 契約文の更新 / project.mjsの撤去 / ワークスペースの掃除 / テスト

---

## P3: envelopeの圧縮

**やること**

- `shared/context.mjs` を新設する。持つもの:
  - `editorEnvelope(input)` — 許可リストで組む。D3の表のとおり
  - `contextPromptRules` — envelopeの読み方（`slide` はファイル名、`selected.id` は `data-weave-id`）
- `app/page.tsx:423` の `contextEnvelope()` を `shared/context.mjs` へ寄せる。`page.tsx` 側は値を集めるだけにする
- `serializeEditorContext`（[server/local-api.mjs:106](../server/local-api.mjs)）を `shared/context.mjs` 経由にし、`.slice(0, 120_000)` を撤去する（小さくなるので不要）
- `baseInstructions` に「使えるユーティリティクラスの登録簿は `styles/deck.css`。必要なら読め」を追記
- `annotationEnvelope`（[shared/annotation.mjs:103](../shared/annotation.mjs)）から `target.html` を外し、`elementKind` と `textExcerpt` を載せる
- [docs/annotation-layer-design.md](../docs/annotation-layer-design.md) D4 を更新する（`html` を持つと書いてある）

**テスト**

- envelopeにスライドHTMLとCSSが含まれない
- `slide` がスライドidであり、`slides/<id>.html` に解決できる
- envelopeが1KB未満（northstarの典型的な選択＋注釈2つで測る）
- 許可リストに無いフィールドは落ちる

**コミット単位**: shared/context.mjs新設 / page.tsx側の差し替え / server側の差し替え / 契約文の追記 / 注釈envelopeの変更 / 設計文書の更新 / テスト

---

## P4: 破綻シグナル

**やること**

- ライブDOMからしか取れない情報を envelope に足す。`liveAnnotationBoxes()`（[app/page.tsx:671](../app/page.tsx)）と同じ `[data-weave-id]` の走査に相乗りする
- 検出するのは2つ
  - スライド枠（1280×720）からのはみ出し
  - 親コンテナからのオーバーフロー（`scrollHeight > clientHeight`）
- envelopeへ `overflowing: string[]`（weave-idの配列）として載せる
- `contextPromptRules` に1行足す。「これはレンダリング結果であり、agentは自分では観測できない」

**注意**

注釈モードでなくても走る。走査コストは既存の注釈と同じなので送信時1回に留める。

**テスト**

- 枠外の要素・溢れた要素が検出される
- 正常なスライドでは空配列

**コミット単位**: 検出関数 / envelopeへの配線 / プロンプト規則 / テスト

---

## P5: 経路の統一と参照の保証

**やること**

- `/api/variations/generate` が注釈を運べるようにする
  - クライアント（[app/page.tsx:1504](../app/page.tsx)）の `contextEnvelope()` に注釈を渡す
  - サーバ（[server/local-api.mjs:115](../server/local-api.mjs)）の `requireText` を `requireTurnPrompt` に替え、注釈のみの送信を通す
- `data-weave-id` 欠落の検出を `shared/content-policy.mjs` に足す（警告レベル）
  - 圧縮した参照はidの存在に賭けている。現状これを担保するのは `baseInstructions` の一文だけで、formatterにもポリシーにも検査が無い
  - 自動補完はしない。agentが落としたことを検出できれば足りる

**残す既知の制約**

`variations/generate` は毎回新しいThreadを立てるので、チャットで述べた背景（D2で会話履歴に置くと決めたもの）は引き継がれない。提案軸機能を作るときに再検討する（注釈レイヤー設計書 §6 と同じ扱い）。

**コミット単位**: variationへの注釈配線 / id欠落検出 / テスト

---

## 成功条件

1. **1ターンあたりの envelope が 1KB 未満**（現状 約18KB）
2. **agentが読むファイルが、送信ボタンを押した瞬間のキャンバスと一致する**
3. **「真実」の宣言が1つになる**（`slides/*.html` + `styles/deck.css`）
4. agentが自分では観測できない情報（選択・注釈・破綻シグナル）だけが毎ターン渡る
5. **ポリシー検査がコミット経路にのみ存在する**。壊れた状態は見えるが、コミットはされない

1と2はテストで測る。3と4はレビューで見る。

## 未決事項（実装時に決定）

1. **`recentHistory` の残置** → **落とした**。§2 の表が git 履歴を「データ層＝agentが取りに行く」に置いている以上、envelope に残す理由が無い。かわりに `agentInstructions` の「Do not run git」を読み取りだけ許す表現に変えた（`log` / `show` / `diff` は可、リポジトリを変える操作は禁止）
2. **破綻シグナルの閾値** → **1 design px**。`getBoundingClientRect()` は浮動小数、`scrollHeight`/`clientHeight` は整数丸めなので、それ未満は測定ノイズで意味のある溢れではない。実物（northstar）では警告0
3. **`selectedText` の扱い** → **落とした**。2KBの範囲選択文字列のかわりに、D3の表どおり `selected.text`（選択要素の本文抜粋・200文字）を載せる。「何を指したか」はこれで足りる
