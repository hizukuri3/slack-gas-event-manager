/**
 * VizReview.gs
 * ナイスチャレンジ。フォームに回答があったら設定のチャンネルへ内容を投稿し、
 * その投稿に付いたスタンプとスレッド返信を「ナイスチャレンジレビューログ」に記録する。
 *
 * 設定は「ナイスチャレンジ設定」「ナイスチャレンジ投稿項目」シート（運営が編集）が正。フォームのIDも
 * シートに書くので、フォームの差し替えはシートの書き換えだけで済む。
 * フォームIDか投稿先チャンネルが空のあいだは何もしない。
 *
 * ★ 個人情報の扱い ★
 * 投稿者本人の特定にはフォームで入力されたメールアドレスを使う（users.lookupByEmail）。
 * メールアドレスはシートにもログにも書かない。残るのは Slack ユーザーID だけ。
 * フォームの回答は「ナイスチャレンジ設定」の日数だけ残し（その間は、回答を直すとSlackの投稿も直る）、
 * 過ぎたら毎日のトリガー（cleanupVizResponses）が削除する。0日なら投稿後すぐ削除する。
 * 投稿者を特定できなかった回答は、直す手段が無いのですぐ削除する。
 * 投稿に失敗した回答は、再処理できるよう削除しない。
 *
 * 本人（投稿者）のスタンプ・返信は記録しない。メールから本人を特定できなかった投稿は
 * 除外ができないので、ナイスチャレンジ投稿ログの「投稿者」欄が「本人不明」になる。
 */

// ==================== フォーム送信 ====================

/**
 * フォーム送信のうち、ナイスチャレンジ用フォームからのものを処理する。
 * onFormSubmit（FormHandler.gs）の先頭から呼ばれ、ナイスチャレンジ用フォームの送信なら true を返す
 * （true のときイベント登録の処理には進まない）。
 */
function handleVizFormSubmit_(config, e) {
  // ここで例外を出すと、イベント登録の処理まで止まる。設定を読めないときは「Vizではない」として通す
  let spreadsheet;
  let settings;
  try {
    spreadsheet = SpreadsheetApp.openById(config.managementSpreadsheetId);
    settings = readVizSettings_(spreadsheet);
  } catch (err) {
    console.warn('ナイスチャレンジ設定を読めませんでした（イベント登録として処理します）: ' + err);
    return false;
  }
  const sourceId = e.source.getId();
  if (!settings || !settings.formId || settings.formId !== sourceId) return false;
  // イベント登録フォームと同じIDが書かれていたら、イベント側の処理を優先する
  if (formIds_(config).indexOf(sourceId) !== -1) return false;

  try {
    postVizReviewRequest_(config, spreadsheet, settings, e);
  } catch (err) {
    // 例外で抜けても回答は削除されない。運営がログを見て対処できる
    console.error('ナイスチャレンジの投稿でエラー: ' + err);
  }
  return true;
}

