# チャットUIの可読性と空間の使い方

作成日: 2026-08-10
ステータス: 実装前（方針確定）
対象ブランチ: `impl/chat-readability`（worktree: `../html-editor.worktree/impl/chat-readability`）

## 1. 何が問題か

チャットはconcept 2.4で「常時読み書きする主機能」と位置づけ、サイドバーの全高を与えている。
にもかかわらず、実際には**読めない**。原因は2つある。

### 1.1 文字が本文サイズになっていない

モックアップ由来の縮小スケールがそのまま実装に入っており、チャット領域の指定は以下の通り
（[app/globals.css](../app/globals.css)）:

| 要素 | セレクタ | 現在 |
|---|---|---|
| メッセージ本文 | `.message-content > p` | 9px |
| codexアイテム全般 | `.codex-item` | 8px |
| 出力/diff | `.codex-item pre` | **7px** |
| 作業ログ | `.work-details` | 8px |
| コンテキストchip | `.context-chip` | 8px |
| 注釈凡例 | `.annotation-legend-text` | **7px** |
| 入力欄 | `.chat-box textarea` | 9px（高さ38px固定） |
| Thread一覧 | `.thread-list strong` | 8px |

本文の実用下限は13px前後。9pxは「小さめ」ではなく**読めない領域**にある。
`@media (max-width: 900px)` だけが12pxに引き上げているのが、その裏返しの証拠になっている。

### 1.2 狭い列を、さらに余白で削っている

サイドバーは245px固定。そこに吹き出し（bubble）レイアウトを載せているため、

- `.message.user .message-content { max-width: 86% }`
- `.codex-item-userMessage { margin-left: 18% }`
- `.codex-item-agentMessage { margin-right: 8% }`

と、**横幅の1〜2割を構造的に捨てている**。吹き出しは「相手が誰か」を示すための装置だが、
1対1の対話でカラム幅が245pxしかない状況では、得られる情報量に対して代償が大きすぎる。

さらに [ItemCard.tsx](../app/codex/components/ItemCard.tsx) は、agentMessage も commandExecution も
fileChange も**すべて同じ枠線カード**として描く。カードごとに `<header>` が1行を占め、
そこに出るのはラベルと `status`（ほぼ常に "completed"）。ターン末尾の
`<footer><span>{turn.status}</span></footer>` も同様に、常時 "completed" を出し続けている。
情報量ゼロの行が、狭い列の縦を食っている。

## 2. 方針

**吹き出しをやめ、全幅の行レイアウトにする。**（Claude Code / Cursor のチャットと同じ形）
発話者はラベルと地の色で示し、幅は捨てない。そのうえでチャット限定のtype scaleを入れる。

適用範囲は**チャットパネル内に閉じる**（ユーザー判断）。インスペクタ・レール・ステータスバーは
現状の縮小スケールのまま残す。隣接パネル間で文字サイズの段差は出るが、
「主機能を読める状態にする」ことを優先する。全体のtype scale統一は別タスクとする。

## 3. 変更内容

### 3.1 チャット限定のtype scale

`.agent-panel` にスコープした変数を置き、チャット内の各セレクタはこの変数だけを参照する。
（`.agent-panel` の外＝インスペクタ等には一切漏れない）

```css
.agent-panel {
  --chat-body: 13px;   /* 本文（メッセージ・入力欄） */
  --chat-meta: 11px;   /* ラベル・ステータス・chip */
  --chat-micro: 10px;  /* 凡例・補助 */
  --chat-mono: 11px;   /* pre / diff */
  --chat-lh: 1.65;
}
```

差し替え対象: `.message-content > p`, `.codex-item`, `.codex-item pre`, `.turn-group pre`,
`.work-details`, `.context-chip`, `.annotation-legend-text`, `.annotation-attachment`,
`.server-request`, `.server-question`, `.chat-box textarea`, `.chat-actions`,
`.thread-*`（popoverはチャット所有）, `.empty-thread`, `.trimmed-log`。

`@media (max-width: 900px)` にあるチャット向けの上書き（684-687行）は、基準値が正常になるため
**削除する**。送信ボタンの拡大だけは基準側に取り込む。

### 3.2 吹き出しの廃止

