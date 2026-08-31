// ci: deploy test
/**
 * Config.gs
 * スクリプトプロパティから設定値を読み込む。
 * ソースコード内に固有情報（トークン・ID類）をハードコードしないこと。
 * 実際の値は GAS エディタの「プロジェクトの設定 > スクリプト プロパティ」に登録する。
 */

// ---- シート名 ----
const SHEET_EVENT_MASTER = 'イベントマスター';
const SHEET_PARTICIPANTS = '参加者リスト';
// 絵文字リアクション転送用。管理用①にのみ作り、公開用②へは同期しない
const SHEET_RELAY_MAPPING = '絵文字転送マッピング';
const SHEET_RELAY_LOG = '絵文字転送ログ';
// 師匠リスト。管理用①にのみ作り、公開用②へは同期しない（運用設定のため）
const SHEET_MASTER_LIST = '師匠リスト';
// Discord VCの在庫台帳。管理用①にのみ作る（運用設定のため）
const SHEET_VC_ROOMS = 'VCルームリスト';

// 人が編集するシートの「有効」列の見出し。
// 空欄が有効を意味することを、シートを開いた人の目に入る場所で伝えるための文言。
// データ行へ「有効」と書き込めば同じことは伝わるが、人が書くシートに
// システムが値を入れることになるので、システムが元から作るヘッダー行で伝える。
// GASはファイル内の const を上から評価するため、これを使うヘッダー定義より前に置く
const ENABLED_HEADER = '有効（未入力＝有効）';

// ---- 参加者の状態 ----
const PSTATUS = {
  JOINED: '参加',
  WAITLIST: 'キャンセル待ち',
  STAFF: '運営'  // 師匠・主催者・運営スタッフ。定員カウント・キャンセル待ちの対象外
};

// ---- イベント種別（どちらのフォームから登録されたかで一意に決まる）----
const EVENT_TYPE = {
  MASTER: '師匠',   // 師匠用フォーム（MASTER_FORM_ID）から登録されたイベント
  DISCIPLE: '弟子'  // 弟子用フォーム（GOOGLE_FORM_ID)から登録されたイベント
};

// ---- 告知メッセージのボタン action_id ----
const ACTION_JOIN = 'join_event';
const ACTION_JOIN_STAFF = 'join_event_staff';  // 運営として参加（定員外）
const ACTION_LEAVE = 'leave_event';

// ---- イベントマスターの列定義（0始まり）----
const COL = {
  EVENT_ID: 0,        // イベントID（EV_xxx）
  RESPONSE_ID: 1,     // フォーム回答ID（編集時の照合キー）
  TITLE: 2,           // イベント名
  ORGANIZER: 3,       // 主催者SlackユーザーID
  START: 4,           // 開始日時
  END: 5,             // 終了日時
  CAPACITY: 6,        // 定員
  STATUS: 7,          // ステータス（開催 / 中止）
  FORMAT: 8,          // 開催形式
  LOCATION: 9,        // 会場URL または 開催場所（Meet自動発行時はMeet URL）
  DESCRIPTION: 10,    // 概要・対象者
  PREPARATION: 11,    // 事前準備・持ち物・資料リンク
  CALENDAR_EVENT_ID: 12, // GoogleカレンダーのイベントID
  SLACK_CHANNEL: 13,  // Slack告知チャンネルID
  SLACK_TS: 14,       // Slack告知メッセージのts
  EDIT_URL: 15,       // フォーム回答編集用URL
  CREATED_AT: 16,     // 登録日時
  UPDATED_AT: 17,     // 更新日時
  TYPE: 18,           // 種別（師匠 / 弟子）
  // Discord VC開催時に確保した部屋名。LOCATION（URL）とは別に持つ。
  // URL文字列を解析して部屋を割り出すのは脆いので、被り判定はこの列だけを見る。
  // 末尾に足しているのは、既存インスタンスの列番号をずらさないため
  VC_ROOM: 19
};

const EVENT_MASTER_HEADER = [
  'イベントID', '回答ID', 'イベント名', '主催者SlackユーザーID', '開始日時', '終了日時',
  '定員', 'ステータス', '開催形式', '会場URL/開催場所', '概要・対象者', '事前準備・持ち物',
  'カレンダーイベントID', 'SlackチャンネルID', 'SlackメッセージTS', '回答編集用URL',
  '登録日時', '更新日時', '種別', 'VCルーム'
];

