/**
 * Quiz.gs
 * 一問一答クイズ。管理用①の「クイズ問題」シートから1日1問をSlackへ出題し、
 * 出題メッセージに付いた特定の絵文字リアクションを「クイズ回答ログ」に記録する。
 *
 * 設定は「クイズ設定」シート（運営が編集）が正。投稿先チャンネルが空のあいだは
 * 何もしないので、クイズを使わない期は放っておけばよい。
 *
 * 出題は毎時のトリガー（setupTriggers で登録）で「設定した時刻を過ぎていて、
 * 今日まだ出していなければ出す」と判定する。投稿時刻だけのトリガーにしないのは、
 * 運営がシートで時刻を変えたときに GAS エディタで再登録しなくて済むようにするためと、
 * Slack への投稿に失敗した日に次の時間で自動的にやり直せるようにするため。
 */

// ==================== 出題 ====================

/**
 * 時間主導トリガー（毎時）から呼ばれる。条件を満たせば1問出題し、
 * 「クイズ設定」の「次の出題」表示を今の状態に更新する
 */
function postDailyQuiz() {
  const config = getConfig_();
  const spreadsheet = SpreadsheetApp.openById(config.managementSpreadsheetId);
  try {
    postQuizIfDue_(config, spreadsheet);
  } finally {
    // 表示の更新に失敗しても、出題の結果（例外）を隠さない
    try {
      refreshQuizNextLabel_(spreadsheet);
    } catch (err) {
      console.warn('「次の出題」の表示を更新できませんでした: ' + err);
    }
  }
}

function postQuizIfDue_(config, spreadsheet) {
  const settings = readQuizSettings_(spreadsheet);
  if (!settings || !settings.channel) return;

  const sheet = spreadsheet.getSheetByName(SHEET_QUIZ_QUESTIONS);
  if (!sheet) return;
  const values = sheet.getDataRange().getValues();
  const now = new Date();

  // 出すかどうかの判定は planQuiz_ に一本化している（「次の出題」の表示と同じ判定を使うため）
  const plan = planQuiz_(settings, values, now);
  if (!plan.shouldPostNow) {
    if (plan.warning) console.warn(plan.warning);
    return;
  }

  const channelId = resolveChannelId_(config, settings.channel);
  if (!channelId) {
    console.warn('クイズ設定の「投稿先チャンネル」が見つかりません: ' + settings.channel);
    return;
  }

  // ロックは取らない。出題はこの毎時トリガーからしか走らず、1時間おきなので
  // 自分自身と重ならない。ロックを取ると、画像アップロードの待ち時間のあいだ
  // 参加ボタンやリアクションの処理まで止めてしまう
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (String(row[QUIZ_COL.STATUS] || '').trim() !== '') continue; // 出題済み・飛ばした行
    const rowNumber = i + 1;
    const number = String(row[QUIZ_COL.NUMBER] || '').trim();
    const text = String(row[QUIZ_COL.TEXT] || '').trim();
    const image = String(row[QUIZ_COL.IMAGE] || '').trim();
    if (!number && !text && !image) continue; // 空行は問題として扱わない

    if (!text) {
      markQuizSkipped_(sheet, rowNumber, '⚠ 問題文が空のため飛ばしました');
      continue;
    }
    let imageBlob = null;
    if (image) {
      try {
        imageBlob = DriveApp.getFileById(parseDriveFileId_(image)).getBlob();
      } catch (err) {
        console.warn(rowNumber + '行目: 画像を読み込めません: ' + err);
        markQuizSkipped_(sheet, rowNumber,
          '⚠ 画像を読み込めないため飛ばしました（URLと共有設定を確認してください）');
        continue;
      }
    }

    const messageTs = postQuizMessage_(config, channelId, settings,
      buildQuizText_(settings, number, text), imageBlob);
    if (!messageTs) {
      // 行には何も書かない。今日まだ出していない扱いのままなので、次の時間に再挑戦する
      console.error('クイズの投稿に失敗しました（' + rowNumber + '行目 ' + number + '）');
      return;
    }
    sheet.getRange(rowNumber, QUIZ_COL.POSTED_AT + 1, 1, 3).setValues([[
      now, QUIZ_STATUS_POSTED, "'" + messageTs
    ]]);
    return;
  }
  console.log('未出題のクイズがありません');
}

