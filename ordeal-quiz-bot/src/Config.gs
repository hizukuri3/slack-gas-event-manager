/**
 * Config.gs
 * スクリプトプロパティから設定値を読み込む。
 * ソースコード内に固有情報（トークン・ID類）をハードコードしないこと。
 * 実際の値は GAS エディタの「プロジェクトの設定 > スクリプト プロパティ」に登録する。
 */

// ---- シート名 ----
const SHEET_QUIZ = '問題一覧';

// ---- 問題一覧シートの列定義（0始まり）----
const COL = {
  NUMBER: 0,     // 問題番号（例: Ord1-Q13）
  TEXT: 1,       // 問題文
  HAS_IMAGE: 2,  // 画像あり（TRUE/FALSE）
  IMAGE_FILE_ID: 3, // 画像のGoogle DriveファイルID（HAS_IMAGEがTRUEのとき必須）
  POSTED: 4,     // 出題済み（TRUE/FALSE）
  POSTED_AT: 5,   // 出題日時
  MESSAGE_TS: 6     // 投稿メッセージのts（リアクション記録用）
};

/**
 * スクリプトプロパティと設定シートを読み込んで設定をまとめる。
 * - スクリプトプロパティ（秘密情報・シートの場所）: SLACK_BOT_TOKEN, QUIZ_SPREADSHEET_ID
 * - 設定シート（運用で変える値）: SLACK_CHANNEL_ID など
 * 投稿先チャンネルは設定シートの SLACK_CHANNEL_ID を優先し、
 * 空ならスクリプトプロパティ QUIZ_SLACK_CHANNEL_ID を使う（旧設定との互換）。
 * 必須キーが未設定の場合は例外を投げてセットアップ漏れを検知する。
 */
function getConfig_() {
  const props = PropertiesService.getScriptProperties().getProperties();
  const config = {
    slackBotToken: props['SLACK_BOT_TOKEN'] || null,       // Bot User OAuth Token
    spreadsheetId: props['QUIZ_SPREADSHEET_ID'] || null    // 問題一覧スプレッドシートのID
  };

  const missing = ['SLACK_BOT_TOKEN', 'QUIZ_SPREADSHEET_ID'].filter(function (key) { return !props[key]; });
  if (missing.length > 0) {
    throw new Error('スクリプトプロパティが未設定です: ' + missing.join(', '));
  }

  config.settings = getSettings_(config);
  config.slackChannelId = config.settings.SLACK_CHANNEL_ID || props['QUIZ_SLACK_CHANNEL_ID'] || null;
  if (!config.slackChannelId) {
    throw new Error('投稿先チャンネルが未設定です。設定シートの SLACK_CHANNEL_ID を入力してください。');
  }
  return config;
}

/** 設定シートの TRUE/FALSE 系の値を真偽値にする */
function isTrue_(value) {
  return /^(true|1|yes|はい)$/i.test(String(value).trim());
}

// ---- 設定シート ----
const SHEET_SETTINGS = '設定';

/**
 * 設定シート（A列: 項目、B列: 値）を読み込む。
 * シートや項目が無い場合は既定値を使う。関連URLなど、知らない項目は無視する。
 */
function getSettings_(config) {
  const defaults = {
    SLACK_CHANNEL_ID: '',
    POST_HOUR: '9',
    SKIP_WEEKENDS: 'TRUE',
    BOT_NAME: '',
    BOT_ICON_EMOJI: '',
    BOT_ICON_URL: '',
    HEADER_FORMAT: '*今日の一問一答（{number}）*',
    REACTION_EMOJI: 'タブった,tabutta'
  };
  const settings = Object.assign({}, defaults);
  const sheet = SpreadsheetApp.openById(config.spreadsheetId).getSheetByName(SHEET_SETTINGS);
  if (!sheet) return settings;

  sheet.getDataRange().getValues().forEach(function (row) {
    const key = String(row[0] || '').trim();
    if (Object.prototype.hasOwnProperty.call(defaults, key)) {
      settings[key] = String(row[1] || '').trim();
    }
  });
  return settings;
}
