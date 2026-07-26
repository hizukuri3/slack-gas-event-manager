# 開発ガイド（Fork して継続開発する人向け）

このリポジトリを **Fork して改造・機能追加し、自分たちのdev/prod環境へ配信していく**人向けのドキュメントです。単に自分のコミュニティで動かしたいだけなら [SETUP.md](SETUP.md) だけで完結します（CIやブランチ運用は不要）。システムの構造は [README](../README.md) を参照してください。

## 開発の前提

- 本体は Google Apps Script（`.gs`）です。GitHub 上のコードと GAS プロジェクトは別物で、`clasp` で橋渡しします。
- コミュニティごと・期ごとに Fork して、それぞれ独立したインスタンス（GASプロジェクト・スプシ・フォーム・カレンダー・Slack）を持つ運用を想定しています。
- 秘匿情報（トークン・ID）はコードに書かず、すべて GAS のスクリプトプロパティ、GitHub の Secret / Environment 変数で管理します。

## 必要なツール

開発（Fork してコードを編集し、GASへ配信する）には、手元に次のツールが必要です。何も入っていない状態からの入手先も記します。

| ツール | 用途 | 入手 / 確認 |
|---|---|---|
| **git** | リポジトリの取得・変更管理 | [git-scm.com](https://git-scm.com/downloads)（Mac: `brew install git` / 多くの環境で標準搭載）。`git --version` で確認 |
| **Node.js（v20 推奨）+ npm** | clasp の実行に必要 | [nodejs.org](https://nodejs.org/) の LTS を入れると npm も同梱。`node -v` / `npm -v` で確認 |
| **@google/clasp（2.4.2）** | GAS へのコード配信 | `npm install -g @google/clasp@2.4.2`（下記「ローカル開発環境」で使用） |
| （任意）**GitHub CLI `gh`** | Secret 登録などに便利 | [cli.github.com](https://cli.github.com/) |
| Googleアカウント / Slackワークスペース | GAS・カレンダー・Slack App の作成 | 無ければ Slack は [slack.com/create](https://slack.com/create) で新規作成 |

> コードを触らず「一度動かすだけ」なら、これらのインストールは不要です（ブラウザだけで完結する手順が [SETUP.md](SETUP.md) にあります）。

## リポジトリを手元に用意する（Fork & clone）

1. GitHub でこのリポジトリを **Fork** します（自分たちの改造やdev/prod運用を持つ場合）。単に読み書きしたいだけで権限があるなら Fork せず直接 clone でも構いません。
2. 手元に clone します。
   ```bash
   # Fork した場合は hizukuri3 を自分のアカウント/組織名に置き換え
   git clone https://github.com/hizukuri3/slack-gas-event-manager.git
   cd slack-gas-event-manager
   ```
3. 以降の `clasp` 操作・`.clasp.json` の作成は、この clone したディレクトリの直下で行います。

## ローカル開発環境（clasp）

📍 **作業する画面:** ターミナル（`clasp login` の承認だけブラウザ）

clone したディレクトリで、GASプロジェクトと橋渡しする clasp を使います（インストールは上の「必要なツール」を参照）。

1. Googleアカウントでログイン（`~/.clasprc.json` が生成されます。これがGAS認証情報）。
   ```bash
   clasp login
   ```
   > **初回だけの前提:** [script.google.com/home/usersettings](https://script.google.com/home/usersettings) で「**Apps Script API**」をオンにしてください。オフのままだと次の `clasp create` / `clasp push` が `User has not enabled the Apps Script API` で失敗します。
2. GASプロジェクトを用意して紐づけます。ここで作られる/置く `.clasp.json` は `.gitignore` 済みなので**コミットしないこと**。
   - **新規に作る（既存プロジェクトが無いとき／通常はこちら）** — ターミナルからそのまま作成できます。
     ```bash
     clasp create --type standalone --title "＜プロジェクト名＞" --rootDir src
     ```
     新しいGASプロジェクトが作成され、その scriptId を含む `.clasp.json` がリポジトリ直下に自動生成されます。生成された `.clasp.json` に `"rootDir": "src"` が入っているか確認し、無ければ追記してください（コードは `src/` 配下にあるため）。
   - **既存プロジェクトを使う** — `clasp clone <scriptId>` で手元に取得するか、`.clasp.json` を手書きします。
     ```json
     { "scriptId": "＜対象プロジェクトのscriptId＞", "rootDir": "src" }
     ```
3. コードを送る / 取り込む。
   ```bash
   clasp push      # 手元の src/ をGASへ
   clasp pull      # GAS側の変更を手元へ
   ```

`appsscript.json`（マニフェスト）も `src/` にあり、`clasp push` で反映されます。GASエディタで直接見るには「プロジェクトの設定」→「appsscript.json マニフェスト ファイルをエディタで表示する」をオンにします。

## ブランチ運用とデプロイの仕組み（dev / prod）

このリポジトリは **dev / prod の2環境プロモーション運用**です（[.github/workflows/deploy.yml](../.github/workflows/deploy.yml)）。

- デフォルトブランチは **`dev`**。日々のPRは dev に出す → マージで **verification 環境**（検証用GAS）へ自動デプロイ。
- **`dev → prod` のPRマージ**で **production 環境**（本番GAS）へデプロイ。
- デプロイ先はマージ先ブランチで切り替わります（`prod` → production、それ以外（dev）→ verification）。
- 各環境の **scriptId / deploymentId は GitHub Environments の変数**（`SCRIPT_ID` / `DEPLOYMENT_ID`）で環境ごとに保持します。Google認証（`CLASPRC_JSON`）は**リポジトリ共通の Secret**（同じGoogleアカウントで両環境へ push できるため）。
- デプロイが走るのは **`src/**` を含むPRのマージ時のみ**。ドキュメントだけのPRではデプロイしません。
- デプロイは既存のデプロイIDを指定して再デプロイするため、**`/exec` URL は変わりません**。

```
機能ブランチ ──PR──> dev ──マージ──> verification 環境へ自動デプロイ
                       └──PR──> prod ──マージ──> production 環境へ自動デプロイ
```

> **環境変数が未登録だと安全側に落ちます:** 選ばれた環境に `SCRIPT_ID` / `DEPLOYMENT_ID` が無いと、deploy.yml が理由つきで即失敗します（例: production 環境の変数が空のまま `prod` へマージした場合）。

## CI 自動デプロイの有効化（GitHub 側の設定）

📍 **作業する画面:** GitHub（Settings → Environments）＋ ターミナル（`gh` を使う場合）

新しく環境（verification / production）を自動デプロイに乗せるための、一度きりの設定です。前提として、その環境のGASプロジェクトが作成済みで、最初のWebアプリ・デプロイが1つ存在している必要があります（作り方は [SETUP.md](SETUP.md) 参照）。

1. GitHub の **Settings → Environments** で対象環境（`verification` / `production`）を作成/選択する。
2. その環境に **変数** を登録する（Web UI、または `gh variable set <名前> --env <環境名> --body "<値>"`）。
   - `SCRIPT_ID` … 対象GASプロジェクトの scriptId
   - `DEPLOYMENT_ID` … 対象の（最初の）デプロイID。GASエディタ「デプロイを管理」または `clasp deployments` で確認できる（初回デプロイの作成は GAS UI もしくは `clasp deploy`）
3. Google認証の Secret `CLASPRC_JSON` を**リポジトリ共通**で登録する（未登録の場合のみ）。
   ```bash
   gh secret set CLASPRC_JSON < ~/.clasprc.json
   ```
4. 以降は、dev へのマージ → verification、`dev → prod` のマージ → production で、`src/**` を含む変更が自動デプロイされます。

## コード構成

各ファイルの役割は [README のリポジトリ構成](../README.md#リポジトリ構成) を参照してください。ポイント:

- `Config.gs` … スクリプトプロパティの読み込みと定数（`FORM_TITLES`・列定義など）。設定値の入口はここに集約。
- `Bootstrap.gs` … 新インスタンスの初期構築（スプシ・フォーム・カレンダー生成）。フォームの設問定義 `formSpec_()` を持つ。
- `FormHandler.gs` … フォーム送信の処理本体。設問タイトルで回答を照合するため、`FORM_TITLES` / `formSpec_()` と設問名の一致が要。
- `InteractionHandler.gs` … Slackボタン押下の処理（予約・キャンセル・定員・繰り上げ）。
- `Repository.gs` … スプレッドシート読み書き（管理用・公開用のミラーリング）。

アーキテクチャ全体像とデータ構造は [README](../README.md) にあります。

## 変更を入れるときの流れ

1. `dev` から機能ブランチを切る。
2. `clasp push` で検証用プロジェクトに反映して動作を確認する（または verification へマージして確認）。
3. PR を `dev` に出す → マージで verification へ自動デプロイ。
4. 検証できたら `dev → prod` のPRで本番へ昇格。
