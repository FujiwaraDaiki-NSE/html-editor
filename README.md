# Weave

人間とAgentが同じHTMLプロジェクトを共同編集する、スライド制作向けローカルビジュアルエディタです。

## 起動

Node.js 22.13以降と、ログイン済みのCodex CLIが必要です。

```bash
npm install
npm run dev
```

ブラウザで [http://localhost:3000](http://localhost:3000) を開きます。

`npm run dev`は画面、ローカルAPI、Codex app-serverをまとめて起動します。OpenAIの資格情報をアプリ内へコピーせず、Codex CLIの既存ログインを利用します。

## 現在触れる機能

- アウトラインからスライドを切り替える
- 複数スライドを個別のHTMLファイルとして編集・追加する
- プレビュー内の要素を選び、インスペクタのテキスト編集と同期する
- オブジェクトツリーから要素を選択・削除する
- 要素をドラッグしてフロー内の順番を変える
- Heading、Body、Metrics、Footnoteブロックを追加する
- PreviewとCode表示を切り替える
- Agentへ指示を送り、応答と作業状況をストリーミング表示する
- Agentが現在の未保存バッファ、選択要素、実プロジェクトを読んで編集する
- 複数提案をAgentが逐次生成し、gitブランチ単位で切り替える
- 選んだ提案を採用し、未採用案をhistoryへ送る
- スライド背景とアクセントカラーを変更する
- ダーク／ライトモードを切り替える
- SaveボタンでHTMLとエディタ状態を実ファイルへ書き込み、gitコミットする
- Historyから過去のコミットを閲覧し、最新状態へ戻る
- PreviewとCodeの選択行、インスペクタを同期する

編集対象は `workspaces/northstar/` に自動作成されます。`.weave/deck.json` が正規のエディタ状態で、`slides/` 以下にスライドごとのHTMLが生成されます。各プロジェクトは独立したgitリポジトリとして管理されます。

Codex app-serverとの通信は公式のJSON-RPCライフサイクル（初期化、thread、turn、通知ストリーム）に沿ってローカルAPIが担当します。ブラウザからapp-serverや資格情報へ直接アクセスしません。

## 検証

```bash
npm run lint
npm test
```

`npm test` はプロダクションビルドと、レンダリング結果・主要機能の構成確認を行います。

要件と設計判断は [concept.md](./concept.md) にまとまっています。