function postVizReviewRequest_(config, spreadsheet, settings, e) {
  if (!settings.channel) {
    console.warn('ナイスチャレンジ設定の「投稿先チャンネル」が空のため投稿しません');
    return;
  }
  const channelId = resolveChannelId_(config, settings.channel);
  if (!channelId) {
    console.warn('ナイスチャレンジ設定の「投稿先チャンネル」が見つかりません: ' + settings.channel);
    return;
  }

  const formResponse = e.response;
  const responseId = formResponse.getId();
  const logSheet = getOrCreateSheet_(spreadsheet, SHEET_VIZ_LOG, VIZ_LOG_HEADER);

  // 回答を設問名で引く。メールアドレスの設問だけは本文に入れず、投稿者の特定にだけ使う
  const answers = {};
  let email = '';
  formResponse.getItemResponses().forEach(function (itemResponse) {
    const title = itemResponse.getItem().getTitle();
    const value = itemResponse.getResponse();
    const text = Array.isArray(value) ? value.join('、') : String(value || '');
    if (title === settings.emailQuestion) {
      email = text.trim();
    } else {
      answers[title] = text.trim();
    }
  });
  // 設問としてのメールが無ければ、フォームの「メールアドレスを収集する」設定で集めた値を使う
  if (!email) email = getVizRespondentEmail_(formResponse);
  ensureVizFieldRows_(spreadsheet, Object.keys(answers));
  const fields = readVizFields_(spreadsheet);

  // 同じ回答IDがすでに投稿済みなら、回答の編集（または Google 側の二重送信）。
  // 編集なら投稿を書き換える。投稿者はログのものを使い、メールは引き直さない
  const posted = findVizPostByResponseId_(logSheet, responseId);
  if (posted) {
    updateVizPost_(config, logSheet, settings, fields, answers, posted);
    return;
  }

  // 取得できなければ空文字。メールは変数に持つだけで、ログにも出さない
  const authorId = email ? lookupSlackUserIdByEmail_(config, email) : '';
  if (!authorId) {
    console.warn('メールアドレスから投稿者を特定できませんでした（本人の除外ができません）');
  }

  // 師匠は常に全員。メンション先は「師匠リスト」の有効な人（getConfig_ が読むプロパティの写し）
  const text = buildVizPostText_(settings, fields, answers, authorId, config.masterUserIds);
  const messageTs = postVizMessage_(config, channelId, settings, text);
  if (!messageTs) {
    console.error('ナイスチャレンジの投稿に失敗しました（回答は削除していません）: ' + responseId);
    if (authorId) {
      sendDirectMessage_(config, authorId,
        ':warning: ナイスチャレンジの投稿できませんでした。運営へ連絡してください。');
    }
    return;
  }

  const row = recordVizPost_(logSheet, authorId, text, channelId, messageTs, responseId);

  // 回答を残すのは、本人へ編集用URLを渡せるときだけ。渡せないなら、メールが残るだけなので消す。
  // ログに書けなかったとき（row が 0）は、編集も期限切れの削除もできなくなるので、同じくすぐ消す
  if (authorId && settings.retentionDays > 0 && row) {
    notifyVizAuthor_(config, authorId, formResponse, settings.retentionDays);
    return;
  }
  if (deleteVizResponse_(e.source, responseId) && row) {
    logSheet.getRange(row, VIZ_LOG_COL.RESPONSE_DELETED_AT + 1).setValue(new Date());
  }
}

/** フォームの「メールアドレスを収集する」設定で集めたメール。集めていなければ空文字 */
function getVizRespondentEmail_(formResponse) {
  try {
    return String(formResponse.getRespondentEmail() || '').trim();
  } catch (err) {
    return '';
  }
}

/** 投稿者へ、投稿できたことと回答の編集用URLをDMで知らせる */
function notifyVizAuthor_(config, authorId, formResponse, retentionDays) {
  const until = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000);
  sendDirectMessage_(config, authorId,
    'ナイスチャレンジの投稿しました :white_check_mark:\n' +
    '内容を直したいときは、' + Utilities.formatDate(until, 'Asia/Tokyo', 'M/d') + ' ごろまでなら、' +
    '次のURLから回答を編集すると投稿も更新されます（このURLは他の人に共有しないでください）。\n' +
    formResponse.getEditResponseUrl());
}

/** 編集された回答の内容で、投稿済みのSlackメッセージを書き換える */
function updateVizPost_(config, logSheet, settings, fields, answers, posted) {
  // 投稿者のメンションは、ログに残っているSlack IDで作り直す（本人不明なら「メンバー」）
  const authorId = posted.author === VIZ_AUTHOR_UNKNOWN ? '' : posted.author;
  const text = buildVizPostText_(settings, fields, answers, authorId, config.masterUserIds);
  const json = callSlackApi_(config, 'chat.update', {
    channel: posted.channel, ts: posted.messageTs, text: text
  });
  if (!json.ok) {
    console.error('ナイスチャレンジの投稿を更新できませんでした: ' + json.error);
    if (authorId) {
      sendDirectMessage_(config, authorId,
        ':warning: 回答の修正を投稿に反映できませんでした。運営へ連絡してください。');
    }
    return;
  }
  logSheet.getRange(posted.rowNumber, VIZ_LOG_COL.TEXT + 1).setValue(truncateForLog_(text));
}

/** 冒頭文・各設問（ナイスチャレンジ投稿項目の順）・末尾文をつないだ投稿本文を作る */
function buildVizPostText_(settings, fields, answers, authorId, masterIds) {
  const lines = [];
  if (settings.header) {
    const author = authorId ? '<@' + authorId + '>' : 'メンバー';
    lines.push(settings.header.split('{author}').join(author));
  }
  fields.forEach(function (field) {
    if (!field.enabled) return;
    const answer = answers[field.question];
    if (!answer) return;
    lines.push('*' + escapeSlackText_(field.label || field.question) + '*\n' + escapeSlackText_(answer));
  });
  // 投稿者本人が師匠のときは、自分へのメンションは付けない
  const mentions = (masterIds || []).filter(function (id) { return id !== authorId; });
  if (settings.masterLine && mentions.length > 0) {
    lines.push(settings.masterLine.split('{masters}').join(mentions.map(function (id) {
      return '<@' + id + '>';
    }).join(' ')));
  }
  if (settings.footer) lines.push(settings.footer);
  return lines.join('\n\n');
}

