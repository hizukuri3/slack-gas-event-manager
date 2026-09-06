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
// 定数ではなく関数にしているのは、GASがファイル名の昇順でトップレベルを評価するため。
// Bootstrap.gs は Config.gs より先に読まれるので、トップレベルの const で FORM_TITLES を
// 参照すると「ReferenceError: FORM_TITLES is not defined」になる。関数にして参照を実行時へ遅らせる。
function formSpec_() {
  return [
    { title: FORM_TITLES.TITLE, type: 'TEXT', required: true },
    { title: FORM_TITLES.ORGANIZER, type: 'TEXT', required: true },
    { title: FORM_TITLES.START, type: 'DATETIME', required: true },
    { title: FORM_TITLES.END_TIME, type: 'TIME', required: true },
    { title: FORM_TITLES.CAPACITY, type: 'TEXT', required: true },
    { title: FORM_TITLES.STATUS, type: 'MULTIPLE_CHOICE', required: true,
      choices: ['開催', '中止'] },
    // 選択肢の正は Config.gs の EVENT_FORMAT_VALUES。ここで文字列を直書きすると
    // applyFormHints_ が既存フォームへ反映する内容とずれる
    { title: FORM_TITLES.FORMAT, type: 'MULTIPLE_CHOICE', required: true,
      choices: EVENT_FORMAT_VALUES },
    // VC部屋の選択肢はVCルームリスト（管理用①）が正で、シート編集のたびに
    // syncVcRoomChoices() が貼り直す。ここではフォーム作成直後に選べる
    // 「おまかせ」だけを置いておく（空の選択肢はFormAppが受け付けないため）
    { title: FORM_TITLES.VC_ROOM, type: 'MULTIPLE_CHOICE', required: false,
      choices: [VC_ROOM_AUTO] },
    { title: FORM_TITLES.LOCATION, type: 'TEXT', required: false },
    { title: FORM_TITLES.DESCRIPTION, type: 'PARAGRAPH_TEXT', required: true },
    { title: FORM_TITLES.PREPARATION, type: 'PARAGRAPH_TEXT', required: false }
  ];
}

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

  // ---- 生成物のURL一覧（手動作業の動線用。ログから直接開ける）----
  const created = scriptProps.getProperties();
  logs.push('');
  logs.push('▼ 生成物（クリックで開けます）');
  logs.push('  運営データ（管理用）  : ' + spreadsheetUrl_(created['MANAGEMENT_SPREADSHEET_ID']));
  logs.push('  イベント一覧（公開用）: ' + spreadsheetUrl_(created['PUBLIC_SPREADSHEET_ID']));
  logs.push('  弟子用フォーム        : ' + formEditUrl_(created['GOOGLE_FORM_ID']));
  logs.push('  師匠用フォーム        : ' + formEditUrl_(created['MASTER_FORM_ID']));
  logs.push('  カレンダー設定        : ' + calendarSettingsUrl_(created['GOOGLE_CALENDAR_ID']));

  // ---- 手動作業の案内 ----
  logs.push('');
  logs.push('▼ 手動作業(1): 上のスプレッドシート・フォームはマイドライブにあります。');
  logs.push('  Drive で共有ドライブの目的フォルダへ移動してください（IDは変わらないので動作に影響なし）。');
  logs.push('  共有ドライブを使わない（個人で動かす）場合は、この移動は不要です。');
  logs.push('▼ 手動作業(2): 上の「カレンダー設定」を開き、「アクセス権限」を');
  logs.push('  「一般公開して誰でも利用できるようにする」＋「予定の表示（すべての予定の詳細）」にしてください。');
  logs.push('  （直接開けない場合は、Googleカレンダー左の一覧で該当カレンダー →「設定と共有」）。');
  logs.push('  未設定だとメンバーが告知の「カレンダーを開く」を押しても中身が見えません。');

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
  logs.push('setupTriggers() 実行済み（シート初期化・フォーム送信/定期同期/師匠リスト編集トリガー・ヒント付与）');
  logs.push('');
  logs.push('▼ 手動作業(3): 管理用スプレッドシートの「師匠リスト」シートに師匠を登録してください。');
  logs.push('  1行1人でSlackユーザーIDを書くだけです（編集した時点で自動反映されます）。');
  logs.push('  登録された人が /event を打つと、師匠用フォームのリンクが返るようになります。');
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