/** 今日すでに出題したか（出題日時の日付で判定する） */
function hasPostedOn_(values, now) {
  const today = formatQuizDate_(now);
  for (let i = 1; i < values.length; i++) {
    const postedAt = values[i][QUIZ_COL.POSTED_AT];
    if (postedAt instanceof Date && formatQuizDate_(postedAt) === today) return true;
  }
  return false;
}

function formatQuizDate_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

// ==================== 出題の予定（判定と「次の出題」の表示） ====================

const QUIZ_DAY_MS = 24 * 60 * 60 * 1000;
const QUIZ_WEEKDAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

/** 年月日を通し番号の日数にする（タイムゾーンに左右されない） */
function quizDayNumber_(year, month, day) {
  return Math.round(Date.UTC(year, month - 1, day) / QUIZ_DAY_MS);
}

/** 通し番号の日数を「10/13(月)」の形にする */
function formatQuizDay_(dayNumber) {
  const date = new Date(dayNumber * QUIZ_DAY_MS);
  return (date.getUTCMonth() + 1) + '/' + date.getUTCDate() + '(' + QUIZ_WEEKDAY_NAMES[date.getUTCDay()] + ')';
}

/**
 * クイズ設定とクイズ問題シートの内容から、今出すかどうかと「次の出題」の表示を決める。
 * 判定の本体は computeQuizSchedule_（純粋関数）で、ここはシートの値を渡すだけ。
 * @param {Object} settings readQuizSettings_ の結果
 * @param {Array} values クイズ問題シートの getValues()
 * @param {Date} now 現在日時（スクリプトのタイムゾーン）
 */
function planQuiz_(settings, values, now) {
  // 次に出す問題。出題のループと同じく、状態が埋まった行・空行・問題文が空の行は対象外
  let hasQuestion = false;
  let nextNumber = '';
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (String(row[QUIZ_COL.STATUS] || '').trim() !== '') continue;
    const text = String(row[QUIZ_COL.TEXT] || '').trim();
    if (!text) continue;
    hasQuestion = true;
    nextNumber = String(row[QUIZ_COL.NUMBER] || '').trim();
    break;
  }
  return computeQuizSchedule_({
    channel: settings.channel,
    run: settings.run,
    startDate: settings.startDate,
    startDateInvalid: settings.startDateInvalid,
    postHour: settings.postHour,
    skipWeekends: settings.skipWeekends,
    now: { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate(), hour: now.getHours() },
    postedToday: hasPostedOn_(values, now),
    hasQuestion: hasQuestion,
    nextNumber: nextNumber
  });
}

/**
 * 出題の予定を決める純粋関数（シートにもSlackにも触らない）。
 * 出題の判定と、設定シートの「次の出題」の表示で同じ判定を使う（表示と実際がずれないように）。
 *
 * 出さないのは次のとき: 投稿先が空 / 「出題の切り替え」が「出題する」以外 /
 * 「出題を始める日」が読めない・今日より先 / 投稿時刻が読めない / 土日は休む設定の土日 /
 * 今日すでに出した / 時刻前 / 出す問題が無い。読めない値は、誤って出すより止める側に倒す。
 *
 * @param {Object} s
 *   channel 投稿先チャンネル（空なら動かない）
 *   run 「出題の切り替え」が「出題する」か
 *   startDate {year, month, day} か null（「出題を始める日」。空欄は null）
 *   startDateInvalid 「出題を始める日」が日付として読めなかったか
 *   postHour 0〜23 か null（読めない値）
 *   skipWeekends 土日は休むか
 *   now {year, month, day, hour}
 *   postedToday 今日すでに出題したか
 *   hasQuestion 出題できる問題が残っているか
 *   nextNumber 次に出す問題の番号（無ければ空文字）
 * @return {{shouldPostNow: boolean, label: string, warning: string}}
 *   label は「次の出題」に出す文言。warning は出さない理由がログに残すべきものであるとき
 */