const PARTICIPANTS_HEADER = ['イベントID', 'SlackユーザーID', '表示名', '状態', '登録日時'];

// ---- 絵文字転送マッピングの列定義（0始まり）----
// 人が編集するシート。同じ絵文字の行を複数書けば、その全チャンネルへ転送される
const RELAY_COL = {
  EMOJI: 0,        // 絵文字名（pin / :pin: のどちらの書き方でも可）
  TO_CHANNEL: 1,   // 転送先チャンネル（#archive / archive / チャンネルID 直書きでも可）
  ENABLED: 2,      // 有効（ドロップダウン。空欄も有効。「無効」で一時的に止める）
  NOTE: 3          // メモ（処理には使わない）
};

const RELAY_MAPPING_HEADER = ['絵文字名', '転送先チャンネル', ENABLED_HEADER, 'メモ'];

// ---- 絵文字転送ログの列定義（0始まり）----
// システムが書くシート。二重転送の防止と、リアクション取り消し時の削除対象の特定に使う。
// 行は決して削除しない（監査記録として残す）。無効化は REMOVED_AT を埋める論理削除で行う
// 列順は人が読む順に並べる。「いつ・どの絵文字で・何が・どこから・どこへ」を左に置き、
// 内部の識別子（キー・ts）は普段見なくてよいので右へ寄せている
const RELAY_LOG_COL = {
  FORWARDED_AT: 0,  // 転送日時
  EMOJI: 1,         // 絵文字名（正規化済み）
  SRC_TEXT: 2,      // 転送元メッセージの本文。監査用の記録で、処理には一切使わない
  SRC_CHANNEL: 3,   // 転送元チャンネルID
  DEST_CHANNEL: 4,  // 転送先チャンネルID
  REMOVED_AT: 5,    // 取り消し日時。空なら有効な転送。埋まっていれば冪等判定の対象外
  KEY: 6,           // 一意キー（元チャンネル#元TS#絵文字名#転送先チャンネル）
  SRC_TS: 7,        // 転送元メッセージのts
  DEST_TS: 8        // 転送先メッセージのts（投稿成功後に埋まる）
};

const RELAY_LOG_HEADER = [
  '転送日時', '絵文字名', '転送元メッセージ本文', '転送元チャンネルID', '転送先チャンネルID',
  '取り消し日時', 'キー', '転送元TS', '転送先TS'
];

// ---- 師匠リストの列定義（0始まり）----
// 人が編集するシート。ここに1行足すと、その人が /event で師匠用フォームを受け取れる
const MASTER_LIST_COL = {
  USER_ID: 0,   // SlackユーザーID（U始まり。<@U123> / @U123 の形で貼り付けても可）
  NAME: 1,      // 表示名（誰の行か分かるようにするためのメモ。処理には使わない）
  ENABLED: 2,   // 有効（ドロップダウン。空欄も有効。「無効」で一時的に止める）
  NOTE: 3       // メモ（処理には使わない）
};

const MASTER_LIST_HEADER = ['SlackユーザーID', '表示名', ENABLED_HEADER, 'メモ'];

// ---- VCルームリストの列定義（0始まり）----
// 人が編集するシート。Discordに部屋を作って、ここに1行足すと予約できるようになる。
// ★ 行の並び順が優先順位そのもの ★
// 「おまかせ」の自動割り当ては上から順に空きを探すので、大きい部屋ほど下に置く。
// そうすると小さいイベントに大部屋を取られず、大部屋は最後の砦として残る。
//
// ★ 一時VC（Join-to-Create）とそのハブは絶対に登録しないこと ★
// ハブを登録すると、参加者が入った瞬間に全員バラバラの一時VCへ飛ばされる。
const VC_ROOM_COL = {
  NAME: 0,      // VC名（告知・カレンダーに出る表示名）
  URL: 1,       // チャンネルURL（https://discord.com/channels/{サーバーID}/{チャンネルID}）
  // 収容人数の目安。Discord側で人数制限をかけない運用なので実際の壁ではないが、
  // 「イベント定員を収容できる部屋」を選ぶための絞り込みに使う。
  // どの部屋でも収まらない定員が入力された場合は、その場で差し戻す番人にもなる
  CAPACITY: 2,
  // 所有者SlackユーザーID（任意）。埋まっている部屋はおまかせの在庫から外れ、
  // 本人が主催するときだけ自動で割り当てられる。
  // ★ 所有者が守るのは「おまかせ」だけ ★ 名指しは所有者を見ないので、
  // 他の人でもこの部屋を指名して予約できる（師匠の部屋を弟子が借りる運用を
  // 残すため、意図してそうしている）
  OWNER: 3,
  ENABLED: 4,   // 有効（ドロップダウン。空欄も有効。「無効」で一時的に外す）
  NOTE: 5       // メモ（処理には使わない）
};

