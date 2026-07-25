/**
 * Bootstrap.gs
 * 新しい期（コホート）へ引き継ぐときの初期構築を1関数にまとめる。
 *
 * bootstrap() を1回実行すると、次を「まだ無ければ」作成する（冪等）:
 *   - 管理用スプレッドシート / 公開用スプレッドシート
 *   - 弟子用フォーム / 師匠用フォーム（設問構成は共通）
 *   - イベント用カレンダー
 * 作成物のIDはスクリプトプロパティへ自動保存する。
 * 既にプロパティにIDが入っているものは作り直さない（重複生成を防ぐ）。
 *
 * ★ 共有ドライブへの配置は手作業 ★
 * スプレッドシート・フォームは実行者の「マイドライブ」直下に作られる。
 * 共有ドライブへ動かすのは Drive の画面上で手動で行う（プログラムは共有ドライブに触らない）。
 * Drive上でファイルを移動してもIDは変わらないため、保存済みのIDはそのまま有効。
 * この方針により drive スコープ・Drive高度サービスは不要（spreadsheets/forms スコープのみで動く）。
 *
 * カレンダーはDriveファイルではなく、実行者のカレンダー一覧に紐づく（移動の概念なし）。
 */

// ---- フォームの設問定義（単一の真実）----
// 設問タイトルは FORM_TITLES を流用し、Config.gs と一致させる。
// ヘルプ文（FORMAT / LOCATION）はここには持たせない。applyFormHints_()（FormHandler.gs）
// が正となり、setupTriggers() 実行時に付与される（二重管理によるドリフトを防ぐ）。
const FORM_SPEC = [
  { title: FORM_TITLES.TITLE, type: 'TEXT', required: true },
  { title: FORM_TITLES.ORGANIZER, type: 'TEXT', required: true },
  { title: FORM_TITLES.START, type: 'DATETIME', required: true },
  { title: FORM_TITLES.END_TIME, type: 'TIME', required: true },
  { title: FORM_TITLES.CAPACITY, type: 'TEXT', required: true },
  { title: FORM_TITLES.STATUS, type: 'MULTIPLE_CHOICE', required: true,
    choices: ['開催', '中止'] },
  { title: FORM_TITLES.FORMAT, type: 'MULTIPLE_CHOICE', required: true,
    choices: ['①オンライン・自動発行', '②オンライン・手動URL', '③オフライン・対面'] },
  { title: FORM_TITLES.LOCATION, type: 'TEXT', required: false },
  { title: FORM_TITLES.DESCRIPTION, type: 'PARAGRAPH_TEXT', required: true },
  { title: FORM_TITLES.PREPARATION, type: 'PARAGRAPH_TEXT', required: false }
];

/**
 * 新しい期の初期構築（手動実行）。
 * COHORT_NAME（任意）を入れておくと生成ファイル名の接頭辞になる（例: Bridge2027.03）。
 * 実行後、作成物はマイドライブにあるので、手動で共有ドライブの目的フォルダへ移動すること。
 */
