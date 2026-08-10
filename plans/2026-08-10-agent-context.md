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

---

## P1: ターン開始でスライドファイルまで書く

**やること**

- `writeProject(input, bufferOnly, expectedRevision)` の第2引数を `mode: "buffer" | "turn" | "save"` に置き換える
  - `"save"` — 現状の `bufferOnly=false`。ポリシーゲート＋deck.css検査＋トランザクション書き込み
  - `"turn"` — ファイルとマニフェストは書くが、**ポリシーゲートと deck.css 検査は通さない**
  - `"buffer"` — P2で消えるまでの互換。P2完了時に削除
- `/api/codex/turn/start` を `"turn"` に切り替える（[server/local-api.mjs:280](../server/local-api.mjs)）
- `/api/codex/turn/steer` はファイルを書かない。理由をコメントで残す（D4）
- `/api/variations/generate` は `"turn"` に変更（現状 `false`＝`"save"` 相当でゲートを通している）

**なぜ `"turn"` でゲートを外すか**

`writeProject(deck, false)` は content-policy 監査を通す（[server/project.mjs:338](../server/project.mjs)）。ターン開始でこれを走らせると、**人間の未保存編集がポリシー違反のとき送信が422で弾かれる**。「壊れているのでagentに直してほしい」ができなくなる。ゲートは保存＝コミットの門であって、agentに見せる門ではない。

**確認すること**

- ターン開始でファイルを書くと作業ツリーが未コミットになる。checkout系エンドポイントは `activeProjectTurn()` でガード済み（[server/local-api.mjs:235](../server/local-api.mjs)）。通常ターンは完了後もコミットしないので今も未コミットにはなっており、新種の状態ではないことを確認する
- ターンが起動に失敗した場合、書き込んだファイルは残る。これも既存挙動と同じであることを確認する

**テスト**

- ターン開始後、`slides/*.html` が送信したキャンバス内容と一致する
- ポリシー違反のHTMLでもターンは開始でき、`/api/save` は従来どおり422で弾く
- steerはファイルを書かない

**コミット単位**: `writeProject` のmode化 / turn startの切り替え / variationの切り替え / テスト

---

## P2: `.weave/current-buffer.json` の撤去

**やること**

- `agentInstructions` から「Before editing, read .weave/current-buffer.json …」を削除し、真実の所在を `slides/*.html` に一本化する（[server/project.mjs:69](../server/project.mjs)）
- `bufferPath` / `bufferJson` / `mode: "buffer"` を撤去
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

1と2はテストで測る。3と4はレビューで見る。

## 未決事項

1. **`recentHistory` の残置** — 直近コミット5件の要約は数百バイトで、agentは `git log` を叩けるが `baseInstructions` は「Do not run git」と言っている。読み取りだけ許すか、envelopeに残すか。いまはenvelopeに残す前提で書いているが、P3で判断する
2. **破綻シグナルの閾値** — オーバーフローを1pxから拾うか、意味のある溢れだけ拾うか。P4で実物を見て決める
3. **`selectedText` の扱い** — 範囲選択した文字列を毎ターン2KBまで載せているが、使われている実感が無い。P3で残すか落とすか判断する