function computeQuizSchedule_(s) {
  const no = function (label, warning) {
    return { shouldPostNow: false, label: label, warning: warning || '' };
  };
  if (!s.channel) return no('投稿先チャンネルが空のため、出題しません');
  if (!s.run) return no('お休み中です');
  if (s.startDateInvalid) {
    return no('「出題を始める日」が日付として読めないため、出題しません',
      'クイズ設定の「出題を始める日」が日付として読めないため出題しません');
  }
  if (s.postHour === null || s.postHour === undefined) {
    return no('「投稿時刻」が0〜23の数字ではないため、出題しません',
      'クイズ設定の「投稿時刻」が 0〜23 の数字ではないため出題しません');
  }
  if (!s.hasQuestion) return no('未出題の問題がありません');

  const today = quizDayNumber_(s.now.year, s.now.month, s.now.day);
  const isWeekend = function (dayNumber) {
    const dow = new Date(dayNumber * QUIZ_DAY_MS).getUTCDay();
    return dow === 0 || dow === 6;
  };

  // 次に出す日。今日出していれば明日以降、「出題を始める日」より前は始める日まで、土日は休むなら月曜まで
  let day = s.postedToday ? today + 1 : today;
  if (s.startDate) {
    day = Math.max(day, quizDayNumber_(s.startDate.year, s.startDate.month, s.startDate.day));
  }
  while (s.skipWeekends && isWeekend(day)) day += 1;

  const tail = s.nextNumber ? '(' + s.nextNumber + ')' : '';
  const at = s.postHour + '時ごろ';
  if (day === today) {
    if (s.now.hour >= s.postHour) {
      return { shouldPostNow: true, label: 'まもなく出題します' + tail, warning: '' };
    }
    return no('本日 ' + at + tail);
  }
  if (day === today + 1) return no('明日 ' + formatQuizDay_(day) + ' ' + at + tail);
  return no(formatQuizDay_(day) + ' ' + at + tail);
}

/** 「クイズ設定」の「次の出題」を、いまの状態の表示に更新する（変わっていなければ書かない） */
function refreshQuizNextLabel_(spreadsheet) {
  const settingsSheet = spreadsheet.getSheetByName(SHEET_QUIZ_SETTINGS);
  const questions = spreadsheet.getSheetByName(SHEET_QUIZ_QUESTIONS);
  if (!settingsSheet || !questions) return;
  const settings = readQuizSettings_(spreadsheet);
  if (!settings) return;

  const nextLabel = quizSettingItem_('NEXT').label;
  const rows = settingsSheet.getDataRange().getValues();
  let rowNumber = 0;
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][0] || '').trim() === nextLabel) {
      rowNumber = i + 1;
      break;
    }
  }
  if (!rowNumber) return;

  const label = planQuiz_(settings, questions.getDataRange().getValues(), new Date()).label;
  const cell = settingsSheet.getRange(rowNumber, 2);
  if (String(cell.getValue()) !== label) cell.setValue(label);
}

/** QUIZ_SETTING_ITEMS から、key の項目を返す */
function quizSettingItem_(key) {
  return QUIZ_SETTING_ITEMS.filter(function (item) { return item.key === key; })[0];
}

/**
 * 「出題を始める日」のセルの値を読む。日付のセルは Date で、手で書かれた文字は
 * yyyy/M/d か yyyy-M-d の形だけ受ける。空欄は「指定なし」。読めない値は invalid にして、
 * 出題を止める側に倒す（日付を間違えたまま、気づかず出してしまわないため）。
 * @return {{date: ?{year: number, month: number, day: number}, invalid: boolean}}
 */
function parseQuizStartDate_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') {
    if (isNaN(value.getTime())) return { date: null, invalid: true };
    return { date: { year: value.getFullYear(), month: value.getMonth() + 1, day: value.getDate() }, invalid: false };
  }
  const text = String(value === null || value === undefined ? '' : value).trim();
  if (!text) return { date: null, invalid: false };
  const m = text.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (!m) return { date: null, invalid: true };
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return { date: null, invalid: true };   // 2月30日など
  }
  return { date: { year: year, month: month, day: day }, invalid: false };
}