function bootstrap() {
  const scriptProps = PropertiesService.getScriptProperties();
  const cohort = String(scriptProps.getProperty('COHORT_NAME') || '').trim();
  const prefix = cohort ? cohort + ' ' : '';
  const logs = [];

  // ---- 1. スプレッドシート（管理用・公開用）----
  ensureResource_(scriptProps, logs, 'MANAGEMENT_SPREADSHEET_ID',
    function () { return createSpreadsheet_(prefix + '運営データ（管理用）'); });
  ensureResource_(scriptProps, logs, 'PUBLIC_SPREADSHEET_ID',
    function () { return createSpreadsheet_(prefix + 'イベント一覧（公開用）'); });

  // ---- 2. フォーム（弟子用・師匠用。設問構成は共通）----
  ensureResource_(scriptProps, logs, 'GOOGLE_FORM_ID',
    function () { return createEventForm_(prefix + 'イベント登録フォーム（弟子用）'); });
  ensureResource_(scriptProps, logs, 'MASTER_FORM_ID',
    function () { return createEventForm_(prefix + 'イベント登録フォーム（師匠用）'); });

  // ---- 3. イベント用カレンダー（Driveファイルではない）----
  ensureResource_(scriptProps, logs, 'GOOGLE_CALENDAR_ID',
    function () {
      const cal = CalendarApp.createCalendar(prefix + 'イベント', { timeZone: 'Asia/Tokyo' });
      return cal.getId();
    });

  // ---- 4. フォーム事前入力のエントリID登録（Slack不要。フォームIDだけで動く）----
  setupPrefillEntryIds();
  logs.push('setupPrefillEntryIds() 実行済み（FORM_ENTRY_* / FORM_STATUS_OPEN_VALUE を登録）');

  // ---- 手動作業の案内：共有ドライブへの移動 ----
  logs.push('');
  logs.push('▼ 手動作業(1): 作成したスプレッドシート・フォームはマイドライブにあります。');
  logs.push('  Drive の画面で共有ドライブの目的フォルダへ移動してください（IDは変わらないので動作に影響なし）。');
  logs.push('▼ 手動作業(2): カレンダーを「一般公開（予定の詳細を表示）」に設定してください。');
  logs.push('  未設定だとメンバーが告知の「カレンダーを開く」を押しても中身が見えません（README 4-3 参照）。');

  // ---- 5. シート初期化・トリガー・ヒント付与（Slack系プロパティが揃っていれば実行）----
  // initializeSheets()/setupTriggers() は getConfig_() 経由で SLACK_BOT_TOKEN 等を必須にするため、
  // まだSlackを設定していない段階でも bootstrap 自体は成功させ、次の一手を案内する。
  try {
    getConfig_(); // 必須プロパティが未設定なら例外
  } catch (configErr) {
    logs.push('');
    logs.push('▼ 次にSlack系プロパティを登録してください:');
    logs.push('  SLACK_BOT_TOKEN / SLACK_CHANNEL_ID など（README「手動で登録するもの」参照）');
    logs.push('  登録後、setupTriggers() を手動実行するとシート初期化・トリガー登録・');
    logs.push('  フォームのヒント付与まで完了します。');
    logs.push('  (getConfig_ の不足: ' + configErr.message + ')');
    console.log(logs.join('\n'));
    return;
  }
  setupTriggers(); // initializeSheets() / applyFormHints_() もこの中で実行される
  logs.push('setupTriggers() 実行済み（シート初期化・フォーム送信/定期同期トリガー・ヒント付与）');
  logs.push('');
  logs.push('セットアップ完了。Slackで /event を打ってフォームリンクが返れば成功です。');
  console.log(logs.join('\n'));
}

/**
 * プロパティにIDが無ければ creator() で作成して保存する（冪等）。
 * creator は作成物のIDを返す。
 */
function ensureResource_(scriptProps, logs, key, creator) {
  const existing = String(scriptProps.getProperty(key) || '').trim();
  if (existing) {
    logs.push(key + ': 既存のためスキップ (' + existing + ')');
    return existing;
  }
  const id = creator();
  scriptProps.setProperty(key, id);
  logs.push(key + ': 新規作成 (' + id + ')');
  return id;
}

/** スプレッドシートを新規作成してIDを返す（マイドライブ直下にできる） */
function createSpreadsheet_(name) {
  return SpreadsheetApp.create(name).getId();
}

/** イベント登録フォームを FORM_SPEC どおりに新規作成してIDを返す（マイドライブ直下にできる） */
function createEventForm_(name) {
  const form = FormApp.create(name);
  buildFormItems_(form);
  return form.getId();
}

/** FORM_SPEC に従ってフォームへ設問を追加する（順序も定義どおり） */
function buildFormItems_(form) {
  FORM_SPEC.forEach(function (spec) {
    let item;
    switch (spec.type) {
      case 'TEXT':
        item = form.addTextItem(); break;
      case 'PARAGRAPH_TEXT':
        item = form.addParagraphTextItem(); break;
      case 'DATETIME':
        item = form.addDateTimeItem().setIncludesYear(true); break; // parseDateTime_ は年込みを前提
      case 'TIME':
        item = form.addTimeItem(); break;
      case 'MULTIPLE_CHOICE':
        item = form.addMultipleChoiceItem(); break;
      default:
        throw new Error('未対応のフォーム設問タイプ: ' + spec.type + '（' + spec.title + '）');
    }
    item.setTitle(spec.title);
    if (spec.choices) {
      item.setChoiceValues(spec.choices);
    }
    item.setRequired(!!spec.required);
  });
}