/** イベント登録フォームを formSpec_() どおりに新規作成してIDを返す（マイドライブ直下にできる） */
function createEventForm_(name) {
  const form = FormApp.create(name);
  ensureFormItems_(form);
  return form.getId();
}

/** スプレッドシートを開くURL（ログの動線用） */
function spreadsheetUrl_(id) {
  return id ? 'https://docs.google.com/spreadsheets/d/' + id + '/edit' : '(未作成)';
}

/** フォームの編集画面URL（ログの動線用） */
function formEditUrl_(id) {
  return id ? 'https://docs.google.com/forms/d/' + id + '/edit' : '(未作成)';
}

/**
 * カレンダーの「設定と共有」ページURL（アクセス権限の変更用）。
 * カレンダーIDのBase64をパスに載せる形式。環境によっては開けない場合があるため、
 * その際はカレンダー一覧から手動で開く（ログにも案内を出している）。
 */
function calendarSettingsUrl_(id) {
  if (!id) return '(未作成)';
  return 'https://calendar.google.com/calendar/u/0/r/settings/calendar/' +
    encodeURIComponent(Utilities.base64Encode(id));
}

/**
 * formSpec_() のうち、フォームにまだ無い設問だけを追加する（順序も定義どおり）。
 *
 * 空のフォームに対しては全設問が入るので、新規作成時はこれ1本で足りる。
 * 効いてくるのはすでに動いているインスタンスのほうで、設問を作る処理が
 * createEventForm_ にしか無いと、コードへ設問を足しても稼働中のフォームには
 * 永久に反映されない。ensureHeader_ が稼働中インスタンスのシート見出しを
 * 追随させているのと同じ趣旨で、その穴をここで塞ぐ。
 *
 * ★ 既存の設問は変更も削除も並べ替えもしない ★
 * 運営がフォーム側で足した設問や、意図して動かした並びを壊さないため、
 * 触るのは「追加した設問をどこへ置くか」だけにとどめる。
 *
 * @return {string[]} 追加した設問のタイトル（何も足さなければ空配列）
 */
function ensureFormItems_(form) {
  const spec = formSpec_();
  const added = [];
  spec.forEach(function (s, i) {
    if (findFormItemByTitle_(form, s.title)) return;
    const item = addFormItem_(form, s); // 末尾に追加される
    form.moveItem(item.getIndex(), insertIndexForSpec_(form, spec, i));
    added.push(s.title);
  });
  return added;
}

/** タイトルが一致する設問を返す（無ければ null） */
function findFormItemByTitle_(form, title) {
  const found = form.getItems().find(function (item) {
    return item.getTitle() === title;
  });
  return found || null;
}

/**
 * 追加した設問を差し込む位置。定義上ひとつ前にある設問の直後に置く。
 * 前の設問がフォームに1つも見当たらなければ先頭へ。
 * 位置を絶対値（定義上の何番目か）で決めないのは、運営が独自に足した設問が
 * あると番号がずれ、関係のない場所へ割り込んでしまうため。
 */
function insertIndexForSpec_(form, spec, specIndex) {
  for (let i = specIndex - 1; i >= 0; i--) {
    const prev = findFormItemByTitle_(form, spec[i].title);
    if (prev) return prev.getIndex() + 1;
  }
  return 0;
}

/** 設問定義1件ぶんをフォームへ追加する（末尾に入る） */
function addFormItem_(form, spec) {
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
  return item;
}