/** 出題できなかった行に理由を書く。「状態」が埋まるので以後の出題対象から外れる */
function markQuizSkipped_(sheet, rowNumber, reason) {
  console.warn(rowNumber + '行目: ' + reason);
  sheet.getRange(rowNumber, QUIZ_COL.STATUS + 1).setValue(reason);
}

/**
 * Drive のファイルURL（…/file/d/{id}/view や …?id={id}）からファイルIDを取り出す。
 * どちらの形でもなければ、ID がそのまま書かれているものとして扱う
 */
function parseDriveFileId_(value) {
  const text = String(value || '').trim();
  const match = text.match(/\/d\/([\w-]+)/) || text.match(/[?&]id=([\w-]+)/);
  return match ? match[1] : text;
}

/** 見出し＋問題文の本文を作る */
function buildQuizText_(settings, number, text) {
  const header = settings.header ? settings.header.split('{number}').join(number) : '';
  return header ? header + '\n' + text : text;
}

/**
 * 出題メッセージを投稿する。成功したら ts、失敗したら null。
 *
 * 画像は「アップロードだけしてチャンネルには出さず、chat.postMessage の image ブロックで
 * 参照する」形にしている。files.completeUploadExternal でチャンネルへ直接出すと、
 * 設定シートの表示名・アイコンが使えず、本文と画像が別メッセージに分かれるため。
 */
function postQuizMessage_(config, channelId, settings, text, imageBlob) {
  const payload = { channel: channelId, text: text };
  if (settings.botName) payload.username = settings.botName;
  if (/^https?:\/\//.test(settings.botIcon)) {
    payload.icon_url = settings.botIcon;
  } else if (settings.botIcon) {
    payload.icon_emoji = ':' + settings.botIcon.replace(/^:|:$/g, '') + ':';
  }

  if (!imageBlob) {
    const json = callSlackApi_(config, 'chat.postMessage', payload);
    return json.ok ? json.ts : null;
  }

  const fileId = uploadFileWithoutSharing_(config, imageBlob);
  if (!fileId) return null;
  payload.blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: text } },
    { type: 'image', slack_file: { id: fileId }, alt_text: imageBlob.getName() || 'quiz' }
  ];
  // アップロード直後は Slack 側の処理が終わっておらず invalid_blocks になることがある。
  // 少し待って数回だけやり直す
  for (let attempt = 1; attempt <= 5; attempt++) {
    const json = callSlackApi_(config, 'chat.postMessage', payload);
    if (json.ok) return json.ts;
    if (json.error !== 'invalid_blocks') return null;
    Utilities.sleep(2000);
  }
  return null;
}

// ==================== 設定 ====================

/**
 * 「クイズ設定」シートを読む。シートが無ければ null。
 * シートに行が無い項目は既定値を使う。行があって値が空なら空として扱う
 * （投稿先チャンネル・見出しなどは空であること自体に意味があるため）。
 */
function readQuizSettings_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(SHEET_QUIZ_SETTINGS);
  if (!sheet) return null;

  const byLabel = {};
  const rawByLabel = {};   // 日付のセルは文字にせず、そのまま（Date）読みたい
  sheet.getDataRange().getValues().forEach(function (row) {
    const label = String(row[0] || '').trim();
    byLabel[label] = String(row[1]).trim();
    rawByLabel[label] = row[1];
  });
  const raw = {};
  QUIZ_SETTING_ITEMS.forEach(function (item) {
    raw[item.key] = Object.prototype.hasOwnProperty.call(byLabel, item.label)
      ? byLabel[item.label] : item.value;
  });
  const startDateLabel = quizSettingItem_('START_DATE').label;
  let startDateRaw = Object.prototype.hasOwnProperty.call(rawByLabel, startDateLabel)
    ? rawByLabel[startDateLabel] : '';
  if (Object.prototype.toString.call(startDateRaw) === '[object Date]' && !isNaN(startDateRaw.getTime())) {
    // 日付のセルの値は、シートのタイムゾーンの0時。スクリプトのタイムゾーンと違っても
    // 選んだ日付がずれないように、シートのタイムゾーンで年月日を取り出す
    startDateRaw = Utilities.formatDate(startDateRaw, spreadsheet.getSpreadsheetTimeZone(), 'yyyy/MM/dd');
  }
  const startDate = parseQuizStartDate_(startDateRaw);

  const hour = /^\d{1,2}$/.test(raw.POST_HOUR) ? Number(raw.POST_HOUR) : -1;
  return {
    channel: raw.CHANNEL,
    // 「出題する」と書かれているときだけ出す。空欄や書き間違いは、誤って出すより止める側に倒す
    run: raw.RUN === QUIZ_RUN_ON,
    startDate: startDate.date,
    startDateInvalid: startDate.invalid,
    postHour: (hour >= 0 && hour <= 23) ? hour : null,
    // 「いいえ」と書かれたときだけ土日も出す。迷う値は休む側に倒す
    skipWeekends: raw.SKIP_WEEKENDS !== 'いいえ',
    header: raw.HEADER,
    emojis: raw.EMOJIS.split(/[,、]/).map(normalizeEmojiName_).filter(function (s) { return s; }),
    botName: raw.BOT_NAME,
    botIcon: raw.BOT_ICON
  };
}