const VC_ROOM_HEADER = [
  'VC名', 'チャンネルURL', '定員（目安）', '所有者SlackユーザーID（任意）', ENABLED_HEADER, 'メモ'
];

// 「有効」列のドロップダウンの選択肢。先頭が既定値（空欄と同じ意味）。
// 「絵文字転送マッピング」「師匠リスト」の両方で共通して使う
const ENABLED_CHOICES = ['有効', '無効'];

// 「有効」列で受け付ける書き方。ドロップダウンの選択肢と一致させ、
// 同じ意味の語を複数用意しない（判定できない値は下の classify で可視化する）。
// 真偽値（貼り付け等でチェックボックスの値が入った場合）は classify の
// 真偽値の分岐が受け持つ
const ENABLED_VALUES = ['有効'];
const DISABLED_VALUES = ['無効'];

// ---- フォームの設問タイトル（フォーム側の設問名と完全一致させること）----
const FORM_TITLES = {
  TITLE: 'イベント名',
  ORGANIZER: '主催者のSlackユーザーID',
  START: '開始日時',
  END_TIME: '終了時刻',
  CAPACITY: '定員',
  STATUS: 'イベントのステータス',
  FORMAT: '開催形式',
  VC_ROOM: 'VC部屋',
  LOCATION: '会場URL または 開催場所',
  DESCRIPTION: '概要・対象者',
  PREPARATION: '事前準備・持ち物・資料リンク'
};

// ---- 開催形式の選択肢 ----
// ここの値がフォームの選択肢そのものであり、イベントマスターに保存される値でもある。
// 判定（isAutoMeet_ / isDiscordVc_）はこの値との完全一致で行う。どれとも一致しない
// 値は validateAnswers_ が差し戻すので、フォームの選択肢を手で書き換えたときに
// 静かに挙動が変わるのではなく、その場で気づける。
//
// ★ ラベルに番号を振らないこと ★
// 「①オンライン・…」のように番号を入れると、並び順が文字列に焼き付く。選択肢を
// 足す・並べ替えるたびに保存済みの値が全部ずれ、シート上で新旧が混在してしまう。
// 並び順は EVENT_FORMAT_VALUES の並びが受け持つので、文字列に持たせる必要はない。
//
// ★ 説明はラベルではなくヘルプ文へ ★
// ラベルは保存される値なので、短く安定しているほど後から動かしやすい。
// 「60分ごとに分割される」といった説明は applyFormHints_ のヘルプ文が持つ。
// ヘルプ文は判定に使われないため、いくら書き換えても壊れない。
const EVENT_FORMATS = {
  DISCORD: 'Discord VC',
  MEET: 'Google Meet',
  MANUAL_URL: 'その他のURL',
  OFFLINE: '対面（オフライン）'
};

// フォームに並べる順序。妥当性チェックの一覧も兼ねる（単一の真実）
const EVENT_FORMAT_VALUES = [
  EVENT_FORMATS.DISCORD, EVENT_FORMATS.MEET,
  EVENT_FORMATS.MANUAL_URL, EVENT_FORMATS.OFFLINE
];

// 「VC部屋」設問の先頭の選択肢。これを選ぶと自動割り当てになる。
// 空欄を自動の合図にせず明示の選択肢にしているのは、迷ったらこれを選べば
// 確保漏れが起きないという既定の道を、選択肢の先頭に見せるため。
//
// 設問そのものは任意にしてある。Googleフォームに条件付き必須が無いため、
// 必須にすると Discord VC 以外を選ぶ主催者にまで回答を強いることになる。
// 未回答は assignVcRoom_ が「おまかせ」と同じ扱いにする。
const VC_ROOM_AUTO = 'おまかせ（自動割り当て）';

