# React + Vite 移行実装計画

作成日: 2026-07-28

対象: WeaveローカルHTMLエディタ

移行元: React 19 + Vinext + Vite + Cloudflare Worker

移行先: React 19 SPA + Vite + Node.jsローカルAPI

## 1. 結論

Weaveのフロントエンドを、Next.js互換のVinext App Router構成から、ReactとViteを直接利用するSPA構成へ移行する。

現在のWeaveは一画面の対話型エディタであり、画面全体がClient Componentとして動作している。データとAgent実行の正規バックエンドは、別プロセスのWeave local APIとCodex app-serverである。この実行モデルでは、App Router、React Server Components、SSR、Server Actions、Next.jsキャッシュの便益が小さく、Vinext互換層とCloudflare Worker向けRSCビルドが構成の複雑さを増やしている。

移行後は次の構成を正規形とする。

```text
開発時

Browser
  ↕ http://localhost:3000
Vite dev server
  ├─ React SPA / HMR
  └─ /api/* proxy
        ↕ http://127.0.0.1:4317
      Weave local API
        ↕ stdio JSON-RPC
      Codex app-server
```

```text
ローカル本番実行時

Browser
  ↕ http://127.0.0.1:4317
Weave local API
  ├─ /api/*              HTTP / NDJSON API
  ├─ /assets/*           Vite生成アセット
  └─ /*                  SPA fallback
        ↕ stdio JSON-RPC
      Codex app-server
```

開発時はViteのproxyでCORSを不要にし、ローカル本番実行時はNode.jsサーバーが静的フロントエンドとAPIを同一オリジンで提供する。

## 2. 移行目的

- VinextによるNext.js API再実装への依存をなくす
- React Server Componentsを使わないアプリにRSCビルドを適用しない
- フロントエンドを標準的なVite SPAとして理解・保守できるようにする
- ブラウザからローカルAPIへの接続先を相対URLへ統一する
- ローカル本番実行を単一のNode.jsプロセスにまとめる
- Codex Thread、Turn、Item、承認、MCPなど既存機能をそのまま維持する
- `.openai/hosting.json`とSites向け成果物のパッケージングを維持する

## 3. 現状と変更理由

### 3.1 現状

- `app/page.tsx`全体が`"use client"`である
- 画面は単一ページで、Next.jsのファイルルーティングを実質利用していない
- UI状態はReact hooksとCodex reducerが保持している
- データ取得と更新はすべて`http://127.0.0.1:4317/api`への`fetch`で行う
- CodexイベントはローカルAPIのNDJSONストリームから受信する
- `app/layout.tsx`だけがMetadata、`next/font`、`next/headers`を利用する
- `vite.config.ts`はVinext、Cloudflare、Sitesの各プラグインを組み合わせている
- `worker/index.ts`はVinext App Routerと画像最適化のWorkerエントリである
- 本番ビルドテストはVinextのSSR Workerを直接呼び出している

### 3.2 移行後

- `index.html`がHTMLシェルと静的metadataを持つ
- `src/main.tsx`がReactを起動する
- `src/App.tsx`が現在の`app/page.tsx`の責務を引き継ぐ
- Codex reducerと表示コンポーネントは`src/codex/`へ移す
- APIベースURLは既定で相対パス`/api`とする
- 開発時だけViteが`/api`をローカルAPIへproxyする
- ビルド成果物は通常の`dist/index.html`と`dist/assets/*`になる
- ローカルAPIは本番時に`dist/`を安全に配信する

## 4. 対象範囲

### 4.1 対象

- フロントエンドのエントリポイントとディレクトリ構成
- Vite設定とpackage scripts
- API接続先と開発proxy
- HTML metadataとフォント
- Node.jsローカルAPIによる静的ファイル配信
- Sites向けビルド成果物
- SSR前提テストのSPA向け置換
- Vinext、Next.js、RSC、Cloudflare Worker固有コードの削除

### 4.2 対象外

- Codex app-server通信プロトコルの変更
- Thread、Turn、Item reducerの再設計
- ローカルAPIの業務エンドポイント変更
- スライド保存形式やGit履歴の変更
- React Routerの導入
- UIデザインの変更
- デスクトップアプリ化
- クラウド上でCodexを実行するサービスの構築
- 公開WebサイトからローカルAPIへ安全に接続するcompanion protocolの設計

単一画面である間はReact Routerを導入しない。URL単位の画面が二つ以上必要になった時点で、要件を確認して追加する。

## 5. 目標ファイル構成

```text
index.html
src/
  main.tsx
  App.tsx
  globals.css
  codex/
    actions.ts
    reducer.ts
    selectors.ts
    types.ts
    components/
      ItemCard.tsx
      ServerRequestCard.tsx

server/
  local-api.mjs
  project.mjs
  codex/
    client.mjs
    protocol.mjs
    request-router.mjs
    event-stream.mjs
    service.mjs
    version.mjs

build/
  sites-vite-plugin.ts

vite.config.ts
```