/**
 * 「クイズ設定」シートに、まだ無い項目の行を既定値つきで足す（initializeSheets から呼ぶ）。
 * 既存の行は値も説明も触らない。運営が入れた値を上書きしないため。
 * コードに項目を足したとき、稼働中のシートへ追随させる経路もここ。
 * @return {string[]} 足した項目名（実行ログに出すため）
 */
function ensureQuizSettingRows_(sheet) {
  const labels = sheet.getDataRange().getValues().map(function (row) {
    return String(row[0] || '').trim();
  });
  const added = [];
  QUIZ_SETTING_ITEMS.forEach(function (item) {
    if (labels.indexOf(item.label) !== -1) return;
    added.push(item.label);
    // after が指定された項目は、その項目の下に入れる（稼働中のシートでも、関連する設定が並ぶように）
    const afterIndex = item.after ? labels.indexOf(item.after) : -1;
    if (afterIndex !== -1) {
      sheet.insertRowAfter(afterIndex + 1);
      sheet.getRange(afterIndex + 2, 1, 1, 3).setValues([[item.label, item.value, item.note]]);
      labels.splice(afterIndex + 1, 0, item.label);
    } else {
      sheet.appendRow([item.label, item.value, item.note]);
      labels.push(item.label);
    }
  });

  // 「土日は休む」と「出題の切り替え」の値はドロップダウンにする。「休む」「×」などと書いて
  // 止めたつもりになるのを防ぐ（判定できない値は readQuizSettings_ が止める側に倒す）
  const setList = function (label, choices) {
    const row = labels.indexOf(label);
    if (row === -1) return;
    sheet.getRange(row + 1, 2).setDataValidation(
      SpreadsheetApp.newDataValidation()
        .requireValueInList(choices, true)
        .setAllowInvalid(false)
        .build()
    );
  };
  setList(quizSettingItem_('SKIP_WEEKENDS').label, QUIZ_SKIP_WEEKENDS_CHOICES);
  setList(quizSettingItem_('RUN').label, QUIZ_RUN_CHOICES);

  // 「出題を始める日」は、セルを選ぶとカレンダーから選べる日付にする
  const startRow = labels.indexOf(quizSettingItem_('START_DATE').label);
  if (startRow !== -1) {
    sheet.getRange(startRow + 1, 2)
      .setNumberFormat('yyyy/MM/dd')
      .setDataValidation(SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).build());
  }
  return added;
}

// ==================== リアクションの記録 ====================

/**
 * 出題メッセージに設定の絵文字が付いた／外れたら、クイズ回答ログに記録する。
 * handleSlackEvent_（EmojiReactionRelay.gs）から、絵文字転送とは独立に呼ばれる。
 *
 * Slack の再送（3秒以内に応答できなかったときに同じイベントが再び届く）は、
 * イベント時刻で見分ける。同じ人・同じ問題・同じ絵文字で、追加日時が同じ行が
 * すでにあれば再送とみなす。キャッシュではなくシートで判定するので、
 * 記録に失敗したイベントの再送はきちんと記録される。
 */
