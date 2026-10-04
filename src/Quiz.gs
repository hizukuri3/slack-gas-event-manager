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

/** 時間主導トリガー（毎時）から呼ばれる。条件を満たせば1問出題する */
function postDailyQuiz() {
  const config = getConfig_();
  const spreadsheet = SpreadsheetApp.openById(config.managementSpreadsheetId);
  const settings = readQuizSettings_(spreadsheet);
  if (!settings || !settings.channel) return;

  const now = new Date();
  if (settings.postHour === null) {
    console.warn('クイズ設定の「投稿時刻」が 0〜23 の数字ではないため出題しません');
    return;
  }
  if (now.getHours() < settings.postHour) return;
  const day = now.getDay(); // 0:日, 6:土（スクリプトのタイムゾーン Asia/Tokyo で判定される）
  if (settings.skipWeekends && (day === 0 || day === 6)) return;

  const sheet = spreadsheet.getSheetByName(SHEET_QUIZ_QUESTIONS);
  if (!sheet) return;
  const values = sheet.getDataRange().getValues();
  if (hasPostedOn_(values, now)) return;

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
  sheet.getDataRange().getValues().forEach(function (row) {
    byLabel[String(row[0] || '').trim()] = String(row[1]).trim();
  });
  const raw = {};
  QUIZ_SETTING_ITEMS.forEach(function (item) {
    raw[item.key] = Object.prototype.hasOwnProperty.call(byLabel, item.label)
      ? byLabel[item.label] : item.value;
  });

  const hour = /^\d{1,2}$/.test(raw.POST_HOUR) ? Number(raw.POST_HOUR) : -1;
  return {
    channel: raw.CHANNEL,
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
 */
function ensureQuizSettingRows_(sheet) {
  const labels = sheet.getDataRange().getValues().map(function (row) {
    return String(row[0] || '').trim();
  });
  QUIZ_SETTING_ITEMS.forEach(function (item) {
    if (labels.indexOf(item.label) !== -1) return;
    sheet.appendRow([item.label, item.value, item.note]);
    labels.push(item.label);
  });

  // 「土日は休む」の値はドロップダウンにする。「休む」「×」などと書いて
  // 止めたつもりになるのを防ぐ（判定できない値は readQuizSettings_ が休む側に倒す）
  const row = labels.indexOf('土日は休む');
  if (row !== -1) {
    sheet.getRange(row + 1, 2).setDataValidation(
      SpreadsheetApp.newDataValidation()
        .requireValueInList(QUIZ_SKIP_WEEKENDS_CHOICES, true)
        .setAllowInvalid(false)
        .build()
    );
  }
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