/**
 * Slack の特殊文字を無害化する。回答に <!channel> などが書かれていても
 * メンションとして働かせないため（URL は < > で囲まなくても自動でリンクになる）
 */
function escapeSlackText_(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function postVizMessage_(config, channelId, settings, text) {
  const payload = { channel: channelId, text: text };
  if (settings.botName) payload.username = settings.botName;
  if (/^https?:\/\//.test(settings.botIcon)) {
    payload.icon_url = settings.botIcon;
  } else if (settings.botIcon) {
    payload.icon_emoji = ':' + settings.botIcon.replace(/^:|:$/g, '') + ':';
  }
  const json = callSlackApi_(config, 'chat.postMessage', payload);
  return json.ok ? json.ts : null;
}

/** 回答をフォームから削除する。失敗しても投稿は済んでいるので止めず、削除できたかを返す */
function deleteVizResponse_(form, responseId) {
  try {
    // 回答シートに紐づいていると、フォームの回答を消してもシート側の行（メール入り）が残る
    if (form.getDestinationType() === FormApp.DestinationType.SPREADSHEET) {
      console.warn('このフォームは回答シートに紐づいています。メールアドレスがシートに残るため、' +
        'フォームの「回答」タブで「リンク解除」するか、シートの行を削除してください');
    }
    form.deleteResponse(responseId);
    return true;
  } catch (err) {
    console.warn('フォームの回答を削除できませんでした: ' + err);
    return false;
  }
}

/** ナイスチャレンジ投稿ログへ1行足し、スタンプ数・返信数・返信した人数の数式を入れる。書いた行番号を返す（書けなければ 0） */
function recordVizPost_(sheet, authorId, text, channelId, messageTs, responseId) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (err) {
    console.warn('ナイスチャレンジ投稿ログのロック取得に失敗しました: ' + messageTs);
    return 0;
  }
  try {
    // 並びは VIZ_LOG_HEADER と一致させること。ts は数値化で桁が落ちるのでアポストロフィで文字列にする
    sheet.appendRow([
      new Date(), authorId || VIZ_AUTHOR_UNKNOWN, '', '', '',
      truncateForLog_(text), channelId, "'" + messageTs, responseId, ''
    ]);
    const row = sheet.getLastRow();
    const review = "'" + SHEET_VIZ_REVIEW_LOG + "'!";
    // 文字列どうしの完全一致で数える（COUNTIFS は ts を数値に読み替えて桁を落とす）
    const match = '(' + review + '$E$2:$E=$H' + row + ')*(' + review + '$F$2:$F="")';
    sheet.getRange(row, VIZ_LOG_COL.STAMPS + 1, 1, 3).setFormulas([[
      '=SUMPRODUCT(' + match + '*(' + review + '$B$2:$B="' + VIZ_KIND_STAMP + '"))',
      '=SUMPRODUCT(' + match + '*(' + review + '$B$2:$B="' + VIZ_KIND_REPLY + '"))',
      '=IFERROR(COUNTA(UNIQUE(FILTER(' + review + '$C$2:$C,' + review + '$E$2:$E=$H' + row + ',' +
        review + '$B$2:$B="' + VIZ_KIND_REPLY + '",' + review + '$F$2:$F=""))),0)'
    ]]);
    return row;
  } finally {
    lock.releaseLock();
  }
}

/** 回答IDで投稿済みの行を探す。無ければ null */
function findVizPostByResponseId_(sheet, responseId) {
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][VIZ_LOG_COL.RESPONSE_ID]) !== responseId) continue;
    return {
      rowNumber: i + 1,
      author: String(values[i][VIZ_LOG_COL.AUTHOR]),
      channel: String(values[i][VIZ_LOG_COL.CHANNEL]),
      messageTs: String(values[i][VIZ_LOG_COL.MESSAGE_TS])
    };
  }
  return null;
}

/** ナイスチャレンジ投稿ログから、投稿メッセージのtsで投稿を探す。無ければ null */
function findVizPostByTs_(spreadsheet, messageTs) {
  const sheet = spreadsheet.getSheetByName(SHEET_VIZ_LOG);
  if (!sheet) return null;
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][VIZ_LOG_COL.MESSAGE_TS]) !== messageTs) continue;
    return { author: String(values[i][VIZ_LOG_COL.AUTHOR]) };
  }
  return null;
}

// ==================== スタンプ・返信の記録 ====================