/**
 * スクリプトプロパティを読み込んで返す。
 * 必須キーが未設定の場合は例外を投げてセットアップ漏れを検知する。
 *
 * パフォーマンス注意: getProperty()（単数形）は1キーごとに外部ストレージ
 * への通信が発生し、都度呼び出すとSlackの3秒ルールを圧迫する
 * （実測: 16回で約1.1秒）。必ず getProperties()（複数形）で全キーを
 * 1回の通信でまとめて取得すること。
 */
function getConfig_() {
  const props = PropertiesService.getScriptProperties().getProperties();
  const config = {
    slackBotToken: props['SLACK_BOT_TOKEN'] || null,               // 例: YOUR_SLACK_BOT_TOKEN
    slackVerificationToken: props['SLACK_VERIFICATION_TOKEN'] || null, // Slack Event検証用（任意だが推奨）
    managementSpreadsheetId: props['MANAGEMENT_SPREADSHEET_ID'] || null, // 例: MANAGEMENT_SPREADSHEET_ID
    publicSpreadsheetId: props['PUBLIC_SPREADSHEET_ID'] || null,   // 例: PUBLIC_SPREADSHEET_ID
    calendarId: props['GOOGLE_CALENDAR_ID'] || null,               // 例: GOOGLE_CALENDAR_ID
    slackChannelId: props['SLACK_CHANNEL_ID'] || null,             // 例: SLACK_CHANNEL_ID
    formId: props['GOOGLE_FORM_ID'] || null,                       // 弟子用イベント登録フォームのID
    // 師匠用フォームのID（任意）。設問構成は弟子用と同一にすること。
    // URLは師匠のみに共有し、弟子には公開しない。
    masterFormId: props['MASTER_FORM_ID'] || null,
    webAppUrl: props['WEBAPP_URL'] || null,                        // Webアプリの/exec URL（デプロイ後に登録）
    // 師匠のSlackユーザーID一覧（カンマ区切り）。
    // /event コマンドで師匠用フォームのリンクを返す相手の判定にのみ使用する。
    // イベント種別の判定には使わない（種別は送信元フォームで決まる）。
    //
    // ★ このプロパティは手で編集しない ★
    // 正は「師匠リスト」シート（管理用①）で、この値はそこから自動生成される
    // 読み取り用キャッシュ。手で書き換えても次のシート編集で上書きされる。
    // 詳細と、キャッシュを挟んでいる理由は MasterList.gs を参照。
    masterUserIds: String(props['MASTER_SLACK_USER_IDS'] || '')
      .split(',')
      .map(normalizeSlackUserId_)
      .filter(function (id) { return id !== ''; }),
    // ---- フォーム事前入力URL用のエントリID ----
    // /event 応答内で FormApp.openById()（約1秒/回）を使わずに
    // 文字列結合だけで事前入力URLを組み立てるための固定値。
    // 値は setupPrefillEntryIds()（SlashCommand.gs・手動実行）で自動登録できる。
    // 未設定の間は事前入力なしの素のフォームURLが返る（機能は落ちない）。
    formEntries: {
      organizer: normalizeEntryId_(props['FORM_ENTRY_ORGANIZER']),   // 「主催者のSlackユーザーID」設問
      status: normalizeEntryId_(props['FORM_ENTRY_STATUS'])          // 「イベントのステータス」設問
    },
    masterFormEntries: {
      organizer: normalizeEntryId_(props['MASTER_FORM_ENTRY_ORGANIZER']),
      status: normalizeEntryId_(props['MASTER_FORM_ENTRY_STATUS'])
    },
    // ステータス設問で「開催」を表す選択肢の値（フォームの選択肢文字列と完全一致させる）
    formStatusOpenValue: props['FORM_STATUS_OPEN_VALUE'] || ''
  };

  const required = [
    'SLACK_BOT_TOKEN', 'MANAGEMENT_SPREADSHEET_ID', 'PUBLIC_SPREADSHEET_ID',
    'GOOGLE_CALENDAR_ID', 'SLACK_CHANNEL_ID', 'GOOGLE_FORM_ID'
  ];
  const missing = required.filter(function (key) { return !props[key]; });
  if (missing.length > 0) {
    throw new Error('スクリプトプロパティが未設定です: ' + missing.join(', '));
  }
  return config;
}