- `.message.user .message-content { max-width: 86% }` → 撤廃（全幅）
- `.codex-item-userMessage { margin-left: 18% }` / `.codex-item-agentMessage { margin-right: 8% }` → 撤廃
- 発話者の区別は次で行う:
  - **User**: 左に3pxのアクセントボーダー＋ごく薄いアクセント地（`color-mix` 8%程度）
  - **Agent**: 地なし・枠線なし。本文がそのまま流れる
- 角丸の非対称（`border-radius: 4px 9px 9px 9px` 等）は不要になるため単純化する

### 3.3 作業ログを1行に畳む

`ItemCard` の描画を2系統に分ける。**JSXの構造変更を伴う**。

1. **メッセージ系**（`agentMessage` / `userMessage`）
   - `<header>` を出さない。発話者はラベル1個（`You` / `Agent`、`--chat-meta`）のみ
   - `status` は `completed` のとき出さない（running / failed のときだけ出す）
2. **作業系**（それ以外すべて）
   - 枠線カードをやめ、**左罫線1本＋1行サマリ**にする: `［glyph］ラベル · 短い要約`
   - `output` / `diff` の `<details>` は従来通り。ただし既定で閉じる
     （現状 `open={item.status === "running"}` は維持＝実行中のみ開く）
   - パディングを圧縮し、1件あたりの縦を現状の約半分に

`.turn-group > footer` は `turn.status !== "completed"` または `turn.diff` があるときだけ描画する
（[page.tsx:2038](../app/page.tsx) の JSX を条件付きに）。

### 3.4 入力欄

- `font-size: var(--chat-body)`、`line-height: var(--chat-lh)`
- 高さ38px固定 → `field-sizing: content` + `min-height: 4.5em` / `max-height: 168px` で自動伸長。
  未対応ブラウザでは min-height のまま（現状より広い）に劣化するだけなので JS は足さない
- 送信/停止ボタン: 21px → 28px、グリフも拡大

### 3.5 サイドバー幅のドラッグリサイズ

- `.workspace` の `grid-template-columns` にある `245px` を
  `var(--weave-sidebar-width, 340px)` に置換（4つのバリアント＋1120pxのmedia query内の210px も同様に
  `min(var(--weave-sidebar-width, 340px), 280px)` 相当へ調整）
- `.left-panel` を `position: relative` にし、右端に幅5pxの `.panel-resizer`（`cursor: col-resize`）を置く
- pointerdown → pointermove で `document.documentElement.style.setProperty("--weave-sidebar-width", ...)`
  を **280px〜560px にクランプ**して更新、pointerup で localStorage に保存
- 保存キー `weave.sidebarWidth`。読み出しは `slideNavStore`（[page.tsx:67-74](../app/page.tsx)）と
  **同じ外部ストア方式**にして、SSRと初回クライアントレンダの既定値（340px）を一致させる
- `@media (max-width: 900px)` では1カラムに畳まれるため `.panel-resizer { display: none }`
- キーボード操作のため `role="separator"` `aria-orientation="vertical"` と左右矢印キー（16px刻み）に対応する

## 4. 触らないもの

- **チャット以外のパネルの文字サイズ** — 適用範囲の判断（2節）による
- **`.chat-box` の DOM 構造** — `context-chip` が `chat-box` の第一子である契約を
  [tests/architecture.test.mjs:109](../tests/architecture.test.mjs) が検証している。順序を変えない
- **注釈オーバーレイ側（`.annotation-box` 等）** — スライド座標系にスケールされる別世界。無関係
- **メッセージの仮想化・ページング** — `visibleTurns` の上限で足りている。今回の問題ではない
- **アバター/アイコンの追加** — 全幅化で得た幅を、また装飾で削ることになる

## 5. 検証

- `npm run lint` / `npm test`（`architecture.test.mjs` の chat-box 契約が通ること）
- 1600px幅と1280px幅、ダーク/ライト両方で目視:
  - 長い日本語メッセージが折り返して読めること
  - コマンド実行を10件含むターンが、縦に暴れないこと
  - サイドバーを280pxまで縮めても、入力欄とcontext chipが破綻しないこと
- 900px以下（スタック表示）で、削除した上書きの代わりに基準値が効いていること
