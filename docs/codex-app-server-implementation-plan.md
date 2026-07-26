# Codex app-server 統合実装計画

作成日: 2026-07-27  
対象: WeaveローカルHTMLエディタ  
参照仕様: [Codex App Server](https://learn.chatgpt.com/docs/app-server)  
確認バージョン: Codex CLI 0.145.0

## 1. 目的

WeaveのChat UIを、Codex app-serverのThread、Turn、Item、ストリーミングイベントを正規に扱えるクライアントへ拡張する。

単にAPIの呼び出し数を増やすのではなく、次の体験を完成させることを目標とする。

- Agentの回答、計画、推論サマリー、コマンド、ツール、ファイル変更をリアルタイムに確認できる
- 会話を一覧、検索、再開、フォーク、アーカイブできる
- 実行中Turnへの追加指示と中断ができる
- app-serverから届く承認、追加質問、OAuth誘導へ安全に応答できる
- モデル、認証、Skills、Hooks、MCPの状態をWeaveから確認・操作できる
- app-serverの更新で未知のイベントが追加されてもChat UI全体が壊れない

## 2. 実装原則

### 2.1 「全API」ではなく「Weaveに必要な安定API」を網羅する

app-serverには、リッチクライアント向けAPIだけでなく、実験API、管理API、低レベル実行API、ホストアプリ向けAPIも含まれる。

Weaveでは以下を網羅対象とする。

- Thread、Turn、Item
- ストリーミングイベント
- 会話履歴
- 承認と追加質問
- モデルと認証
- Skills、Hooks、MCP

実験APIは標準機能へ混ぜず、必要になった時点でfeature flag配下へ追加する。

### 2.2 app-serverの型を手書きしない

`codex app-server generate-ts`で、利用中のCodex CLIに対応するTypeScript型を生成する。

- 生成時のCLIバージョンを記録する
- 起動時に実行中CLIとの互換性を確認する
- 未知のイベントやフィールドはログへ残し、UIでは汎用カードへフォールバックする

### 2.3 ブラウザからapp-serverへ直接接続しない

通信経路は次を維持する。

```text
React UI
  ↕ HTTP / NDJSON
Weave local API
  ↕ stdio JSONL
Codex app-server
```

資格情報、app-serverプロセス、ファイルシステム権限はローカルAPI側で管理する。

### 2.4 Chat履歴とスライド履歴を分離する

- 会話の正規データ: app-server Thread
- スライド変更履歴: git
- エディタの現在状態: `.weave/deck.json`

既存の`.weave/chat.json`は移行期間のみ読み取り対象とし、最終的にはapp-server Threadへ一本化する。

## 3. 対象外

### 3.1 恒久的に対象外

- `thread/rollback`
  - deprecatedのため使用しない
- `thread/inject_items`
  - 生のResponses API itemを履歴へ注入する低レベルAPIのため使用しない
- `thread/shellCommand`
  - サンドボックス外でフルアクセス実行されるため使用しない
- `process/spawn`、`process/writeStdin`、`process/resizePty`、`process/kill`
  - サンドボックス外プロセスを扱う実験APIのため使用しない
- `experimentalFeature/enablement/set`
  - WeaveからCodex内部の実験機能を変更しない
- `plugin/list`、`plugin/read`、`plugin/install`、`plugin/uninstall`
  - 公式にunder developmentであり、production clientからの利用が推奨されていない
- `marketplace/add`、`marketplace/remove`、`marketplace/upgrade`
  - ユーザーのグローバルCodex環境を変更するため使用しない
- `config/value/write`、`config/batchWrite`
  - Weaveからユーザーのグローバル設定を書き換えない
- `externalAgentConfig/detect`、`externalAgentConfig/import`
  - 外部Agentからの移行はWeaveの責務外
- 汎用filesystem APIの書き込み・削除操作
  - Agent編集とWeaveのファイル管理に経路を統一する
- `account/sendAddCreditsNudgeEmail`
- `account/rateLimitResetCredit/consume`
- `account/workspaceMessages/read`
- `feedback/upload`

### 3.2 初期実装では対象外

- WebSocket、Unix socket transport
  - ローカル版はstdioを継続する
- 実験的なTurn／Itemページネーション
- バックグラウンドターミナル管理
- Collaboration mode一覧・切り替え
- Permission profile選択
- Apps／Connectors管理
- Review
- Device-codeログイン
- 外部管理ChatGPTトークン
- Amazon Bedrock設定UI
- Windows Sandboxセットアップ

## 4. 目標アーキテクチャ

### 4.1 モジュール構成

```text
server/
  codex/
    client.mjs             # app-serverプロセスとJSON-RPC通信
    protocol.mjs           # request/response/notificationの分類
    request-router.mjs     # app-serverから届く逆向きrequest
    event-stream.mjs       # UI向けイベントへの変換
    version.mjs            # CLI・生成型の互換性確認
  local-api.mjs            # HTTPルーティングとWeave固有処理

app/
  codex/
    reducer.ts             # Thread/Turn/Item状態
    actions.ts             # app-serverイベントからActionへの変換
    selectors.ts           # UI用selector
    types.ts               # UI固有状態
    components/
      AgentMessageItem.tsx
      PlanItem.tsx
      ReasoningItem.tsx
      CommandItem.tsx
      FileChangeItem.tsx
      ToolCallItem.tsx
      UnknownItem.tsx

generated/
  codex-app-server/        # generate-tsの生成物
```

### 4.2 UI状態

```ts
type CodexUIState = {
  threads: Record<string, ThreadState>;
  turns: Record<string, TurnState>;
  items: Record<string, ItemState>;
  activeThreadId: string | null;
  activeTurnId: string | null;
  pendingRequests: Record<string, PendingServerRequest>;
  connection: ConnectionState;
};
```

状態は`threadId`、`turnId`、`itemId`で正規化する。

同じイベントを複数回受信しても状態が壊れないこと、開始イベントより先にdeltaやcompletedが届いても復元できることをReducerの要件とする。

## 5. UIで処理する主要イベント

| イベント | UI処理 |
|---|---|
| `item/started` | Item種別に対応する作業カードを追加 |
| `item/agentMessage/delta` | AgentメッセージへMarkdownを逐次追記 |
| `item/plan/delta` | Planカードを逐次更新 |
| `item/reasoning/summaryPartAdded` | 推論サマリーのパートを追加 |
| `item/reasoning/summaryTextDelta` | 推論サマリーへテキストを逐次追記 |
| `item/commandExecution/outputDelta` | stdout／stderrをコマンドカードへ追記 |
| `turn/diff/updated` | ファイル別diffビューを更新 |
| `item/completed` | Itemの成功、失敗、中断、最終出力を確定 |
| `thread/status/changed` | サイドバーと実行状態を更新 |
| `turn/completed` | Turnの最終状態を確定し、Stopボタンを戻す |

未知のItem種別は破棄せず、`UnknownItem`としてmethod、Item type、statusを表示する。

## 6. 実装フェーズ

### Phase 1: app-server通信基盤

実装内容:

- 現在の`CodexAppServer`クラスを独立モジュールへ分離
- outbound request／response
- notification
- app-serverから届く逆向きrequest
- request timeout
- AbortSignal
- プロセス終了と再接続
- 未知イベントの記録
- `generate-ts`スクリプト
- CLIバージョンと生成型バージョンの互換性確認

完了条件:

- モックapp-serverと双方向JSON-RPC通信できる
- responseと逆向きrequestをIDだけで誤判定しない
- app-server停止時に保留中requestがすべて解放される

### Phase 2: イベントReducer

実装内容:

- Thread、Turn、Itemの正規化
- app-serverイベントからActionへの変換
- UI selector
- 重複イベントの無害化
- 順序が前後したイベントへの対応
- 未知のイベント・Itemへのフォールバック
- `app/page.tsx`内のイベント別`useState`更新をReducerへ移行

完了条件:

- 保存したイベント列を再生すると同じUI状態になる
- Reactコンポーネントが生のapp-serverイベントを直接処理しない

### Phase 3: Agent作業カード

実装内容:

- Agentメッセージ
- Plan
- Reasoning summary
- コマンドとstdout／stderr
- ファイル変更
- diff
- Tool call
- サブエージェント
- Review
- 未知のItem
- running／completed／failed／interrupted状態
- 長い出力の上限と折りたたみ

完了条件:

- Turn開始から完了まで、全Itemが時系列で表示される
- Stop後にItemとTurnが`interrupted`へ確定する
- 未知のItemを受信してもChat UIが継続動作する

### Phase 4: Threadと履歴

実装対象:

- `thread/start`
- `thread/list`
- `thread/search`
- `thread/read`
- `thread/resume`
- `thread/fork`
- `thread/name/set`
- `thread/goal/set`
- `thread/goal/get`
- `thread/goal/clear`
- `thread/archive`
- `thread/unarchive`
- `thread/delete`
- `thread/compact/start`

UI:

- Threadサイドバー
- 検索
- 新規会話
- 再開
- 名前変更
- フォーク
- アーカイブ一覧
- 削除確認
- コンパクション状態

完了条件:

- アプリ再起動後も過去Threadを再開できる
- Threadをフォークしても元の会話が変更されない
- `.weave/chat.json`がなくてもChat UIが動作する

### Phase 5: Turn操作

実装対象:

- `turn/start`
- `turn/steer`
- `turn/interrupt`
- `thread/status/changed`
- 同時実行制御
- 切断・再接続
- 二重送信防止

設計要件:

- ブラウザ切断を即座にTurn中断へ結び付けない
- `clientUserMessageId`で論理的な送信を識別する
- Threadごとに実行中Turnを管理する
- Stopの多重送信を安全に処理する

完了条件:

- 実行中Turnへ追加指示を送れる
- ページ再読み込み後に実行状態を復元できる
- Stop後にUIとapp-serverの状態が一致する

### Phase 6: 逆向きrequestと承認

実装対象:

- コマンド実行承認
- ファイル変更・権限承認
- ネットワーク承認
- `tool/requestUserInput`
- `mcpServer/elicitation/request`
- OAuth URL誘導
- request timeoutとキャンセル

UI要件:

- `availableDecisions`からボタンを生成
- 1〜3問の質問フォーム
- 自由入力
- MCPフォーム
- 外部URLを開く前の確認
- 保留中request一覧

既存方針との整合:

- 標準設定は`approvalPolicy: "never"`を維持
- 「確認あり」を選択した場合のみ承認UIを有効化
- 通常のAgentファイル編集は自動反映可能

完了条件:

- すべての逆向きrequestへresponseまたは明示的errorを返す
- UIを閉じてもrequestを無期限に残さない
- app-serverが提示していないdecisionをフロント側で生成しない

### Phase 7: モデル、認証、Skills、Hooks、MCP

モデル:

- `model/list`
- `modelProvider/capabilities/read`
- モデル選択
- Reasoning effort
- 入力モダリティ
- Provider能力

認証:

- `account/read`
- `account/updated`
- ChatGPTブラウザログイン
- APIキー認証
- logout

Skills・Hooks:

- `skills/list`
- `skills/changed`
- `skills/config/write`
- `hooks/list`

MCP:

- `mcpServerStatus/list`
- `mcpServer/oauth/login`
- `mcpServer/oauthLogin/completed`
- startup status
- resource read
- tool call

完了条件:

- 利用可能モデル、Skills、MCP状態を起動時に取得する
- 認証状態の変化を再起動なしでUIへ反映する
- 認証情報をブラウザやWeaveのDBへ永続化しない

### Phase 8: 移行、検証、堅牢化

移行:

- 既存`.weave/chat.json`の読み取り
- 既存Threadが存在しない場合の新規作成
- 現行Chat UIとの表示互換
- 複数提案のgitブランチ機能を維持

テスト:

- JSON-RPCクライアント単体テスト
- Reducerイベント再生テスト
- イベント順序入れ替えテスト
- 重複イベントテスト
- 切断・再接続テスト
- 承認requestテスト
- Thread再開テスト
- ストリーミングE2E
- 大量stdoutテスト
- diff表示テスト
- app-serverバージョン不一致テスト

セキュリティ:

- サンドボックス外実行APIを呼ばない
- パストラバーサルを防ぐ
- Originを制限する
- OAuth URLを検証する
- 資格情報をログへ出さない
- Markdown、stdout、diff表示を安全にレンダリングする

完了条件:

- 全主要イベントのfixtureを再生できる
- app-server切断、再起動、未知イベントでUIが壊れない
- lint、build、単体テスト、E2Eが通る

## 7. 推奨PR分割

1. app-server clientと生成型
2. Reducerとselector
3. Itemカードと主要イベント
4. Thread履歴
5. `turn/steer`と`turn/interrupt`
6. 逆向きrequest
7. モデルと認証
8. Skills、Hooks、MCP
9. 移行とE2E

各PRは、前段階の公開インターフェースだけに依存させる。実験APIは安定APIのPRへ混在させない。

## 8. 着手順

最初にPhase 1を実施する。

現在の単一ファイル通信処理へ機能を追加し続けると、次の責務が衝突する。

- JSON-RPC request／response
- app-serverからの逆向きrequest
- notification
- HTTPストリーミング
- Weave固有のgit・ファイル処理

通信層を分離し、生成型と双方向requestを整備した後でReducerとUIイベントへ進む。

## 9. 仕様更新への対応

app-serverはCodex CLIの更新に伴ってAPIが追加・変更される。

更新時は次の手順を実施する。

1. Codex CLIバージョンを更新する
2. `generate-ts`を再実行する
3. 生成差分を確認する
4. 安定／beta／experimental／deprecatedを分類する
5. Reducerの未知イベントfixtureを更新する
6. production対象へ追加するAPIだけを明示的に有効化する

公式ドキュメント上でunder developmentまたはexperimentalとされたAPIは、自動的にproduction対象へ昇格させない。