/**
 * Viz投稿に付いた／外れたスタンプを記録する。handleSlackEvent_ から、
 * 他の機能とは独立に呼ばれる。本人のスタンプは記録しない。
 * 同じ人・同じ投稿・同じ絵文字で追加日時が同じ行があれば Slack の再送とみなす。
 */
function handleVizReaction_(config, event) {
  // ナイスチャレンジ以外のチャンネルのスタンプは、シートを開く前に抜ける
  const vizChannel = getVizChannelId_(config);
  if (!vizChannel || vizChannel !== event.item.channel) return;
  const spreadsheet = SpreadsheetApp.openById(config.managementSpreadsheetId);
  const post = findVizPostForEvent_(config, spreadsheet, event.item.channel, String(event.item.ts));
  if (!post || event.user === post.author) return;

  const emoji = normalizeEmojiName_(event.reaction);
  const postTs = String(event.item.ts);
  const eventAt = new Date(Number(event.event_ts) * 1000);
  const sheet = getOrCreateSheet_(spreadsheet, SHEET_VIZ_REVIEW_LOG, VIZ_REVIEW_HEADER);

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (err) {
    console.warn('ナイスチャレンジレビューログのロック取得に失敗しました: ' + event.user + '/' + postTs);
    return;
  }
  try {
    const rows = findVizReviewRows_(sheet, function (row) {
      return row[VIZ_REVIEW_COL.KIND] === VIZ_KIND_STAMP &&
        row[VIZ_REVIEW_COL.USER] === event.user &&
        String(row[VIZ_REVIEW_COL.EMOJI]) === emoji &&
        String(row[VIZ_REVIEW_COL.POST_TS]) === postTs;
    });
    if (event.type === 'reaction_added') {
      const isRetry = rows.some(function (r) {
        return r.at && Math.abs(r.at.getTime() - eventAt.getTime()) < 1000;
      });
      if (isRetry || rows.some(function (r) { return !r.removed; })) return;
      // 並びは VIZ_REVIEW_HEADER と一致させること
      sheet.appendRow([eventAt, VIZ_KIND_STAMP, event.user, emoji, "'" + postTs, '', '']);
    } else if (event.type === 'reaction_removed') {
      rows.forEach(function (r) {
        if (r.removed) return;
        // 外すイベントより後に付け直された行は閉じない（再送が遅れて届くことがある）
        if (r.at && r.at.getTime() > eventAt.getTime()) return;
        sheet.getRange(r.rowNumber, VIZ_REVIEW_COL.REMOVED_AT + 1).setValue(eventAt);
      });
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * Viz投稿のスレッドへの返信（message イベント）を記録する。本文は保存しない。
 * 返信が削除されたとき（message_deleted）は、削除日時を埋める。
 */
function handleVizReply_(config, event) {
  // 返信の削除は、元の返信が previous_message に入って届く
  if (event.subtype === 'message_deleted') {
    const prev = event.previous_message || {};
    if (!prev.thread_ts || !event.deleted_ts) return;
    handleVizReplyDeleted_(config, event.channel, String(prev.thread_ts), String(event.deleted_ts),
      new Date(Number(event.event_ts) * 1000));
    return;
  }
  // 編集（message_changed）やBotの投稿は対象外。通常の返信と「チャンネルにも投稿」だけ拾う
  if (event.subtype && event.subtype !== 'thread_broadcast') return;
  if (event.bot_id || !event.user) return;
  // スレッドの親メッセージ自身（thread_ts === ts）は返信ではない
  if (!event.thread_ts || event.thread_ts === event.ts) return;

  // ナイスチャレンジ以外のチャンネルの返信は、シートを開く前に抜ける
  const vizChannel = getVizChannelId_(config);
  if (!vizChannel || vizChannel !== event.channel) return;
  const spreadsheet = SpreadsheetApp.openById(config.managementSpreadsheetId);
  const postTs = String(event.thread_ts);
  const post = findVizPostForEvent_(config, spreadsheet, event.channel, postTs);
  if (!post || event.user === post.author) return;

  const replyTs = String(event.ts);
  const sheet = getOrCreateSheet_(spreadsheet, SHEET_VIZ_REVIEW_LOG, VIZ_REVIEW_HEADER);
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (err) {
    console.warn('ナイスチャレンジレビューログのロック取得に失敗しました: ' + event.user + '/' + replyTs);
    return;
  }
  try {
    // 返信のtsは1件ごとに固有。同じtsの行があれば再送
    const dup = findVizReviewRows_(sheet, function (row) {
      return row[VIZ_REVIEW_COL.KIND] === VIZ_KIND_REPLY && String(row[VIZ_REVIEW_COL.REPLY_TS]) === replyTs;
    });
    if (dup.length > 0) return;
    sheet.appendRow([
      new Date(Number(replyTs.split('.')[0]) * 1000), VIZ_KIND_REPLY, event.user, '',
      "'" + postTs, '', "'" + replyTs
    ]);
  } finally {
    lock.releaseLock();
  }
}

function handleVizReplyDeleted_(config, channel, postTs, replyTs, deletedAt) {
  const spreadsheet = SpreadsheetApp.openById(config.managementSpreadsheetId);
  if (!findVizPostForEvent_(config, spreadsheet, channel, postTs)) return;
  const sheet = spreadsheet.getSheetByName(SHEET_VIZ_REVIEW_LOG);
  if (!sheet) return;
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (err) {
    console.warn('ナイスチャレンジレビューログのロック取得に失敗しました: 返信の削除 ' + replyTs);
    return;
  }
  try {
    findVizReviewRows_(sheet, function (row) {
      return row[VIZ_REVIEW_COL.KIND] === VIZ_KIND_REPLY && String(row[VIZ_REVIEW_COL.REPLY_TS]) === replyTs;
    }).forEach(function (r) {
      if (r.removed) return;
      sheet.getRange(r.rowNumber, VIZ_REVIEW_COL.REMOVED_AT + 1).setValue(deletedAt);
    });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Viz の投稿先チャンネルID。機能がオフ（フォームIDか投稿先が空）なら空文字。
 * スタンプも返信も、ナイスチャレンジ以外の大半のイベントはここで抜けたい。毎回シートを読むと
 * Slack の3秒ルールを圧迫するので、結果を短くキャッシュする。
 * 設定を編集したときは syncVizSettings_ がキャッシュを消す。
 */
function getVizChannelId_(config) {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(VIZ_CHANNEL_CACHE_KEY);
  if (cached !== null) return cached === '-' ? '' : cached;

  const settings = readVizSettings_(SpreadsheetApp.openById(config.managementSpreadsheetId));
  const channelId = settings && settings.formId && settings.channel
    ? resolveChannelId_(config, settings.channel) : '';
  cache.put(VIZ_CHANNEL_CACHE_KEY, channelId || '-', 300);
  return channelId;
}

const VIZ_CHANNEL_CACHE_KEY = 'viz_channel';

/**
 * イベントの対象が Viz 投稿かを判定して返す。違えば null。
 * 設定が無効・チャンネルが違う場合も null（ナイスチャレンジ以外の大半のイベントはここで抜ける）。
 */
function findVizPostForEvent_(config, spreadsheet, channel, postTs) {
  const vizChannel = getVizChannelId_(config);
  if (!vizChannel || vizChannel !== channel) return null;
  return findVizPostByTs_(spreadsheet, postTs);
}

/** 条件に合うレビューログ行を {rowNumber, at, removed} で返す */
function findVizReviewRows_(sheet, predicate) {
  const values = sheet.getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    if (!predicate(values[i])) continue;
    rows.push({
      rowNumber: i + 1,
      at: values[i][VIZ_REVIEW_COL.AT] instanceof Date ? values[i][VIZ_REVIEW_COL.AT] : null,
      removed: String(values[i][VIZ_REVIEW_COL.REMOVED_AT] || '') !== ''
    });
  }
  return rows;
}

// ==================== 設定 ====================

/**
 * 「ナイスチャレンジ設定」シートを読む。シートが無ければ null。
 * シートに行が無い項目は既定値を使う。行があって値が空なら空として扱う。
 */
function readVizSettings_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(SHEET_VIZ_SETTINGS);
  if (!sheet) return null;

  const byLabel = {};
  sheet.getDataRange().getValues().forEach(function (row) {
    byLabel[String(row[0] || '').trim()] = String(row[1]).trim();
  });
  const raw = {};
  VIZ_SETTING_ITEMS.forEach(function (item) {
    raw[item.key] = Object.prototype.hasOwnProperty.call(byLabel, item.label)
      ? byLabel[item.label] : item.value;
  });

  return {
    formId: parseFormId_(raw.FORM_ID),
    channel: raw.CHANNEL,
    emailQuestion: raw.EMAIL_QUESTION || VIZ_FORM_TITLES.EMAIL,
    header: raw.HEADER,
    masterLine: raw.MASTER_LINE,
    footer: raw.FOOTER,
    // 数字でない・範囲外の値は0（すぐ削除）に倒す。メールを残す側には倒さない
    retentionDays: /^\d{1,3}$/.test(raw.RETENTION_DAYS) && Number(raw.RETENTION_DAYS) <= 365
      ? Number(raw.RETENTION_DAYS) : 0,
    botName: raw.BOT_NAME,
    botIcon: raw.BOT_ICON
  };
}

/** フォームの編集画面URL（…/forms/d/{id}/edit）かIDそのものから、フォームIDを取り出す */
function parseFormId_(value) {
  const text = String(value || '').trim();
  const match = text.match(/\/forms\/d\/(?:e\/)?([\w-]+)/);
  return match ? match[1] : text;
}

/** 「ナイスチャレンジ設定」に、まだ無い項目の行を既定値つきで足す。既存の行は触らない */
function ensureVizSettingRows_(sheet) {
  const labels = sheet.getDataRange().getValues().map(function (row) {
    return String(row[0] || '').trim();
  });
  VIZ_SETTING_ITEMS.forEach(function (item) {
    if (labels.indexOf(item.label) !== -1) return;
    sheet.appendRow([item.label, item.value, item.note]);
    labels.push(item.label);
  });
  // 日数は0〜365の整数に絞る。文字が入ると readVizSettings_ は0（すぐ削除）として扱う
  const row = labels.indexOf(VIZ_SETTING_ITEMS.filter(function (i) { return i.key === 'RETENTION_DAYS'; })[0].label);
  if (row !== -1) {
    sheet.getRange(row + 1, 2).setDataValidation(
      SpreadsheetApp.newDataValidation()
        .requireNumberBetween(0, 365)
        .setAllowInvalid(false)
        .build()
    );
  }
}

/** 「ナイスチャレンジ投稿項目」を読む。並びがそのまま投稿の並び */
function readVizFields_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(SHEET_VIZ_FIELDS);
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  const fields = [];
  for (let i = 1; i < values.length; i++) {
    const question = String(values[i][VIZ_FIELD_COL.QUESTION] || '').trim();
    if (!question) continue;
    fields.push({
      question: question,
      label: String(values[i][VIZ_FIELD_COL.LABEL] || '').trim(),
      enabled: isEnabledFlag_(values[i][VIZ_FIELD_COL.ENABLED])
    });
  }
  return fields;
}

/**
 * 「ナイスチャレンジ投稿項目」に、まだ無い設問の行を末尾へ足す。既存の行（見出し・並び・有効）は触らない。
 * メールアドレスの設問は呼び出し側が除いて渡す。
 */
function ensureVizFieldRows_(spreadsheet, questions) {
  const sheet = getOrCreateSheet_(spreadsheet, SHEET_VIZ_FIELDS, VIZ_FIELDS_HEADER);
  const known = readVizFields_(spreadsheet).map(function (f) { return f.question; });
  const missing = questions.filter(function (q) { return q && known.indexOf(q) === -1; });
  if (missing.length === 0) return;
  sheet.getRange(sheet.getLastRow() + 1, 1, missing.length, VIZ_FIELD_COL.QUESTION + 1)
    .setValues(missing.map(function (q) { return [q]; }));
  setupEnabledColumn_(sheet, VIZ_FIELD_COL.ENABLED);
}

/**
 * フォームの設問を「ナイスチャレンジ投稿項目」へ反映する（フォームを差し替えた・設問を足したとき）。
 * セクション区切りや画像など回答を持たない設問、メールアドレスの設問は入れない。
 */
function syncVizFields_(spreadsheet, settings) {
  if (!settings || !settings.formId) return 0;
  const form = FormApp.openById(settings.formId);
  const questions = form.getItems().filter(function (item) {
    const type = item.getType();
    return type !== FormApp.ItemType.PAGE_BREAK && type !== FormApp.ItemType.SECTION_HEADER &&
      type !== FormApp.ItemType.IMAGE && type !== FormApp.ItemType.VIDEO &&
      item.getTitle() !== settings.emailQuestion;
  }).map(function (item) { return item.getTitle(); });
  const before = readVizFields_(spreadsheet).length;
  ensureVizFieldRows_(spreadsheet, questions);
  return readVizFields_(spreadsheet).length - before;
}

// ==================== トリガーと反映 ====================

/**
 * ナイスチャレンジ用フォームの送信トリガーを、設定のフォームIDに合わせる。
 * イベント登録フォームのトリガーには触らない。設定が空・不正なら、古いナイスチャレンジ用トリガーだけ消す。
 * @return {string} 結果の説明（トースト・ログ用）
 */
function syncVizFormTrigger_(config, settings) {
  const vizId = settings && settings.formId;
  const eventIds = formIds_(config);
  let found = false;
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() !== 'onFormSubmit') return;
    const sourceId = trigger.getTriggerSourceId();
    if (eventIds.indexOf(sourceId) !== -1) return;
    if (vizId && sourceId === vizId && !found) {
      found = true;
      return;
    }
    ScriptApp.deleteTrigger(trigger); // 差し替え前のフォームや重複
  });
  if (!vizId) return 'フォームが未設定のため、ナイスチャレンジのトリガーは無効です';
  if (eventIds.indexOf(vizId) !== -1) {
    return 'イベント登録フォームと同じIDは使えません';
  }
  if (!found) {
    ScriptApp.newTrigger('onFormSubmit').forForm(vizId).onFormSubmit().create();
  }
  return 'ナイスチャレンジのフォームを受け付ける設定にしました';
}

