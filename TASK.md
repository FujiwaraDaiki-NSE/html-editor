#ルール
ユーザーから指示を受けたら以下のタスクをこなす。
完了したタスクは削除する。

## タスク

- [ ] metrics ブロックの Direction が display を壊す

  metrics は `grid grid-cols-4` を持つが、`containerLike`（app/page.tsx の `sel.container || sel.kind === "metrics"`）に含まれるため
  インスペクタに Direction 行が出る。Row / Column を押すと `setDirection` が `flex flex-row` を足し、`grid` と併存して
  `display` が競合する（どちらが勝つかは生成 CSS の順序次第）。

  Width / Position を全ブロックに広げた変更より前からある不具合。取りうる案は2つ:
  - metrics を Direction の対象から外す（列数固定のブロックなので方向を持たない、と割り切る）
  - `setDirection` で `grid` / `grid-cols-*` を落としてから flex を付ける（metrics が普通のコンテナになる）
