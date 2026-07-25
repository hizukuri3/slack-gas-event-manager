# セットアップ手順

構築する人向けのドキュメントです。前提条件・デプロイ運用の全体像・新しい環境の構築手順・環境変数（スクリプトプロパティ）の一覧をまとめています。システムの概要やアーキテクチャは [README](../README.md) を参照してください。

## 前提条件と準備するもの

| 準備するもの | 補足 |
|---|---|
| Googleアカウント | フォーム・スプレッドシート・カレンダー・GASを使います。生成物を共有ドライブに置く場合は、そのドライブへの編集権限が必要です |
| Slackワークスペース | **無料プランで動作可**。Slack Appを作成できる権限が必要です |
| [clasp](https://github.com/google/clasp)（Node.js 環境） | **必須**。リポジトリのコードをGASプロジェクトへ入れるのに使います（初回投入・CIデプロイの両方で使用）。`npm install -g @google/clasp@2.4.2` |
| GitHubリポジトリへの権限 | 継続的にデプロイ運用する場合。Environments 変数の登録に使います |

## デプロイ運用の全体像（dev / prod）

このリポジトリは **dev / prod の2環境プロモーション運用**です（[.github/workflows/deploy.yml](../.github/workflows/deploy.yml)）。

- デフォルトブランチは **`dev`**。日々のPRは dev に出す → マージで **verification 環境**（検証用GAS）へ自動デプロイ。
- **`dev → prod` のPRマージ**で **production 環境**（本番GAS）へデプロイ。
- デプロイ先はマージ先ブランチで切り替わります（`prod` → production、それ以外（dev）→ verification）。
- 各環境の **scriptId / deploymentId は GitHub Environments の変数**（`SCRIPT_ID` / `DEPLOYMENT_ID`）で環境ごとに保持します。Google認証（`CLASPRC_JSON`）は**リポジトリ共通の Secret**（同じGoogleアカウントで両環境へ push できるため）。
- デプロイが走るのは **`src/**` を含むPRのマージ時のみ**。ドキュメントだけのPRではデプロイしません。

> **環境変数が未登録だと安全側に落ちます:** 選ばれた環境に `SCRIPT_ID` / `DEPLOYMENT_ID` が無いと、deploy.yml が理由つきで即失敗します（例: production 環境の変数が空のまま `prod` へマージした場合）。

## 新しい環境を立てる手順（bootstrap 前提）

本番や新しい期など、まっさらなインスタンスを1つ立ち上げる手順です。各環境は **GASプロジェクト・スプレッドシート・フォーム・カレンダー・Slack App がすべて別物**になります。以下は一度だけ行う初期構築です。

作業の流れ:

1. GASプロジェクトを作る
2. clasp でコードを入れる
3. `bootstrap()` を実行して実体（スプシ・フォーム・カレンダー）を生成する
4. 手動作業（共有ドライブへ移動・カレンダー公開）
5. Slack App を作る
6. Slack系プロパティを登録し `setupTriggers()` を実行する
7. Webアプリを公開して Slack と接続する
8. GitHub Environment に変数を登録して CI 自動デプロイを有効化する

### 1. GASプロジェクトの作成

[script.google.com](https://script.google.com) でスタンドアロン型のプロジェクトを新規作成します（トップページから作成。スプレッドシートからではありません）。`clasp create --type standalone` でも作れます。

### 2. clasp でコードを入れる

1. clasp をインストール: `npm install -g @google/clasp@2.4.2`
2. ログイン: `clasp login`（ブラウザで承認 → `~/.clasprc.json` が生成されます）
3. 手元に対象プロジェクトを紐づけます。既存プロジェクトなら、リポジトリ直下に `.clasp.json` を用意します（`.gitignore` 済み）。
   ```json
   { "scriptId": "＜作成したプロジェクトのscriptId＞", "rootDir": "src" }
   ```
4. コードを送る: `clasp push`

> `clasp` を使わずGASエディタへ全 `.gs` を手でコピー&ペーストしても構いませんが、ファイル数が多いので clasp を推奨します。`appsscript.json` は「プロジェクトの設定」→「appsscript.json マニフェスト ファイルをエディタで表示する」をオンにすると編集できます（clasp push なら自動反映）。

### 3. `bootstrap()` で実体を生成

1. スクリプトプロパティに **`COHORT_NAME`**（任意）を登録します。生成ファイル名の接頭辞になります（例: `Bridge2027.03`）。
2. GASエディタで **`bootstrap()` を選んで実行**します（初回は権限承認ダイアログが出るので許可）。以下が自動で行われます。
   - 管理用スプレッドシート（`運営データ（管理用）`）・公開用（`イベント一覧（公開用）`）を作成
   - 弟子用・師匠用フォームを規定の設問構成（後述の FORM_SPEC）で作成
   - イベント用カレンダーを作成
   - 生成物のIDをスクリプトプロパティへ自動保存（`MANAGEMENT_SPREADSHEET_ID` など）
   - `setupPrefillEntryIds()` を実行し、フォームの事前入力エントリIDを登録
3. 冪等です。既にIDが入っているものは作り直しません。再実行しても重複は作られません。

> **Slackを先に入れておくと一気に完了します:** `bootstrap()` は、`SLACK_BOT_TOKEN` などSlack系プロパティが未登録だと「次にSlackを入れて `setupTriggers()` を」と案内して正常終了します。手順6のSlackプロパティを先に登録しておけば、`bootstrap()` の1回実行で手順6の `setupTriggers()` まで自動的に流れます。

### 4. 手動作業（共有ドライブへ移動・カレンダー公開）

`bootstrap()` の実行ログの案内に従います。ここは意図的に手作業です（プログラムに共有ドライブ操作や外向きの公開をさせない方針）。

1. **生成物を共有ドライブへ移動:** スプレッドシート・フォームは実行者のマイドライブに作られます。Driveの画面で目的の共有ドライブフォルダへドラッグしてください。**移動してもファイルIDは変わらない**ので、保存済みのIDはそのまま有効です。
2. **カレンダーを一般公開:** カレンダー設定 →「アクセス権限」→「一般公開して誰でも利用できるようにする」をオンにし、権限は「予定の表示（すべての予定の詳細）」を選びます（メンバー全員が同一組織なら組織内共有でも可）。ここが非公開だと、告知の「:calendar: カレンダーを開く」を押してもメンバーに中身が見えません。

### 5. Slack Appの作成

Slack App の構成（スコープ・スラッシュコマンド・Interactivity）は [`slack/manifest.yml`](../slack/manifest.yml) が**唯一の正**です。管理画面を手作業で設定する代わりに、このマニフェストを貼り付けて作成します。

1. [api.slack.com/apps](https://api.slack.com/apps) →「Create New App」→ **「From an app manifest」** を選び、ワークスペースを指定します。
2. YAML を選び、[`slack/manifest.yml`](../slack/manifest.yml) の中身を貼り付けて Create します。
   - この時点では Request URL は `REPLACE_WITH_EXEC_URL` のプレースホルダのままで構いません（GAS をデプロイした後、手順7で実URLに差し替えます）。
   - マニフェストには `chat:write` / `users:read` / `im:write` / `channels:history` / `commands` のスコープと `/event` コマンドが含まれています。
3. **Install to Workspace** でインストールし、表示される **Bot User OAuth Token（`xoxb-` で始まる文字列）** を控えます。
4. 告知チャンネルにBotを招待します（チャンネルで `/invite @アプリ名`）。**招待を忘れると告知が投稿できません。**
5. チャンネルIDを控えます（チャンネル名を右クリック →「リンクをコピー」→ URL末尾の `C` で始まる文字列）。

> **マニフェストの運用ルール:** `slack/manifest.yml` は public リポジトリにあるため、トークン類は書かず、`/exec` URL もプレースホルダのまま commit します。実URLを埋めた貼り付け用ファイルをローカルに置く場合は `slack/manifest.local.yml`（`.gitignore` 済み）を使ってください。設定を変更するときは、まず `slack/manifest.yml` を編集 → Slack App の **App Manifest** タブに貼り付けて Save、という順で反映します。**スコープを増減したときだけ、アプリの再インストール（OAuth 承認）が必要**です。

### 6. スクリプトプロパティの登録と初期化

1. 後述の「環境変数一覧」の**手動で登録するもの**に従い、Slack系プロパティ（`SLACK_BOT_TOKEN`・`SLACK_CHANNEL_ID` など）を登録します。
2. GASエディタで **`setupTriggers`** を選んで**手動で1回実行**します。以下が自動で行われます。
   - フォーム送信トリガー・公開用シート定期同期トリガー（5分毎）の登録
   - 両スプレッドシートへのシート自動作成
   - フォームの「開催形式」「会場URL または 開催場所」の設問への入力ヒント設定（無料版Meetの60分制限と予定分割の説明）
   - ※手順3でSlackプロパティを先に入れていた場合は、`bootstrap()` 実行時にここまで済んでいます。

### 7. GAS Webアプリのデプロイ と Slackとの接続

1. GASエディタ右上「デプロイ」→「新しいデプロイ」→ 種類「**ウェブアプリ**」を選び、以下で設定します。
   - 次のユーザーとして実行: **自分**
   - アクセスできるユーザー: **全員**
2. 発行された `https://script.google.com/macros/s/…/exec` のURLを控えます（`WEBAPP_URL` にも登録します）。**このとき作られるデプロイのIDが、手順8で登録する `DEPLOYMENT_ID` になります**（「デプロイを管理」で確認できます）。
3. 手順5で貼り付けたマニフェストの Request URL を、実際の `/exec` URL に差し替えます。
   - `slack/manifest.yml` 内の `REPLACE_WITH_EXEC_URL` を実URLに置換したものを用意し（ローカルの `slack/manifest.local.yml` に保存すると管理しやすい）、Slack App の **App Manifest** タブに貼り付けて **Save Changes** します。
   - これで Interactivity の Request URL（ボタン押下用）と `/event` の Request URL が両方まとめて設定されます。Event Subscriptions は不要です。
   - **`commands` スコープを含むマニフェストで保存した後は、アプリを再インストール**してください（トークンは変わりません）。

> **署名検証についての注記:** GASのWebアプリはHTTPリクエストヘッダーを参照できないため、`X-Slack-Signature` ヘッダーと `SLACK_SIGNING_SECRET` によるHMAC署名検証は実装できません。本システムでは代替として、Slack App の Basic Information にある **Verification Token** をペイロードの `token` と照合する簡易検証を行います（`SLACK_VERIFICATION_TOKEN` 未設定時は検証をスキップします）。
>
> **応答速度についての注記:** Slackはボタン押下への応答を3秒以内に求めます。GASのコールドスタート時はまれに超過し、押した本人に「応答に失敗した」旨の警告が表示されることがありますが、**処理自体は正常に完了しており**、メッセージの再描画で結果を確認できます。

### 8. CI 自動デプロイの有効化（GitHub Environment 変数の登録）

以降のコード更新を自動デプロイに乗せるための設定です。

1. GitHub の **Settings → Environments** で、対象の環境（検証用なら `verification`、本番なら `production`）を開きます。
2. その環境に **変数** を登録します。
   - `SCRIPT_ID` … 手順1で作ったGASプロジェクトの scriptId
   - `DEPLOYMENT_ID` … 手順7で作った最初のデプロイのID
3. Google認証の Secret `CLASPRC_JSON`（`clasp login` で生成した `~/.clasprc.json` の中身）は**リポジトリ共通**で登録します（未登録の場合）。
   ```bash
   gh secret set CLASPRC_JSON < ~/.clasprc.json
   ```
4. 以降は、**dev へのマージ → verification**、**`dev → prod` のマージ → production** で、`src/**` を含む変更が自動デプロイされます。既存のデプロイIDを指定して再デプロイするため **`/exec` URL は変わりません**。

## フォームの設問構成（参考）

`bootstrap()` が生成するフォームは以下の設問構成（コード上の `FORM_SPEC`）です。**設問タイトルは下表と完全一致**している必要があります（GASはタイトル文字列で回答を照合するため）。手動でフォームを作り直す場合の参照用に残します。

| # | 設問タイトル | 形式 | 必須 |
|---|---|---|---|
| 1 | イベント名 | 記述式（短文） | ✓ |
| 2 | 主催者のSlackユーザーID | 記述式（短文） | ✓ |
| 3 | 開始日時 | 日付（**「時刻を含める」をオン**） | ✓ |
| 4 | 終了時刻 | 時刻 | ✓ |
| 5 | 定員 | 記述式（回答の検証: 数値） | ✓ |
| 6 | イベントのステータス | ラジオボタン「開催 / 中止」 | ✓ |
| 7 | 開催形式 | ラジオボタン「①オンライン・自動発行 / ②オンライン・手動URL / ③オフライン・対面」 | ✓ |
| 8 | 会場URL または 開催場所 | 記述式（①の場合は空欄可） | － |
| 9 | 概要・対象者 | 段落 | ✓ |
| 10 | 事前準備・持ち物・資料リンク | 段落 | － |

手動で作成する場合は、フォームの「設定」タブで以下も必須です。

| 設定項目 | 値 | 理由 |
|---|---|---|
| メールアドレスを収集する | **オフ** | 個人情報保護仕様のため |
| 回答を1回に制限する | **オフ** | オンだと編集URLの挙動が変わるため |
| 回答の編集を許可する | **オン** | 変更・中止フローに必須のため |

## 環境変数（スクリプトプロパティ）一覧

ソースコード内にトークンやIDはハードコードしていません。設定値はすべてGASの「スクリプト プロパティ」で管理します。登録の担い手で3種類に分かれます。

### `bootstrap()` が自動登録するもの

手順3の `bootstrap()` 実行で、生成した実体のIDが自動登録されます（手動で入れる必要はありません）。

| プロパティ名 | 値 |
|---|---|
| `MANAGEMENT_SPREADSHEET_ID` | 管理用スプレッドシートのID |
| `PUBLIC_SPREADSHEET_ID` | 公開用スプレッドシートのID |
| `GOOGLE_CALENDAR_ID` | イベント用カレンダーのID |
| `GOOGLE_FORM_ID` | 弟子用フォームのID |
| `MASTER_FORM_ID` | 師匠用フォームのID |

### 手動で登録するもの

GASエディタの **「プロジェクトの設定」→「スクリプト プロパティ」** から登録します。

| プロパティ名 | 設定する値 | 必須 |
|---|---|---|
| `COHORT_NAME` | 生成ファイル名の接頭辞（例: `Bridge2027.03`）。**`bootstrap()` の実行前**に登録 | 任意 |
| `SLACK_BOT_TOKEN` | Bot User OAuth Token（`xoxb-…`）※コード上のダミー: `YOUR_SLACK_BOT_TOKEN` | ✓ |
| `SLACK_VERIFICATION_TOKEN` | Slack App の Basic Information → Verification Token | 推奨 |
| `SLACK_SIGNING_SECRET` | Slack App の Signing Secret ※GASの制約により現状未使用（手順7の注記参照）。将来の移行に備えて登録可 | － |
| `SLACK_CHANNEL_ID` | 告知チャンネルのID（`C…`） | ✓ |
| `WEBAPP_URL` | WebアプリのURL（`…/exec`） | 推奨※1 |
| `MASTER_SLACK_USER_IDS` | 師匠のSlackユーザーID（カンマ区切りで複数可。例: `U11111,U22222`）。登録者が `/event` を打つと師匠用フォームのリンクだけが返る。種別の判定には使わない | 任意 |

※1 `WEBAPP_URL` は、告知メッセージ・カレンダー説明欄に載せる**参加者確認ページのURLを組み立てるためだけ**に使われます（Slackとの接続はSlack App側に設定したRequest URLで行われるため、このプロパティとは無関係です）。未登録でもGASがデプロイ済みURLの自動取得を試み、それにも失敗した場合は参加者確認URLの掲載が省略されるだけで、予約・キャンセル・告知などの本体機能には影響しません。ただし自動取得は実行コンテキストによって安定版の `/exec` 以外のURLを返すことがあるため、明示的な登録を推奨します。

### `setupPrefillEntryIds()` が自動登録するもの

`bootstrap()` が内部で実行するため、通常は手動登録不要です（手動登録する場合は `entry.123456` の数値部分。`entry.` 付きでも可）。

| プロパティ名 | 自動登録される値 |
|---|---|
| `FORM_ENTRY_ORGANIZER` | 弟子用フォーム「主催者のSlackユーザーID」設問のエントリID |
| `FORM_ENTRY_STATUS` | 弟子用フォーム「イベントのステータス」設問のエントリID |
| `FORM_STATUS_OPEN_VALUE` | ステータス設問の「開催」を表す選択肢の文字列（フォームの選択肢と完全一致） |
| `MASTER_FORM_ENTRY_ORGANIZER` | 師匠用フォームの「主催者のSlackユーザーID」設問のエントリID |
| `MASTER_FORM_ENTRY_STATUS` | 師匠用フォームの「イベントのステータス」設問のエントリID |

これらが未設定でも `/event` は動作しますが、リンクが事前入力なしの素のフォームURLになります。Slackの3秒ルール対策として、`/event` の応答経路では `FormApp` を使わず、これらの固定値との文字列結合だけで事前入力URLを組み立てています。フォームの設問を作り直した場合は、`setupPrefillEntryIds()` を再実行してください。