/**
 * 「ナイスチャレンジ設定」を編集したときの反映（編集トリガーから呼ばれる）。
 * フォームIDが変わったら、トリガーと投稿項目をその場で追随させる。
 */
function syncVizSettings_(spreadsheet) {
  const config = getConfig_();
  CacheService.getScriptCache().remove(VIZ_CHANNEL_CACHE_KEY);
  const settings = readVizSettings_(spreadsheet);
  let message;
  try {
    message = syncVizFormTrigger_(config, settings);
    applyVizFormSettings_(settings);
    const added = syncVizFields_(spreadsheet, settings);
    if (added > 0) message += '（投稿項目に ' + added + '件の設問を追加しました）';
  } catch (err) {
    // フォームを開けない（IDの誤り・権限なし）ときもここへ来る
    console.warn('ナイスチャレンジのフォームを反映できませんでした: ' + err);
    message = 'フォームを開けませんでした。IDと、このスクリプトの実行者が編集できるかを確認してください';
  }
  spreadsheet.toast(message, SHEET_VIZ_SETTINGS, 8);
}

/**
 * 「回答を残す日数」に合わせて、フォームの「回答の編集を許可」を切り替える。
 * 日数が0なら編集URLを使う場面が無いのでオフにし、1日以上ならオンにする
 */
