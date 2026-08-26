# モデル選択（送信のたびに選べる場所へ出す）計画

作成日: 2026-08-12

## 現状

配線そのものは既にある。無いのは「選べる場所」と「選んだ状態が残ること」。

- サーバは `thread/start` と `turn/start` の両方に `model` / `effort` を渡している（[server/codex/service.mjs:280](../server/codex/service.mjs), [server/codex/service.mjs:363](../server/codex/service.mjs)）。
  **`turn/start` がターンごとに model を受けるので、スレッドを作り直さずに途中でモデルを変えられる。**
- カタログは `model/list` で取得済み（[server/codex/service.mjs:153](../server/codex/service.mjs)）。
- UIは Settings サイドバーの `<select>` 1つだけ（[app/page.tsx:2231](../app/page.tsx)）。チャットから3クリック離れており、送信時に何で動くのか見えない。

さらに、現状の実装には選択が保たれないバグが2つある。

1. **選択が再読み込みで消える。** `selectedModel` はただの `useState("")` で永続化がない（[app/page.tsx:290](../app/page.tsx)）。リロードすると `models[0]` に戻る（[app/page.tsx:565](../app/page.tsx)）。
2. **effort が定期ポーリングで勝手に戻る。** `applyServerState` の effort 補正が、選択中のモデルではなく常に `models[0]` の `supportedReasoningEfforts` を見ている（[app/page.tsx:566](../app/page.tsx)）。`models[0]` が対応しない effort を選ぶと、次のポーリングで別の値に書き換わる。

「機能が無い」という体感は、この2つが主因である。UIを足すだけでは直らないので同時に潰す。

## 目的

**送信する直前に、何で動くかが見えていて、その場で変えられる。** それだけを満たす。

## 設計方針: 置き場所は composer、状態は1つ

モデルと effort は「送信ボタンの隣にある属性」であって、設定画面の項目ではない。
📎 と ↑ が並ぶ `chat-actions` の左端に、現在値を出したボタンを置き、既存の popover 機構でリストを開く。

```
[◎ Slide 3 in context · Ready]
┌─────────────────────────────────┐
│ ここに指示を書く…                  │
└─────────────────────────────────┘
 [gpt-5.6-luna · medium ⌄]   ⌘↵  📎  ↑
```

状態は増やさない。既存の `selectedModel` / `reasoningEffort` をそのまま使い、Settings と composer が同じ値を見る。
Settings の Agent セクションからは Model / Reasoning の行を**消す**（Approvals は残す）。同じものを2箇所に置かない。

## 決定事項

1. **popover は `slideNavStore` と同型の外部ストアで永続化する**
   `agentModelStore`（`weave.agent.model` / `weave.agent.effort`）を `app/page.tsx` の既存ストア群の隣に置き、`useSyncExternalStore` で読む。
   プロジェクト単位ではなく**ブラウザ単位のグローバル設定**とする。モデルの好みは案件ではなく人に紐づくため。

2. **保存済みモデルがカタログに無ければ、黙って先頭にフォールバックする**
   Codexのモデル一覧はCLI更新で変わる。存在しないIDを送ると `turn/start` が失敗するので、
   カタログ受信時に「保存値がカタログに在るか」を検証し、無ければ `models[0]` を採る。エラーは出さない（人が選び直せる状態が画面に見えているため）。

3. **effort の補正は必ず「選択中のモデル」に対して行う**
   [app/page.tsx:566](../app/page.tsx) の `models[0]` 参照を `selectedModelInfo` 基準に直す。
   選択中モデルが `supportedReasoningEfforts` を持たない場合は補正しない（現行の `["low","medium","high"]` フォールバックは表示専用に留める）。

4. **ターン実行中はモデルを変えられない（ボタンを disabled）**
   `turn/start` は開始時のモデルで走り切る。走行中に表示だけ変わると嘘になるので、`agentRunning` の間は固定する。
   変更はキュー化しない。次のターンから効く、で十分。

5. **スレッドごとのモデル記憶は持たない**
   「このスレッドは luna で始めたから luna に戻す」はやらない。常に現在の選択で送る。
   Codex側もターン単位でモデルを受けるので、スレッドとモデルを結び付ける必然性がない。

6. **どのモデルが答えたかはメッセージに出さない**
   ログとして正しくはあるが、今回のスコープ外。必要になったら `turn/completed` の情報から別途足す。

7. **モデルが1件も無いとき（Codex未接続・`model/list` 失敗）はボタンを出さない**
   選べないセレクトを置かない。`agentActivity` が既に "Connecting to Codex…" を出しているので、そちらに任せる。

## 変更対象

| 変更 | 場所 |
|---|---|
| `agentModelStore`（localStorage + `useSyncExternalStore`）の追加 | `app/page.tsx`（`slideNavStore` / `sidebarWidthStore` の隣, [app/page.tsx:69](../app/page.tsx)）|
| `selectedModel` / `reasoningEffort` を `useState` からストア読みへ移行 | `app/page.tsx:290-291` |
| カタログ受信時の検証を「保存値がカタログに在るか」に変更、effort補正を `selectedModelInfo` 基準へ修正 | `app/page.tsx:565-566` |
| `OpenPopover` に `"agentModel"` を追加 | `app/page.tsx:33` |
| composer に現在値ボタン + popover（モデル一覧 / 選択中モデルの effort 一覧） | `app/page.tsx:2390`（`chat-actions` 内, 📎 の左）|
| Settings の Agent セクションから Model / Reasoning 行を削除 | `app/page.tsx:2231-2232` |
| `.agent-model-button` と popover のスタイル | `app/globals.css`（`.chat-actions` / `.popover` 付近, [app/globals.css:250](../app/globals.css)）|

サーバ側の変更は無い。

## popover の中身

```
モデル
  ● gpt-5.6-luna        <displayName>
  ○ gpt-5.6-codex
  ○ …
推論の深さ                  ← 選択中モデルの supportedReasoningEfforts のみ
  ○ low  ● medium  ○ high
```

- モデル行の表示は `displayName ?? name ?? id ?? model`（既存のフォールバック順を踏襲）。
- モデルを切り替えたとき、新しいモデルが現在の effort に対応していなければ `defaultReasoningEffort` へ寄せる（既存の onChange の挙動をそのまま移す）。
- 開閉・外側クリックでの解除・フォーカス戻しは既存の `togglePopover` / `dismissPopover` に乗せる。独自に書かない。

## 影響範囲

`selectedModel` / `reasoningEffort` を読んでいる送信経路は3つ。すべて既存のまま動く（値の出所が変わるだけ）。

- 通常ターン: [app/page.tsx:1969](../app/page.tsx)
- スレッド開始: [app/page.tsx:1959](../app/page.tsx), [app/page.tsx:2008](../app/page.tsx)
- 複数提案の生成: [app/page.tsx:1876](../app/page.tsx)

## 確認

1. モデルを選び直してリロード → 選択が残っている（現状は戻る）。
2. `models[0]` が対応しない effort を選び、10秒以上放置（ポーリングを跨ぐ）→ 値が変わらない（現状は戻る）。
3. モデルAで1ターン送信 → モデルBに変更 → もう1ターン。同一スレッドで両方成功する。
4. ターン実行中はボタンが disabled。
5. localStorage に存在しないモデルIDを書いてリロード → エラーなく先頭モデルが選ばれる。
6. Codex未接続の状態でボタンが出ない。