削除対象:

```text
app/
worker/index.ts
next-env.d.ts
```

`app/`配下の実装は`src/`へ移し、恒久的なre-exportや互換ファイルは残さない。

## 6. 設計方針

### 6.1 SPAとして明示する

Viteの通常のReact構成を採用し、SSRとRSCを行わない。初期HTMLはアプリ用のroot要素を持ち、Reactがブラウザでmountする。

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

既存の`app/page.tsx`は、大規模なロジック変更を同時に行わず、最初は`src/App.tsx`へ機械的に移す。コンポーネント分割は移行完了後の別変更とする。

### 6.2 API接続を相対URLにする

ソースに固定された`http://127.0.0.1:4317/api`を廃止する。

```ts
const apiBase = import.meta.env.VITE_WEAVE_API_BASE ?? "/api";
```

- 通常は`/api`を使う
- 開発時はVite proxyが4317番へ転送する
- ローカル本番時は同じNode.jsサーバーが処理する
- テストや特殊な埋め込みだけ`VITE_WEAVE_API_BASE`で上書きできる
- 秘密情報を`VITE_*`へ格納しない

Vite設定には次を追加する。

```ts
server: {
  port: 3000,
  proxy: {
    "/api": {
      target: "http://127.0.0.1:4317",
      changeOrigin: false,
    },
  },
}
```

NDJSONの長時間接続がbufferされず、ブラウザ切断がAPI側のTurn中断を引き起こさないことを実機で確認する。

### 6.3 ローカルAPIから静的ファイルを配信する

`server/local-api.mjs`に本番静的配信を追加する。

- `/api/*`は既存のAPI routerへ渡す
- `GET`と`HEAD`だけを静的配信対象にする
- `dist/`外へ抜けるpath traversalを拒否する
- 実ファイルがある場合はそのファイルを返す
- 拡張子のない未知のパスは`dist/index.html`へfallbackする
- 未知のアセットパスは404にし、HTMLを返さない
- HTMLは再検証可能なcache policyにする
- hash付き`dist/assets/*`はimmutable cacheにする
- MIME typeを明示する
- `dist/`がない場合は、APIだけを起動して明確な診断を表示する

開発用の`npm run dev`は引き続きViteとローカルAPIを二つ起動する。本番用の`npm start`は、事前に`npm run build`された`dist/`をローカルAPI一つで配信する。

### 6.4 Metadataを静的HTMLへ移す

`app/layout.tsx`の責務を次のように置き換える。

| 現在 | 移行後 |
|---|---|
| `Metadata`型 | `index.html`の`<meta>` |
| `generateMetadata()` | 静的title、description、OG、Twitterタグ |
| `next/headers` | 削除 |
| request hostから作るOG URL | ルート相対または設定済み公開URL |
| `next/font/google` | self-hosted fontまたはCSS font stack |

ローカルツールのためmetadata生成でrequest hostを読む必要はない。OG画像URLに絶対URLが必要な公開配信を行う場合だけ、ビルド時の`VITE_PUBLIC_ORIGIN`から生成する小さなHTML transformを追加する。未設定時に架空の本番originを埋め込まない。

フォントは外部CDNへの実行時依存を作らず、既存のフォントファイルをself-hostするか、システムフォントへ明示的に切り替える。

### 6.5 Sitesとの境界

`.openai/hosting.json`は保持する。`build/sites-vite-plugin.ts`も、ビルド後に`dist/.openai/`へhosting metadataとmigrationをコピーする責務に限定して保持する。

移行後の`vite.config.ts`からは次を外す。

- `vinext()`
- `@cloudflare/vite-plugin`
- RSC、SSR用のVite environment
- `worker/index.ts`
- Vinext画像最適化

Sitesが静的な`dist/index.html`と`dist/assets/`を正しく保存・配信できることをstagingで確認する。現在のCloudflare Worker固有entryをSites側が必須とすることが判明した場合は、その要件を先に記録し、Vinextを戻すのではなく静的アセット用の最小Worker adapterを別途設計する。

## 7. 依存関係の変更

### 7.1 維持

- `react`
- `react-dom`
- `vite`
- `@vitejs/plugin-react`
- `typescript`
- `eslint`
- Tailwind／PostCSS関連
- Drizzle関連
- Wrangler

WranglerはSitesのデプロイや別のCloudflare資源管理で必要かを最終監査し、利用箇所がなければその時点で削除する。

### 7.2 削除

- `next`
- `vinext`
- `@vitejs/plugin-rsc`
- `react-server-dom-webpack`
- `eslint-config-next`