/**
 * 「@名前」「<@U123>」等の揺れを補正してSlackユーザーIDだけを取り出す。
 * フォームの「主催者のSlackユーザーID」と師匠リストシートの両方で使う。
 * 人がSlackからコピーして貼ると `<@U123>` `<@U123|表示名>` `@U123` の
 * どの形にもなりうるので、いずれも `U123` へ揃える。
 * 大文字化しているのは、手入力で小文字が混ざっても Slack から届く user_id
 * （常に大文字）と一致させるため。
 */
function normalizeSlackUserId_(value) {
  return String(value || '').trim()
    .replace(/^<@/, '')
    .replace(/>$/, '')
    .replace(/\|.*$/, '')   // <@U123|表示名> の表示名部分を落とす
    .replace(/^@/, '')
    .toUpperCase();
}

/**
 * 人が編集するシートの「有効」列を3つの状態に分類する。
 * 「絵文字転送マッピング」と「師匠リスト」で共通のルール。
 *
 * 'unknown'（どちらとも判定できない値）を有効側と別に返すのが要点。
 * 判定できない値は従来どおり有効として扱うが、運営が「休止」「オフ」などと
 * 書いて止めたつもりでいると、その人は師匠のまま残る。呼び出し元が
 * これを拾って知らせることで、黙って通してしまうのを防ぐ。
 *
 * @return {'enabled'|'disabled'|'unknown'}
 */
function classifyEnabledFlag_(value) {
  // 行を書いた時点で有効とみなしたいので、空欄は有効扱い
  if (value === '' || value === null || value === undefined) return 'enabled';
  if (typeof value === 'boolean') return value ? 'enabled' : 'disabled';

  const text = String(value).trim().toUpperCase();
  if (DISABLED_VALUES.indexOf(text) !== -1) return 'disabled';
  if (ENABLED_VALUES.indexOf(text) !== -1) return 'enabled';
  return 'unknown';
}

/** 「有効」列が有効を意味するか。判定できない値は従来どおり有効として扱う */
function isEnabledFlag_(value) {
  return classifyEnabledFlag_(value) !== 'disabled';
}

/**
 * エントリIDのプロパティ値を数値ID文字列に正規化する。
 * 「entry.123456」形式・「123456」形式のどちらで登録されていても受け付け、
 * 不正な値（空・数値以外）は空文字にして事前入力をスキップさせる。
 */
function normalizeEntryId_(value) {
  const id = String(value || '').trim().replace(/^entry\./, '');
  return /^\d+$/.test(id) ? id : '';
}

/**
 * Webアプリの参加者確認URLを組み立てる。
 * WEBAPP_URL 未登録時はデプロイ済みURLの自動取得を試みる。
 */
function buildParticipantsPageUrl_(config, eventId) {
  let base = config.webAppUrl;
  if (!base) {
    try {
      base = ScriptApp.getService().getUrl();
    } catch (err) {
      base = '';
    }
  }
  if (!base) return '';
  return base + '?eventId=' + encodeURIComponent(eventId);
}

/**
 * イベント用カレンダーの共有リンク（Googleカレンダーの「共有可能なリンク」と同じ形式）。
 * cid の値はカレンダーIDのBase64（末尾の = は付けない）。
 *
 * embed 形式（参照専用ページ）ではなくこちらを使うのは、初回クリックで
 * 「カレンダーを追加しますか？」が出て**自分の予定と重ねて見られる**ようになるため。
 * 2回目以降は自分のカレンダーがそのまま開く。
 * URLに /u/0 を含めるとGoogleの1アカウント目に固定されてしまうため、あえて付けない。
 */
function buildCalendarViewUrl_(config) {
  if (!config.calendarId) return '';
  const cid = Utilities.base64Encode(config.calendarId).replace(/=+$/, '');
  return 'https://calendar.google.com/calendar?cid=' + cid;
}