function applyVizFormSettings_(settings) {
  if (!settings || !settings.formId) return;
  FormApp.openById(settings.formId).setAllowResponseEdits(settings.retentionDays > 0);
}

/** 初回セットアップ・setupTriggers から呼ぶ。シートを整え、フォームの設問を投稿項目へ写す */
function setupVizReview_(config) {
  const spreadsheet = SpreadsheetApp.openById(config.managementSpreadsheetId);
  ensureVizSettingRows_(getOrCreateSheet_(spreadsheet, SHEET_VIZ_SETTINGS, VIZ_SETTINGS_HEADER));
  const fields = getOrCreateSheet_(spreadsheet, SHEET_VIZ_FIELDS, VIZ_FIELDS_HEADER);
  setupEnabledColumn_(fields, VIZ_FIELD_COL.ENABLED);
  const log = getOrCreateSheet_(spreadsheet, SHEET_VIZ_LOG, VIZ_LOG_HEADER);
  ensureHeader_(log, VIZ_LOG_HEADER);
  protectSystemSheet_(log);
  const review = getOrCreateSheet_(spreadsheet, SHEET_VIZ_REVIEW_LOG, VIZ_REVIEW_HEADER);
  ensureHeader_(review, VIZ_REVIEW_HEADER);
  protectSystemSheet_(review);

  const settings = readVizSettings_(spreadsheet);
  // フォームIDが誤っていても、ここで例外を出して setupTriggers() ごと止めない（既存の機能のセットアップを巻き込まない）
  try {
    syncVizFormTrigger_(config, settings);
    applyVizFormSettings_(settings);
    syncVizFields_(spreadsheet, settings);
  } catch (err) {
    console.warn('ナイスチャレンジのフォームの設問を「ナイスチャレンジ投稿項目」へ反映できませんでした: ' + err);
  }
}