### 7.3 条件付きで削除

- `@cloudflare/vite-plugin`
  - Viteビルドで利用しなくなるため削除候補
  - Sitesの実デプロイ要件を確認してから確定する

依存を削除した後、lockfileも更新し、`npm ls`でextraneousまたはinvalidな依存がないことを確認する。

## 8. package scripts

目標:

```json
{
  "scripts": {
    "dev": "node scripts/dev.mjs",
    "dev:web": "vite --host 127.0.0.1 --port 3000",
    "build": "vite build",
    "preview": "vite preview --host 127.0.0.1 --port 3000",
    "start": "node server/local-api.mjs",
    "test": "npm run build && node --experimental-strip-types --test tests/*.test.mjs",
    "lint": "eslint . --ignore-pattern dist"
  }
}
```

`scripts/dev.mjs`の二プロセス管理は維持するが、子プロセス終了時の伝播とSIGINT/SIGTERM処理を回帰テストする。

## 9. 実装フェーズ

### Phase 0: ベースライン固定

実施内容:

- 現行の全テスト、lint、buildを成功させる
- 主要UI操作のスクリーンショットを保存する
- Codex Thread作成、Turn開始、Stop、承認、再接続を確認する
- 現在の`dist/`構造とSites deploymentを記録する
- rootと`workspaces/northstar`のgit状態を記録する

完了条件:

- 移行前の比較対象と既知の問題が記録されている
- ユーザーの未コミット変更と移行変更の境界が明確である

### Phase 1: React SPAエントリの作成

実施内容:

- `index.html`を作成する
- `src/main.tsx`を作成する
- `app/page.tsx`を`src/App.tsx`へ移す
- `app/codex/`を`src/codex/`へ移す
- `app/globals.css`を`src/globals.css`へ移す
- `"use client"` directiveを削除する
- `app/layout.tsx`のmetadataとfont責務を置き換える

このPhaseではUIロジックを再設計しない。import path、エントリ、環境変数への参照だけを変更する。

完了条件:

- Vite dev serverで現行UIが表示される
- reducer unit testが変更なし、またはimport path変更だけで通る
- Reactのconsole errorとhydration概念に関する警告がない
- StrictModeでイベントストリームが二重購読されてもcleanupが正しく動く

### Phase 2: APIの同一オリジン化

実施内容:

- APIベースを`/api`へ変更する
- Vite dev proxyを追加する
- CORS前提の開発コードを削減する
- ローカルAPIへ静的配信とSPA fallbackを追加する
- API、NDJSON、静的アセットで適切なheadersを返す
- `npm start`を単一プロセス構成にする

完了条件:

- 開発環境で全APIとNDJSONストリームがproxy経由で動く
- `npm run build && npm start`後、4317番だけでUIとAPIが動く
- `http://127.0.0.1:4317/api/state`が正常応答する
- ブラウザ更新時もSPAが404にならない
- path traversalと未知のasset requestが安全に拒否される

### Phase 3: Vinext／Next／RSCの撤去

実施内容:

- `vite.config.ts`を標準React plugin構成へ変更する
- `worker/index.ts`を削除する
- Next.js固有依存を削除する
- `tsconfig.json`からNext plugin、`.next`、`next-env.d.ts`を削除する
- Next向けESLint設定を標準React／TypeScript設定へ置き換える
- `.next`前提のignoreとスクリプトを削除する
- lockfileを更新する

完了条件:

- production sourceに`next/*`、`vinext/*`、RSC importが存在しない
- `npm ls next vinext @vitejs/plugin-rsc react-server-dom-webpack`が空である
- Vite buildが一つのclient environmentだけを生成する
- `dist/`にRSC payload、SSR bundle、Vinext Worker bundleが存在しない

### Phase 4: テストの置換

実施内容:

- Vinext SSR Workerを直接importする`rendered-html.test.mjs`を削除または置換する
- `dist/index.html`とhash付きassetのbuild contract testを追加する
- ローカルAPIの静的配信テストを追加する
- Vite proxy越しのNDJSONストリーム統合テストを追加する
- ブラウザE2Eで初期表示と主要操作を検証する

最低限のテスト項目:

- editor shellが表示される
- deck stateを取得できる
- Thread一覧、作成、再開ができる
- Turnを開始し、deltaとcompletionが描画される
- Stopを連打しても一度だけinterruptされる
- 承認と追加質問へ回答できる
- ページ再読込後に実行中Turnを復元できる
- API停止時に接続エラーを表示し、復旧後に再接続する
- 100 KBを超えるcommand outputが引き続き制限される
- 未知のCodexイベントでUIが壊れない
- production static serverが正しいMIME、cache、404を返す

完了条件:

- 既存のCodex client、router、service、reducerテストがすべて通る
- SSRの存在を前提とするテストが残っていない
- build、unit、integration、browser E2E、lint、`git diff --check`が通る

### Phase 5: Sites検証とクリーンブレーク

実施内容:

- `dist/.openai/hosting.json`が生成されることを確認する
- stagingへ保存・デプロイし、静的assetとSPA shellを確認する
- hosted UIでローカルCodex機能を提供しない場合、その制約を画面とリリースノートに明記する
- 旧`app/`、Worker、Vinext設定、不要依存を完全に削除する
- READMEとrelease notesを更新する

完了条件:

- ローカル開発、ローカル本番、Sites stagingの三経路が定義どおり動く
- 旧ランタイムへfallbackするコードやfeature flagがない
- 移行後に保持すべき`.weave`データとgit履歴が変更されていない
- rollbackはコード内の互換層ではなく、移行前git commitへの復帰で行える

## 10. テスト戦略

### 10.1 Unit

- Codex reducerとselectors
- ストリームevent action変換
- 静的ファイルpath解決
- MIME typeとcache policy
- SPA fallback判定

### 10.2 Integration

- Vite proxyからローカルAPIへのHTTP転送
- NDJSON reconnectと`after` sequence replay
- Node静的サーバーとAPI routerの共存
- build後の`dist/`構造

### 10.3 Browser E2E

- Vite dev mode
- `npm start` production mode
- API接続中／切断中／再接続後の表示
- Codex app-serverを使う実Turn

ブラウザテストでは見た目だけでなく、console error、失敗request、重複ストリーム接続も検査する。

### 10.4 Sites smoke test

- `/`が200
- JavaScriptとCSS assetが200
- metadataが存在する
- asset URLがdeployment originで解決できる
- `.openai/hosting.json`が成果物へ含まれる

## 11. 移行リスクと対策

| リスク | 対策 |
|---|---|
| StrictModeでeffectが再実行され、ストリームが二重接続される | effect cleanupとAbortControllerをE2Eで検証する |
| Vite proxyがNDJSONをbufferする | 実deltaを使った統合テストで逐次到着を確認する |
| 固定API URLの削除でテスト環境が接続不能になる | 相対URLを既定とし、テスト時だけ環境変数で上書きする |
| Node静的配信にpath traversalが入る | decode、normalize、root containmentをunit testする |
| SPA fallbackが存在しないassetにもHTMLを返す | 拡張子またはasset prefixを判定して404にする |
| `next/font`削除でレイアウトが変わる | self-hosted fontと移行前後のvisual regressionで確認する |
| SSR削除で初期HTMLが空になる | ローカルツールとして許容し、loading shellを`index.html`へ置くかUX測定で判断する |
| Sitesが現在のWorker entryを前提としている | Phase 0で成果物契約を記録し、Phase 5でstaging検証する |
| hosted HTTPS UIからloopback APIへの接続が制限される | 今回はローカル本番を正規経路とし、hosted companion protocolは別設計にする |
| 移行とUIリファクタが混ざる | import、entry、transport以外の変更を移行完了後へ分離する |

## 12. データ移行

フロントエンドランタイムだけを変更するため、データ形式の移行は行わない。

保持対象:

- `.weave/deck.json`
- `.weave/current-buffer.json`
- `slides/`
- git commitとbranch
- Codex app-server Threads
- 生成済みCodex protocol bindings

削除や再生成をしてはならない。

ブラウザ内の一時UI状態は従来どおり永続化対象外とする。将来localStorageを導入する場合は、この移行と分離した設計判断を行う。

## 13. 完了判定

次のすべてを満たした時点で移行完了とする。

- ReactはViteの標準client entryから起動する
- Next.js、Vinext、RSC、Cloudflare Worker entryに実行時依存しない
- 開発時は`http://localhost:3000`で動く
- ローカル本番時は`http://127.0.0.1:4317`だけでUIとAPIが動く
- API URLが通常のsource codeに固定されていない
- Codex Thread、Turn、Item、Stop、承認、MCPが回帰していない
- NDJSONの切断、再接続、replayが回帰していない
- Sites用metadataを含む静的成果物を生成できる
- 全自動テスト、browser E2E、lint、build、差分検査が成功する
- Northstar workspaceとユーザーデータに意図しない変更がない
- 旧構成と新構成の二重実装が残っていない

## 14. 実施順序の判断

実装はPhase 0から順に行う。特に、次の二つを先に変更しない。

1. UIロジックの大規模分割
2. Codex app-server統合の再設計

今回の目的はフロントエンド実行基盤の単純化であり、移行と同時にアプリケーション設計まで変更すると、回帰原因の特定が難しくなるためである。

移行完了後に、肥大化した`App.tsx`のfeature単位分割、API clientの共通化、React Router導入の要否を別計画として評価する。
