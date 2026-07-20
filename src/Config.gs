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
  WAITLIST: 'キャンセル待ち'
};

// ---- イベント種別（どちらのフォームから登録されたかで一意に決まる）----
const EVENT_TYPE = {
  MASTER: '師匠',   // 師匠用フォーム（MASTER_FORM_ID）から登録されたイベント
  DISCIPLE: '弟子'  // 弟子用フォーム（GOOGLE_FORM_ID)から登録されたイベント
};

// ---- 告知メッセージのボタン action_id ----
const ACTION_JOIN = 'join_event';
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
 */
function getConfig_() {
  const props = PropertiesService.getScriptProperties();
  const config = {
    slackBotToken: props.getProperty('SLACK_BOT_TOKEN'),               // 例: YOUR_SLACK_BOT_TOKEN
    slackVerificationToken: props.getProperty('SLACK_VERIFICATION_TOKEN'), // Slack Event検証用（任意だが推奨）
    managementSpreadsheetId: props.getProperty('MANAGEMENT_SPREADSHEET_ID'), // 例: MANAGEMENT_SPREADSHEET_ID
    publicSpreadsheetId: props.getProperty('PUBLIC_SPREADSHEET_ID'),   // 例: PUBLIC_SPREADSHEET_ID
    calendarId: props.getProperty('GOOGLE_CALENDAR_ID'),               // 例: GOOGLE_CALENDAR_ID
    slackChannelId: props.getProperty('SLACK_CHANNEL_ID'),             // 例: SLACK_CHANNEL_ID
    formId: props.getProperty('GOOGLE_FORM_ID'),                       // 弟子用イベント登録フォームのID
    // 師匠用フォームのID（任意）。設問構成は弟子用と同一にすること。
    // URLは師匠のみに共有し、弟子には公開しない。
    masterFormId: props.getProperty('MASTER_FORM_ID'),
    webAppUrl: props.getProperty('WEBAPP_URL'),                        // Webアプリの/exec URL（デプロイ後に登録）
    // 師匠のSlackユーザーID一覧（カンマ区切り）。
    // /event コマンドで師匠用フォームのリンクを返す相手の判定にのみ使用する。
    // イベント種別の判定には使わない（種別は送信元フォームで決まる）。
    masterUserIds: String(props.getProperty('MASTER_SLACK_USER_IDS') || '')
      .split(',')
      .map(function (id) { return id.trim().replace(/^<@/, '').replace(/>$/, '').replace(/^@/, ''); })
      .filter(function (id) { return id !== ''; })
  };

  const required = [
    'SLACK_BOT_TOKEN', 'MANAGEMENT_SPREADSHEET_ID', 'PUBLIC_SPREADSHEET_ID',
    'GOOGLE_CALENDAR_ID', 'SLACK_CHANNEL_ID', 'GOOGLE_FORM_ID'
  ];
  const missing = required.filter(function (key) { return !props.getProperty(key); });
  if (missing.length > 0) {
    throw new Error('スクリプトプロパティが未設定です: ' + missing.join(', '));
  }
  return config;
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