function handleQuizReaction_(config, event) {
  const spreadsheet = SpreadsheetApp.openById(config.managementSpreadsheetId);
  const settings = readQuizSettings_(spreadsheet);
  if (!settings || !settings.channel) return;

  const emoji = normalizeEmojiName_(event.reaction);
  if (settings.emojis.indexOf(emoji) === -1) return;
  if (resolveChannelId_(config, settings.channel) !== event.item.channel) return;

  const messageTs = String(event.item.ts);
  const question = findQuizQuestionByTs_(spreadsheet, messageTs);
  if (!question) return; // 出題メッセージ以外へのリアクション

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (err) {
    console.warn('クイズ回答ログのロック取得に失敗しました: ' + event.user + '/' + messageTs);
    return;
  }
  try {
    const sheet = getOrCreateSheet_(spreadsheet, SHEET_QUIZ_LOG, QUIZ_LOG_HEADER);
    const eventAt = new Date(Number(event.event_ts) * 1000);
    if (event.type === 'reaction_added') {
      addQuizReaction_(sheet, event.user, emoji, question, messageTs, eventAt);
    } else if (event.type === 'reaction_removed') {
      removeQuizReaction_(sheet, event.user, emoji, messageTs, eventAt);
    }
  } finally {
    lock.releaseLock();
  }
}

/** 同じ人・同じ問題・同じ絵文字のログ行を {rowNumber, addedAt, removed} で返す */
function findQuizLogRows_(sheet, user, emoji, messageTs) {
  const values = sheet.getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (row[QUIZ_LOG_COL.USER] !== user) continue;
    if (String(row[QUIZ_LOG_COL.EMOJI]) !== emoji) continue;
    if (String(row[QUIZ_LOG_COL.MESSAGE_TS]) !== messageTs) continue;
    rows.push({
      rowNumber: i + 1,
      addedAt: row[QUIZ_LOG_COL.ADDED_AT] instanceof Date ? row[QUIZ_LOG_COL.ADDED_AT] : null,
      removed: String(row[QUIZ_LOG_COL.REMOVED_AT] || '') !== ''
    });
  }
  return rows;
}

function addQuizReaction_(sheet, user, emoji, question, messageTs, eventAt) {
  const rows = findQuizLogRows_(sheet, user, emoji, messageTs);
  // シートに入れた日時は秒未満が丸まりうるので、1秒以内なら同じイベント（再送）とみなす
  const isRetry = rows.some(function (row) {
    return row.addedAt && Math.abs(row.addedAt.getTime() - eventAt.getTime()) < 1000;
  });
  if (isRetry) return;
  if (rows.some(function (row) { return !row.removed; })) return; // すでにリアクション中

  // 外したあとに付け直した場合は新しい行になる（履歴として残す）
  const match = question.number.match(/Ord\s*(\d+)\s*-\s*Q\s*(\d+)/i);
  // 並びは QUIZ_LOG_HEADER と一致させること
  sheet.appendRow([
    eventAt, '', user, emoji, question.number,
    match ? Number(match[1]) : '', match ? Number(match[2]) : '',
    question.postedAt, "'" + messageTs
  ]);
}

function removeQuizReaction_(sheet, user, emoji, messageTs, eventAt) {
  findQuizLogRows_(sheet, user, emoji, messageTs).forEach(function (row) {
    if (row.removed) return;
    // 外したイベントより後に付け直された行は閉じない。
    // 「外す」の再送が、付け直したあとに遅れて届くことがあるため
    if (row.addedAt && row.addedAt.getTime() > eventAt.getTime()) return;
    sheet.getRange(row.rowNumber, QUIZ_LOG_COL.REMOVED_AT + 1).setValue(eventAt);
  });
}

/** 出題メッセージの ts から問題を探す。見つからなければ null */
function findQuizQuestionByTs_(spreadsheet, messageTs) {
  const sheet = spreadsheet.getSheetByName(SHEET_QUIZ_QUESTIONS);
  if (!sheet) return null;
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][QUIZ_COL.MESSAGE_TS] || '').trim() !== messageTs) continue;
    return {
      number: String(values[i][QUIZ_COL.NUMBER] || '').trim(),
      postedAt: values[i][QUIZ_COL.POSTED_AT]
    };
  }
  return null;
}