// ==================== 回答の削除（期限切れ） ====================

/**
 * 時間主導トリガー（毎日。setupTriggers で登録）から呼ばれる。
 * 投稿から「回答を残す日数」を過ぎた回答を、フォームから削除する。
 * 削除したらナイスチャレンジ投稿ログに日時を書く。削除できなかった回答は、次の日にまたやり直す。
 */
function cleanupVizResponses() {
  const config = getConfig_();
  const spreadsheet = SpreadsheetApp.openById(config.managementSpreadsheetId);
  const settings = readVizSettings_(spreadsheet);
  const sheet = spreadsheet.getSheetByName(SHEET_VIZ_LOG);
  if (!settings || !settings.formId || !sheet) return;

  const limit = Date.now() - settings.retentionDays * 24 * 60 * 60 * 1000;
  const values = sheet.getDataRange().getValues();
  let form = null;
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const responseId = String(row[VIZ_LOG_COL.RESPONSE_ID] || '');
    if (!responseId || String(row[VIZ_LOG_COL.RESPONSE_DELETED_AT] || '') !== '') continue;
    const postedAt = row[VIZ_LOG_COL.POSTED_AT];
    if (!(postedAt instanceof Date) || postedAt.getTime() > limit) continue;

    if (!form) form = FormApp.openById(settings.formId);
    if (deleteVizResponse_(form, responseId)) {
      sheet.getRange(i + 1, VIZ_LOG_COL.RESPONSE_DELETED_AT + 1).setValue(new Date());
    }
  }
}

