# HTMLを単一の真実にする（方向1）実装プラン

作成日: 2026-08-02
前提: concept.md 2.10 の決定。CSS/サイズ編集が機能しない根本原因＝トークン層の過剰抽象化を撤去し、
`slides/*.html` + `styles/deck.css` を単一の真実に据える。2.9前半（単一deck.css・固定1280×720・
絶対px・scale-to-fit・`.weave-slide`スコープ）は維持。

## 1. 目標アーキテクチャ

真実は実ファイルの3層に分解する。

| ファイル | 役割 | 誰が書く |
|---|---|---|
| `slides/<id>.html` | スライドの見た目の真実（`<main class="weave-slide ...">`丸ごと。背景クラス・`--accent`も内包） | 人間（DOM編集）＋agent（直接） |
| `styles/deck.css` | 単一スタイルシート（全セレクタ`.weave-slide`配下） | agent（直接）／人間はインスペクタ経由で間接 |
| `deck.json`（マニフェストに縮小） | デッキ構造のみ: `{ title, slides: [{ id, title, notes }] }`。**ブロック内容もスタイルも持たない** | Weave（保存時に自動） |

- 現状 `deck.json` が抱えていた「Block[]＋トークン」は消滅。順序・スライドタイトル・スピーカーノートという**非視覚メタデータ**だけがマニフェストに残る。
- accentはデフォルトを `deck.css` の `.weave-slide { --accent: … }` に置き、スライド個別の上書きは当該HTMLのルートへインラインで。背景も当該HTMLの`class`。→ **視覚情報は全部HTML/CSS側**に寄る。

### 重要な原則
- **「HTMLが真実」＝「人間が生CSSをタイプする」ではない**。インスペクタは構造化された意図コントロール（font-size, 幅, 方向/gap/揃え, 色）から**実CSS（要素へのインラインstyle）を生成**する。人間は`deck.css`を開かない（concept 2.6の精神を維持）。agentだけが`deck.css`とHTMLを直接書く。
- これで「20%」「1fr」「420px」など**任意のサイズ表現**が可能になる（トークンの3択が消える）。

## 2. キャンバスの描画とインタラクション

Reactは**クローム（選択枠・インスペクタ・ツールバー）だけを所有**し、スライド中身のDOMは所有しない。

- スライドHTMLは単一コンテナへ `dangerouslySetInnerHTML` で流し込み、以後はDOMが所有（Reactは再レンダで中身を壊さない）。
- 全操作は**イベント委譲＋命令的DOM操作**で行う（要素単位のReactコンポーネントは使わない）:
  - **選択**: クリック → 最近傍の `[data-weave-id]` 祖先を特定 → 選択IDをstateに。枠はReactオーバーレイ（`getBoundingClientRect`）か対象ノードへのクラス付与。
  - **テキスト直接編集**: 対象ノードに `contentEditable=true` を立てる → blur/Enter/Escで解除。テキストはDOMが保持、保存までReact stateへ往復しない。EditableTextの `placeCaret`/`focusEditableAt`/`readText`/貼り付け正規化を生DOM向けに再利用。
  - **インスペクタ編集**: 選択ノードへ `node.style.fontSize = "24px"` 等を直接適用。即時反映、再生成なし。
  - **構造操作（追加/削除/入れ替え/入れ子）**: DOMノードの挿入・削除・移動。ドラッグ＝ノード移動。フロー（flex/grid+gap）を維持し自由配置は不可（lint/Skillで担保）。

## 3. Undo/Redo

スナップショット＝**スライドの `outerHTML` 文字列**。編集確定ごとに直前HTMLをスタックへ、undoで差し戻す。現行のJSONスナップショット方式と粒度・実装コストはほぼ同じで、DOM世界にそのまま移植できる。

## 4. 保存フロー

1. クライアントが現在スライドDOM→HTML文字列にシリアライズし、エディタ専用の痕跡（`selected`/`editing`クラス、`contenteditable`/`data-editing`属性）を除去。
2. `POST /api/save` に `{ slides: { <id>: html }, css?, manifest, expectedRevision, idempotencyKey }`。
3. サーバは `slides/<id>.html`・`styles/deck.css`（変更時）・`deck.json`（マニフェスト）を書き、コミット。**再生成もトークン検証もしない**。品質/コンテンツ監査はHTML/CSSに対して実施。
4. 現行の staged-rename トランザクション（`project.mjs`）は多ファイル安全書き込みとして流用（生成ロジックが消えるぶん単純化）。

## 5. 最大のリスク：シリアライズの安定性

DOM→HTMLの往復でagentのマークアップを荒らさないこと。ブラウザの`innerHTML`は属性順・引用符・空白・実体参照を正規化するため、**無編集でも差分ノイズが出る**。対策を二段構え：

