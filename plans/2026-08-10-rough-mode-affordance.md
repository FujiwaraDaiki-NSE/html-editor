# ラフモードで何ができるかを画面に出す 実装計画

作成日: 2026-08-10
設計: [docs/annotation-layer-design.md](../docs/annotation-layer-design.md) D8 / D10（R1 / R13）
前提: 注釈レイヤー P0–P10 が `feat/annotation-layer` に入っている

## 何を変えるか

1. **名前を行為に寄せる。** UIの文言を「注釈（annotation）」から「ラフ（rough）」へ。データとコードの語彙は変えない（D10）
2. **紙を出す。** ラフモード中、注釈レイヤーに面を与えてスライドの彩度を抜く（D8・R1）
3. **空状態で手順を出す。** 注釈が0件のときだけ、紙の中央にゴーストを描く（D8・R13）
4. **ラベルを例文で教える。** プレースホルダ `Label` を例つきに（D8・D1）

データの形・`contextEnvelope`・送信契約・チップ・添付・重ね照合・`@` の指差しは**一切変えない**。矢印（D11）はこの計画に含まない。

**UIの言語は既存に合わせて英語のままとする。** チャットの他の文言（`Add block` / `Preview` / `Annotate`）が英語なので、ここだけ日本語にすると揃わない。設計書の「ラフモード」はUI上 `Rough mode` にあたる。

---

## P11: 名前をラフに寄せる

文言だけの変更。挙動・クラス名・属性名・状態変数名は触らない。

| 箇所 | 現在 | 変更後 |
|---|---|---|
| `app/page.tsx:2283` ボタン | `▱ Annotate` | `▱ Rough` |
| 同 `title` | `Toggle annotation mode (A)` | `Toggle rough mode (A)` |
| `app/page.tsx:2194` ステータス行 | `Annotation mode · drag to draw a region` | `Rough mode · drag to draw a frame` |
| `app/page.tsx:2346` インスペクタ注意書き | `Annotation mode draws regions only. Editing is off while annotating.` | `Rough mode draws frames only. Editing is off while sketching.` |
| `app/page.tsx:795, 2170` アナウンス | `Annotation mode entered` / `left` | `Rough mode entered. Drag to draw a frame, then label it.` / `Rough mode left` |
| `app/page.tsx:1975` ショートカット一覧 | `Toggle region annotation mode` | `Toggle rough mode` |
| `README.md:29, 60` | 注釈モード | ラフモード |

- `annotationMode` / `data-annotation-mode` / `.annotation-*` / `annotations[]` / `annotationEnvelope` は**そのまま**。傘の語彙はデータ側に残す（D10）
- 入るときのアナウンスに手順を1文足すのは、ゴースト（P13）を `aria-hidden` にする代わり。**支援技術には同じ内容がこちらから届く**

**受け入れ条件**

- `grep -n "Annotation mode" app/page.tsx` が0件
- クラス名・属性名・API・テストの期待値が変わっていない

---

## P12: 紙（ラフモード中の面）

`app/globals.css` のみ。DOMは足さない。

```css
.annotation-overlay-layer { transition: backdrop-filter 160ms ease-out, background-color 160ms ease-out; }
.annotation-overlay-layer.interactive {
  backdrop-filter: saturate(.3) contrast(.95);
  background: color-mix(in srgb, var(--panel) 10%, transparent);
}
.slide-viewport[data-annotation-mode] { box-shadow: var(--shadow), inset 0 0 0 2px var(--accent); }
```

- 面は**レイヤーが持つ**。スライド側にフィルタをかけない。インクは同じレイヤーの子なので `backdrop-filter` の影響を受けない（D8）
- `.annotation-recall-layer` には**当てない**。重ね照合は生成結果を読む場面なので、下を沈めてはいけない
- 既存の `.slide-viewport[data-pointer-picking="true"]` のリングと同じ書き方に揃える（`globals.css:363`）
- `prefers-reduced-motion` は既存の全体規則（`globals.css:622`）が効くので個別対応は不要

**受け入れ条件**

- ラフモードON/OFFで面が160msで出入りする
- モード中でも下のスライドの本文が読める（手直しの前提。D5）
- 明るいスライド（`bg-white`）でも紺のスライド（`bg-slate-950`）でも同程度に効く
- 送信済み注釈の重ね表示（recall）の見え方が変わっていない
- ズーム 25% / 100% / 400% で面がスライド領域とずれない

---

## P13: 空状態のゴースト

`app/components/AnnotationOverlay.tsx` に要素を1つ足す。

- 条件は `interactive && annotations.length === 0`。1件でもあれば描かない
- 置き場所は `.annotation-overlay-layer.interactive` の中（紙の上）
- `aria-hidden="true"` かつ `pointer-events: none`。読み上げは P11 のアナウンスが担当する
- 文言（2段階＋宛先。D8）

```
Drag to draw a frame
→ then write what goes in it
Frames are sent to Agent together
```

- CSSは既存の注釈UIと同じ `calc(px / var(--slide-scale))` の書き方に揃える（`.annotation-order` などの前例）。ズームしても見た目の太さ・文字サイズが変わらないこと
- 破線の枠で囲み、描く成果物の形そのものを見せる

**受け入れ条件**

- モードに入った直後に出て、1つ目の矩形を描いた瞬間に消える
- 削除して0件に戻ったら再び出る
- ドラッグの開始点がゴーストの上でも矩形が描ける（当たり判定を奪わない）
- 通常モードでは出ない。recall中にも出ない

---

## P14: ラベルのプレースホルダ

`app/components/AnnotationOverlay.tsx:195` の1文字列。

- `Label` → `What goes here? (e.g. photo, one-line metric band)`
- 入力欄が狭いので、`title` に同じ文字列を入れて省略時に読めるようにする

**受け入れ条件**

- 描いた直後のフォーカスと入力の挙動が変わらない
- `label` の値・送信内容・`annotationEnvelope` は変わらない

---

## 検証

- `npm run lint` / `npm test` が緑
- 実デッキ（northstar）で P12–P14 を触って確認する。P10 と同じく、**密度は実物を見てから調整する**

## 触らないもの

- 注釈のデータ構造・`contextEnvelope`・`annotationPromptRules`・送信契約
- チップの矩形トグル、添付、下書きへの復元、重ね照合（P4は未着手のまま）
- `@` の指差し（D9）とその可視化
- 矢印・関係（D11。§8の測定より後）