// ==================== フォームの新規作成（bootstrap） ====================

/** ナイスチャレンジ用フォームの設問定義。既定の形で、運営がフォーム側で足したり直したりしてよい */
function vizFormSpec_() {
  return [
    { title: VIZ_FORM_TITLES.EMAIL, type: 'TEXT', required: true },
    { title: VIZ_FORM_TITLES.NAME, type: 'TEXT', required: true },
    { title: VIZ_FORM_TITLES.URL, type: 'TEXT', required: true },
    { title: VIZ_FORM_TITLES.POINT, type: 'PARAGRAPH_TEXT', required: false }
  ];
}

/** ナイスチャレンジ用フォームを新規作成してIDを返す（マイドライブ直下にできる） */
function createVizForm_() {
  const form = FormApp.create(RESOURCE_NAMES.VIZ_FORM);
  form.setTitle(FORM_DISPLAY_TITLES.VIZ);
  form.setCollectEmail(false);            // メールはGoogleアカウントからではなく、設問で入力してもらう
  form.setAllowResponseEdits(true);       // 期間中は、編集用URLから回答を直すと投稿も直る
  form.setLimitOneResponsePerUser(false); // 何作品でも依頼できるように
  vizFormSpec_().forEach(function (spec) { addFormItem_(form, spec); });
  const email = findFormItemByTitle_(form, VIZ_FORM_TITLES.EMAIL).asTextItem();
  email.setHelpText('Slackに登録しているメールアドレスを入力してください。投稿者の特定にだけ使い、' +
    '投稿には載せません。');
  email.setValidation(FormApp.createTextValidation().requireTextIsEmail().build());
  return form.getId();
}

/**
 * bootstrap() から呼ぶ。「ナイスチャレンジ設定」のフォーム欄が空のときだけ、フォームを作ってIDを書く。
 * すでにIDが入っている（既存のフォームを使う）ときは何もしない。
 * @return {string} ログ用の説明
 */
function ensureVizForm_(config) {
  const spreadsheet = SpreadsheetApp.openById(config.managementSpreadsheetId);
  const sheet = getOrCreateSheet_(spreadsheet, SHEET_VIZ_SETTINGS, VIZ_SETTINGS_HEADER);
  ensureVizSettingRows_(sheet);
  const settings = readVizSettings_(spreadsheet);
  if (settings.formId) return 'ナイスチャレンジ用フォーム: 既存のためスキップ (' + settings.formId + ')';

  const formId = createVizForm_();
  const labels = sheet.getDataRange().getValues().map(function (row) { return String(row[0]).trim(); });
  sheet.getRange(labels.indexOf(VIZ_SETTING_ITEMS[0].label) + 1, 2).setValue(formEditUrl_(formId));
  setupVizReview_(config); // トリガーと投稿項目を、できたフォームに合わせる
  return 'ナイスチャレンジ用フォーム: 新規作成 (' + formId + ')';
}

/** bootstrap のログ表示用。「ナイスチャレンジ設定」に書かれたフォームIDを返す（読めなければ空） */
function readVizFormIdForLog_(managementSpreadsheetId) {
  try {
    const settings = readVizSettings_(SpreadsheetApp.openById(managementSpreadsheetId));
    return settings ? settings.formId : '';
  } catch (err) {
    return '';
  }
}

// ==================== Slack ユーザーの特定 ====================

/**
 * メールアドレスから Slack ユーザーID を引く。見つからなければ空文字。
 * メールはログに出さない（Slack API のエラーコードだけが callSlackApiGet_ に記録される）。
 */
function lookupSlackUserIdByEmail_(config, email) {
  const json = callSlackApiGet_(config, 'users.lookupByEmail', { email: email.toLowerCase() });
  return json.ok && json.user ? json.user.id : '';
}