- **(a) dirtyトラッキング**: エディタで実際に触ったスライドIDだけを書き戻す。無編集スライドのファイルは一切書き換えない → agentが書いた通りに残る。安価で必須。
- **(b) 決定的フォーマッタ**: 保存時に人間・agent両方の出力を1つの正準フォーマットへ整形（Prettier標準HTML等）。これで差分が意味を持つ。AGENTS.mdは「HTMLを書け。整形はWeaveがやる」と指示し、agentはスタイル一致を気にしない。
- `data-weave-id` を**ノードの安定ID**として維持（人間↔agentの受け渡し・選択同期の基盤）。

## 6. Agent統合の変更

- **AGENTS.md**: 真実は`slides/*.html`＋`styles/deck.css`、それらを直接編集。deck.json内容・トークンスキーマの記述を削除。維持するルール: `.weave-slide`配下スコープ／固定1280×720・絶対px（%・fr可）／フロー（flex/grid+gap）・自由配置禁止／編集対象要素に`data-weave-id`／Weaveが整形・コミット。
- **コンテキストエンベロープ**: deck JSONではなく**現在スライドのHTML**＋選択（`data-weave-id`）＋選択テキスト＋`deck.css`を送る。`current-buffer` は現在スライドHTMLバッファに。
- `turn/completed` フック: `readDeck→writeDeck` を「HTMLファイルを読み整形（variationはコミット）」に置換。

## 7. 撤去/縮小するもの

- `shared/slide-design.mjs`: Block→HTML生成（`renderSlideMarkup`/`styleClasses`/`blockTag`）を削除。**エクスポート用の文書ラッパー**（scale/present足場＋deck.cssインライン化）だけ残し、生成HTMLではなく**実スライドHTML文字列を包む**形に。
- `server/project.mjs`: `validateDeck` のトークン白名簿、生成トランザクションの生成部分。
- `app/page.tsx`: `renderCanvasBlock`、`Block`型のstyle周り、`styleClass`/`mapBlocks`/`insertBeforeBlock`等の`Block[]`操作、インスペクタのトークンselect群。
- `app/components/EditableText.tsx`: React要素ラッパーは撤去。低レベルヘルパー（caret/paste/readText）はユーティリティとして残置・再利用。

## 8. 移行

現在の `slides/*.html` は**既に`deck.json`から生成された正当なHTML**なので、そのまま新しい真実の種として採用できる。移行手順は実質:

1. 既存 `slides/*.html` を正準フォーマッタで一度整形しコミット。
2. `deck.json` をマニフェスト（title＋slides順序/タイトル/notes）へ縮小。accent/背景は各HTMLへ内包済みを確認。
3. 以後は `slides/*.html` を真実として扱う。

生成物をそのまま昇格できるため、データ移行のリスクは小さい。

## 9. 段階導入（アプリを壊さず進める）

- **P0**: 正準フォーマッタ導入。キャンバスの描画元をBlockツリー→`slides/*.html`の`innerHTML`へ切替（書き込みは旧deck.json経路のまま）。プレビュー一致を検証。
- **P1**: DOM上のインタラクション層（選択・テキスト直接編集・削除/並べ替え/入れ子）。Undo＝HTMLスナップショット。
- **P2**: インスペクタが実CSS（インラインstyle）を書く。トークンselectを実コントロール（font-size数値+単位、幅%/px/fr、コンテナ方向/gap/揃え、色）へ置換。
- **P3**: 保存が`slides/*.html`(+css+manifest)をdirtyトラッキングで書く。deck.json内容・`validateDeck`トークン・slide-design生成を撤去。AGENTS.md/エンベロープ更新。監査をHTML/CSSへ。
- **P4**: 掃除。死んだBlockモデル・生成コード・EditableTextラッパー削除。

各フェーズ終端で `npm run lint && npm test` と実アプリでの動作確認（/verify）を通す。

## 10. 確定させたい設計判断

1. **マニフェストの範囲**: スライド順序/タイトル/notesを`deck.json`に残す案でよいか（提案: よい。視覚情報はHTML/CSSへ寄せる）。
2. **accentの置き場所**: `deck.css`の`--accent`をデフォルト、スライド個別はインライン上書き（提案: これ）。
3. **フォーマッタ選定**: Prettier標準HTML（依存増）か軽量な決定的シリアライザか。
4. **人間の「実CSS」自由度**: インスペクタ＝ノードへのインラインstyle生成に限定し、`deck.css`直編集はagent/上級者領域のままにする（提案: これ。concept 2.6の「人間は生CSSを書かない」を維持しつつ表現力だけ解放）。
