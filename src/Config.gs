/**
 * Config.gs
 * スクリプトプロパティから設定値を読み込む。
 * ソースコード内に固有情報（トークン・ID類）をハードコードしないこと。
 * 実際の値は GAS エディタの「プロジェクトの設定 > スクリプト プロパティ」に登録する。
 */

// ---- シート名 ----
const SHEET_EVENT_MASTER = 'イベントマスター';
const SHEET_PARTICIPANTS = '参加者リスト';

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
  TYPE: 18            // 種別（師匠 / 弟子）
};

const EVENT_MASTER_HEADER = [
  'イベントID', '回答ID', 'イベント名', '主催者SlackユーザーID', '開始日時', '終了日時',
  '定員', 'ステータス', '開催形式', '会場URL/開催場所', '概要・対象者', '事前準備・持ち物',
  'カレンダーイベントID', 'SlackチャンネルID', 'SlackメッセージTS', '回答編集用URL',
  '登録日時', '更新日時', '種別'
];

const PARTICIPANTS_HEADER = ['イベントID', 'SlackユーザーID', '表示名', '状態', '登録日時'];

// ---- フォームの設問タイトル（フォーム側の設問名と完全一致させること）----
const FORM_TITLES = {
  TITLE: 'イベント名',
  ORGANIZER: '主催者のSlackユーザーID',
  START: '開始日時',
  END_TIME: '終了時刻',
  CAPACITY: '定員',
  STATUS: 'イベントのステータス',
  FORMAT: '開催形式',
  LOCATION: '会場URL または 開催場所',
  DESCRIPTION: '概要・対象者',
  PREPARATION: '事前準備・持ち物・資料リンク'
};

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
    masterUserIds: String(props['MASTER_SLACK_USER_IDS'] || '')
      .split(',')
      .map(function (id) { return id.trim().replace(/^<@/, '').replace(/>$/, '').replace(/^@/, ''); })
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
