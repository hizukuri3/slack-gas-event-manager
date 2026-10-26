/**
 * VizReview.gs
 * ナイスチャレンジ。フォームに回答があったら設定のチャンネルへ内容を投稿し、
 * その投稿に付いたスタンプとスレッド返信を「ナイスチャレンジレビューログ」に記録する。
 *
 * 設定は「ナイスチャレンジ設定」シート（運営が編集）が正。フォームのIDも
 * シートに書くので、フォームの差し替えはシートの書き換えだけで済む。
 * 投稿の形（見出し・並び・冒頭と末尾の文）は VIZ_POST_FIELDS などでコードに固定している。
 * フォームIDか投稿先チャンネルが空のあいだは何もしない。
 *
 * ★ 個人情報の扱い ★
 * 投稿者本人の特定には、フォームで入力された Slack ユーザーIDを使う。メールアドレスは集めない。
 * スラッシュコマンド（VIZ_SLASH_COMMAND）で開いたフォームでは、IDが自動で入る。
 * フォームの回答は「ナイスチャレンジ設定」の日数だけ残し（その間は、回答を直すとSlackの投稿も直る）、
 * 過ぎたら毎日のトリガー（cleanupVizResponses）が削除する。0日なら投稿後すぐ削除する。
 * 投稿者を特定できなかった回答は、直す手段が無いのですぐ削除する。
 * 投稿に失敗した回答は、再処理できるよう削除しない。
 *
 * 本人（投稿者）のスタンプ・返信は記録しない。IDが不正で本人を特定できなかった投稿は
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

  // 回答を設問名で引く。投稿者のSlackユーザーIDの設問だけは本文に入れず、投稿者の特定にだけ使う
  const answers = {};
  let authorInput = '';
  formResponse.getItemResponses().forEach(function (itemResponse) {
    const title = itemResponse.getItem().getTitle();
    const value = itemResponse.getResponse();
    const text = Array.isArray(value) ? value.join('、') : String(value || '');
    if (title === settings.authorQuestion) {
      authorInput = text.trim();
    } else {
      answers[title] = text.trim();
    }
  });

  // 同じ回答IDがすでに投稿済みなら、回答の編集（または Google 側の二重送信）。
  // 編集なら投稿を書き換える。投稿者はログのものを使い、入力のIDは見直さない
  const posted = findVizPostByResponseId_(logSheet, responseId);
  if (posted) {
    updateVizPost_(config, logSheet, answers, posted);
    return;
  }

  // 形式が不正なら空文字（本人不明）。入力された値はログに出さない
  const normalizedId = normalizeSlackUserId_(authorInput);
  const authorId = isValidSlackUserId_(normalizedId) ? normalizedId : '';
  if (!authorId) {
    console.warn('投稿者のSlackユーザーIDを読み取れませんでした（本人の除外ができません）');
  }
  // 形式は正しいが実在しないID（打ち間違い）は投稿しない。誰にも知らせる手段がないので、
  // 本人には「チャンネルに出ない」ことで気づいてもらう（フォームの送信後メッセージにも書いてある）。
  // 回答は消さず、運営がフォームの回答から確認できるようにしておく
  if (authorId && !slackUserExists_(config, authorId)) {
    console.warn('投稿者のSlackユーザーIDが見つかりません。投稿しませんでした（回答は削除していません）: ' + responseId);
    return;
  }

  // 親の投稿（見出しと案内だけ）を出し、その返信に本文を載せる。投稿に必ず返信が付くので、
  // スレッドが最初から立ち、レビューの書き込み先が分かる。
  // 師匠は常に全員。メンション先は「師匠リスト」の有効な人（getConfig_ が読むプロパティの写し）
  const text = buildVizPostText_(answers, authorId, config.masterUserIds);
  const messageTs = postVizMessage_(config, channelId, settings, buildVizParentText_(authorId, answers));
  if (!messageTs) {
    console.error('ナイスチャレンジの投稿に失敗しました（回答は削除していません）: ' + responseId);
    if (authorId) {
      sendDirectMessage_(config, authorId,
        ':warning: ナイスチャレンジを投稿できませんでした。運営へ連絡してください。');
    }
    return;
  }
  const bodyTs = postVizMessage_(config, channelId, settings, text, messageTs);
  if (!bodyTs) {
    // 親だけが残ると、中身のない募集が出てしまう。親を消して、投稿できなかったことにする
    console.error('ナイスチャレンジの本文を投稿できませんでした（回答は削除していません）: ' + responseId);
    const deleted = callSlackApi_(config, 'chat.delete', { channel: channelId, ts: messageTs });
    if (!deleted.ok) console.error('ナイスチャレンジの親の投稿を削除できませんでした: ' + deleted.error);
    if (authorId) {
      sendDirectMessage_(config, authorId,
        ':warning: ナイスチャレンジを投稿できませんでした。運営へ連絡してください。');
    }
    return;
  }

  const row = recordVizPost_(logSheet, authorId, text, channelId, messageTs, responseId, bodyTs);

  // 回答を残すのは、本人へ編集用URLを渡せるときだけ。渡せないなら、直す手段がないので消す。
  // ログに書けなかったとき（row が 0）は、編集も期限切れの削除もできなくなるので、同じくすぐ消す
  if (authorId && settings.retentionDays > 0 && row) {
    notifyVizAuthor_(config, authorId, formResponse, settings.retentionDays);
    return;
  }
  if (deleteVizResponse_(e.source, responseId) && row) {
    logSheet.getRange(row, VIZ_LOG_COL.RESPONSE_DELETED_AT + 1).setValue(new Date());
  }
}

/** 投稿者へ、投稿できたことと回答の編集用URLをDMで知らせる */
function notifyVizAuthor_(config, authorId, formResponse, retentionDays) {
  const until = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000);
  sendDirectMessage_(config, authorId,
    'ナイスチャレンジを投稿しました :white_check_mark:\n' +
    '内容を直したいときは、' + Utilities.formatDate(until, 'Asia/Tokyo', 'M/d') + ' ごろまでなら、' +
    '次のURLから回答を編集すると投稿も更新されます（このURLは他の人に共有しないでください）。\n' +
    formResponse.getEditResponseUrl());
}

/** 編集された回答の内容で、投稿済みのSlackメッセージを書き換える */
function updateVizPost_(config, logSheet, answers, posted) {
  // 投稿者のメンションは、ログに残っているSlack IDで作り直す（本人不明なら「メンバー」）
  const authorId = posted.author === VIZ_AUTHOR_UNKNOWN ? '' : posted.author;
  const body = buildVizPostText_(answers, authorId, config.masterUserIds);
  // 本文の返信IDが無い行は、本文を親の投稿に載せていた頃のもの。その形のまま親を書き換える
  const text = posted.bodyTs ? body : buildVizLegacyPostText_(body, authorId);
  const json = callSlackApi_(config, 'chat.update', {
    channel: posted.channel, ts: posted.bodyTs || posted.messageTs, text: text
  });
  if (!json.ok) {
    console.error('ナイスチャレンジの投稿を更新できませんでした: ' + json.error);
    if (authorId) {
      sendDirectMessage_(config, authorId,
        ':warning: 回答の修正を投稿に反映できませんでした。運営へ連絡してください。');
    }
    return;
  }
  logSheet.getRange(posted.rowNumber, VIZ_LOG_COL.TEXT + 1).setValue(truncateForLog_(body));

  // 親の投稿にも概要と対象を載せているので、そちらも直す（旧形式の投稿は、上で親を書き換え済み）
  if (!posted.bodyTs) return;
  const parent = callSlackApi_(config, 'chat.update', {
    channel: posted.channel, ts: posted.messageTs, text: buildVizParentText_(authorId, answers)
  });
  if (!parent.ok) {
    console.error('ナイスチャレンジの親の投稿を更新できませんでした: ' + parent.error);
    if (authorId) {
      sendDirectMessage_(config, authorId,
        ':warning: 回答の修正を投稿の見出しに反映できませんでした。運営へ連絡してください。');
    }
  }
}

/**
 * 親の投稿の本文。見出し・概要と対象（VIZ_PARENT_FIELDS。回答があるものだけ）・内容はスレッドにある旨の案内
 * @param {string} authorId 投稿者のSlackユーザーID（特定できなければ空文字）
 * @param {Object} answers 設問名 → 回答
 */
function buildVizParentText_(authorId, answers) {
  const author = authorId ? '<@' + authorId + '>' : 'メンバー';
  const lines = [VIZ_POST_HEADER.split('{author}').join(author)];
  VIZ_PARENT_FIELDS.forEach(function (field) {
    const answer = answers && answers[field.question];
    if (answer) lines.push(field.label + ': ' + escapeSlackText_(answer));
  });
  lines.push(VIZ_POST_THREAD_LINE);
  return lines.join('\n');
}

/**
 * スレッド内の本文。各設問（VIZ_POST_FIELDS の順）・師匠へのメンションをつなぐ。
 * 回答が空の設問は載せない。VIZ_POST_FIELDS に無い設問は、回答があれば設問名のまま末尾に足す
 * （フォームに設問を足したときに、回答が黙って投稿から消えないようにするため）。
 * @param {Object} answers 設問名 → 回答（フォームの並び順）
 */
function buildVizPostText_(answers, authorId, masterIds) {
  const lines = [];

  const fixed = {};
  VIZ_POST_FIELDS.forEach(function (field) {
    fixed[field.question] = true;
    const answer = answers[field.question];
    if (!answer) return;
    lines.push('*' + escapeSlackText_(field.label) + '*\n' + escapeSlackText_(answer));
  });
  Object.keys(answers).forEach(function (question) {
    if (fixed[question] || !answers[question]) return;
    lines.push('*' + escapeSlackText_(question) + '*\n' + escapeSlackText_(answers[question]));
  });

  // 投稿者本人が師匠のときは、自分へのメンションは付けない
  const mentions = (masterIds || []).filter(function (id) { return id !== authorId; });
  if (mentions.length > 0) {
    lines.push(VIZ_POST_MASTER_LINE.split('{masters}').join(mentions.map(function (id) {
      return '<@' + id + '>';
    }).join(' ')));
  }
  // Slack は空の本文を受け付けない
  if (lines.length === 0) lines.push('（回答の内容がありませんでした）');
  return lines.join('\n\n');
}

/** 本文を親の投稿に載せていた頃の形（見出し + 本文 + 末尾の文）。その頃の投稿を編集で書き換えるときだけ使う */
function buildVizLegacyPostText_(body, authorId) {
  const author = authorId ? '<@' + authorId + '>' : 'メンバー';
  return [VIZ_POST_HEADER.split('{author}').join(author), body, VIZ_POST_LEGACY_FOOTER].join('\n\n');
}

function postVizMessage_(config, channelId, settings, text, threadTs) {
  const payload = { channel: channelId, text: text };
  if (threadTs) payload.thread_ts = threadTs;
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
    // 回答シートに紐づいていると、フォームの回答を消してもシート側の行が残る
    if (form.getDestinationType() === FormApp.DestinationType.SPREADSHEET) {
      console.warn('このフォームは回答シートに紐づいています。回答がシートに残るため、' +
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
function recordVizPost_(sheet, authorId, text, channelId, messageTs, responseId, bodyTs) {
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
      truncateForLog_(text), channelId, "'" + messageTs, responseId, '', "'" + bodyTs
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
      messageTs: String(values[i][VIZ_LOG_COL.MESSAGE_TS]),
      bodyTs: String(values[i][VIZ_LOG_COL.BODY_TS] || '')
    };
  }
  return null;
}

/**
 * ナイスチャレンジ投稿ログから、投稿のtsで投稿を探す。無ければ null。
 * 親の投稿と本文の返信のどちらのtsでも探せる（スタンプは、どちらにも付く）。messageTs は常に親の投稿のts
 */
function findVizPostByTs_(spreadsheet, messageTs) {
  const sheet = spreadsheet.getSheetByName(SHEET_VIZ_LOG);
  if (!sheet) return null;
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    const bodyTs = String(values[i][VIZ_LOG_COL.BODY_TS] || '');
    if (String(values[i][VIZ_LOG_COL.MESSAGE_TS]) !== messageTs && (!bodyTs || bodyTs !== messageTs)) continue;
    return { author: String(values[i][VIZ_LOG_COL.AUTHOR]), messageTs: String(values[i][VIZ_LOG_COL.MESSAGE_TS]) };
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
  // 本文の返信に付いたスタンプも、親の投稿のものとして数える
  const postTs = post.messageTs;
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
      setVizReviewPostFormulas_(sheet, sheet.getLastRow());
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
 * Viz投稿のスレッドへの返信（message イベント）を記録する。本文は「返信内容」に保存する。
 * 返信が削除されたとき（message_deleted）は、削除日時を埋めて本文を消す。
 * 返信が編集されたとき（message_changed）は、本文を更新する。
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
  if (event.subtype === 'message_changed') {
    handleVizReplyEdited_(config, event);
    return;
  }
  // Botの投稿などは対象外。通常の返信と「チャンネルにも投稿」だけ拾う
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
      "'" + postTs, '', "'" + replyTs, '', '', toVizReplyCell_(event.text)
    ]);
    setVizReviewPostFormulas_(sheet, sheet.getLastRow());
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
      // 消された返信の本文は残さない（行は、返信数の集計のために残す）
      sheet.getRange(r.rowNumber, VIZ_REVIEW_COL.REPLY_TEXT + 1).clearContent();
      if (r.removed) return;
      sheet.getRange(r.rowNumber, VIZ_REVIEW_COL.REMOVED_AT + 1).setValue(deletedAt);
    });
  } finally {
    lock.releaseLock();
  }
}

/**
 * 返信が編集されたとき、記録済みの返信の本文を更新する。記録の無い返信（本人の返信・
 * ナイスチャレンジ以外のチャンネル・記録前の返信）は何もしない。
 * リンクの展開などでSlackが自動で編集扱いにしたときも届くが、本文は同じなので結果は変わらない。
 */
function handleVizReplyEdited_(config, event) {
  const message = event.message || {};
  if (!message.ts || !message.thread_ts || message.thread_ts === message.ts) return;
  if (message.bot_id || !message.user) return;
  const vizChannel = getVizChannelId_(config);
  if (!vizChannel || vizChannel !== event.channel) return;

  const spreadsheet = SpreadsheetApp.openById(config.managementSpreadsheetId);
  const sheet = spreadsheet.getSheetByName(SHEET_VIZ_REVIEW_LOG);
  if (!sheet) return;
  const replyTs = String(message.ts);
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (err) {
    console.warn('ナイスチャレンジレビューログのロック取得に失敗しました: 返信の編集 ' + replyTs);
    return;
  }
  try {
    findVizReviewRows_(sheet, function (row) {
      return row[VIZ_REVIEW_COL.KIND] === VIZ_KIND_REPLY && String(row[VIZ_REVIEW_COL.REPLY_TS]) === replyTs;
    }).forEach(function (r) {
      if (r.removed) return;   // 消された返信の本文は書き戻さない
      sheet.getRange(r.rowNumber, VIZ_REVIEW_COL.REPLY_TEXT + 1).setValue(toVizReplyCell_(message.text));
    });
  } finally {
    lock.releaseLock();
  }
}

/**
 * 返信の本文を、セルに書ける形にする。
 * Slackが &, <, > を &amp; &lt; &gt; にしているので元に戻す。他人の書いた文字列なので、
 * = + - @ で始まるものは数式として実行されないよう、アポストロフィで文字列にする
 * （=IMPORTDATA(…) などで、シートの内容を外へ送らせないため）。
 */
function toVizReplyCell_(text) {
  const plain = String(text || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const limited = truncateForLog_(plain);
  return /^[=+\-@]/.test(limited) ? "'" + limited : limited;
}

/** 列の位置（0始まり）をスプレッドシートの列の文字（A, B, …）にする。26列までを想定 */
function sheetColumnLetter_(index) {
  return String.fromCharCode(65 + index);
}

/** レビューログの1行ぶんの、「投稿者」「投稿内容」を投稿ログから引く数式 */
function vizReviewPostFormulas_(row) {
  const log = "'" + SHEET_VIZ_LOG + "'!";
  const column = function (index) {
    const letter = sheetColumnLetter_(index);
    return log + '$' + letter + '$2:$' + letter;
  };
  const find = 'MATCH($' + sheetColumnLetter_(VIZ_REVIEW_COL.POST_TS) + row + ',' +
    column(VIZ_LOG_COL.MESSAGE_TS) + ',0)';
  return [
    '=IFERROR(INDEX(' + column(VIZ_LOG_COL.AUTHOR) + ',' + find + '),"")',
    '=IFERROR(INDEX(' + column(VIZ_LOG_COL.TEXT) + ',' + find + '),"")'
  ];
}

/** 追加した行に、「投稿者」「投稿内容」の数式を入れる */
function setVizReviewPostFormulas_(sheet, row) {
  sheet.getRange(row, VIZ_REVIEW_COL.POST_AUTHOR + 1, 1, 2).setFormulas([vizReviewPostFormulas_(row)]);
}

/** すでにある行にも、「投稿者」「投稿内容」の数式を入れる（何度実行しても同じ） */
function backfillVizReviewPostFormulas_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return;
  const formulas = [];
  for (let row = 2; row <= last; row++) formulas.push(vizReviewPostFormulas_(row));
  sheet.getRange(2, VIZ_REVIEW_COL.POST_AUTHOR + 1, last - 1, 2).setFormulas(formulas);
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
    authorQuestion: raw.AUTHOR_QUESTION || VIZ_FORM_TITLES.AUTHOR,
    roomFormat: raw.ROOM_FORMAT || (VIZ_PLACEHOLDER_MASTER + '部屋'),
    channelUrl: raw.CHANNEL_URL,
    faqUrl: raw.FAQ_URL,
    formDescription: raw.FORM_DESCRIPTION,
    sectionDescription: raw.SECTION_DESCRIPTION,
    // 数字でない・範囲外の値は0（すぐ削除）に倒す。回答を残す側には倒さない
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
 * フォームIDが変わったら、送信トリガーをその場で追随させる。
 */
function syncVizSettings_(spreadsheet) {
  const config = getConfig_();
  CacheService.getScriptCache().remove(VIZ_CHANNEL_CACHE_KEY);
  const settings = readVizSettings_(spreadsheet);
  let message;
  try {
    message = syncVizFormTrigger_(config, settings);
    applyVizFormSettings_(settings);
    refreshVizPrefill_(settings);
    applyVizFormTexts_(settings);
    syncVizRoomChoices_(spreadsheet, settings);
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

/** 初回セットアップ・setupTriggers から呼ぶ。シートを整え、送信トリガーとフォームの表示を設定に合わせる */
function setupVizReview_(config) {
  const spreadsheet = SpreadsheetApp.openById(config.managementSpreadsheetId);
  ensureVizSettingRows_(getOrCreateSheet_(spreadsheet, SHEET_VIZ_SETTINGS, VIZ_SETTINGS_HEADER));
  const log = getOrCreateSheet_(spreadsheet, SHEET_VIZ_LOG, VIZ_LOG_HEADER);
  ensureHeader_(log, VIZ_LOG_HEADER);
  protectSystemSheet_(log);
  const review = getOrCreateSheet_(spreadsheet, SHEET_VIZ_REVIEW_LOG, VIZ_REVIEW_HEADER);
  ensureHeader_(review, VIZ_REVIEW_HEADER);
  backfillVizReviewPostFormulas_(review);   // 追加した列に、これまでの行ぶんも数式を入れる
  protectSystemSheet_(review);

  const settings = readVizSettings_(spreadsheet);
  // フォームIDが誤っていても、ここで例外を出して setupTriggers() ごと止めない（既存の機能のセットアップを巻き込まない）
  try {
    syncVizFormTrigger_(config, settings);
    applyVizFormSettings_(settings);
    refreshVizPrefill_(settings);
    applyVizFormTexts_(settings);
    syncVizRoomChoices_(spreadsheet, settings);
  } catch (err) {
    console.warn('ナイスチャレンジのフォームを設定へ反映できませんでした: ' + err);
  }
}

// ==================== フォームの説明文・所属部屋の選択肢 ====================

/** 説明文の {ナイスチャレンジ} {よくある質問} を、設定のリンク（無ければ名前）に置き換える */
function renderVizDescription_(template, settings) {
  return String(template)
    .split(VIZ_PLACEHOLDER_CHANNEL).join(settings.channelUrl || 'ナイスチャレンジのチャンネル')
    .split(VIZ_PLACEHOLDER_FAQ).join(settings.faqUrl || 'よくある質問のチャンネル');
}

/**
 * 設定シートの説明文（冒頭・2ページ目）を、フォームへ書き込む。
 * 説明文が空欄なら、フォーム側の説明には触らない（既存のフォームを手で整えている場合のため）。
 * 2ページ目の説明は、セクション「VIZ_FORM_TITLES.SECTION」があるときだけ。
 */
function applyVizFormTexts_(settings) {
  if (!settings || !settings.formId) return;
  const form = FormApp.openById(settings.formId);
  if (settings.formDescription) {
    form.setDescription(renderVizDescription_(settings.formDescription, settings));
  }
  if (settings.sectionDescription) {
    const section = findFormItemByTitle_(form, VIZ_FORM_TITLES.SECTION);
    if (section && section.getType() === FormApp.ItemType.PAGE_BREAK) {
      section.asPageBreakItem().setHelpText(renderVizDescription_(settings.sectionDescription, settings));
    }
  }
}

/** 「師匠リスト」の有効な行の表示名から、所属部屋の選択肢（並びは師匠リストのまま）を作る */
function readVizRoomChoices_(spreadsheet, settings) {
  const sheet = spreadsheet.getSheetByName(SHEET_MASTER_LIST);
  if (!sheet) return [];
  const format = (settings && settings.roomFormat) || (VIZ_PLACEHOLDER_MASTER + '部屋');
  const values = sheet.getDataRange().getValues();
  const choices = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (!isEnabledFlag_(row[MASTER_LIST_COL.ENABLED])) continue;
    const name = String(row[MASTER_LIST_COL.NAME] || '').trim();
    if (!name) continue;
    const label = format.split(VIZ_PLACEHOLDER_MASTER).join(name);
    if (choices.indexOf(label) === -1) choices.push(label);
  }
  return choices;
}

/**
 * フォームの「所属部屋」（プルダウン）の選択肢を、「師匠リスト」に合わせる。
 * 師匠が0人のときは選択肢を変えない（FormApp は空の選択肢を受け付けないため）。
 * 設問がない（運営が作ったフォーム等）ときも何もしない。
 * @return {{count: number, applied: boolean}} count は選択肢の数、applied は反映できたか
 */
function syncVizRoomChoices_(spreadsheet, settings) {
  const choices = readVizRoomChoices_(spreadsheet, settings);
  const result = { count: choices.length, applied: false };
  if (!settings || !settings.formId || choices.length === 0) return result;
  const form = FormApp.openById(settings.formId);
  const item = findFormItemByTitle_(form, VIZ_FORM_TITLES.ROOM);
  if (!item || item.getType() !== FormApp.ItemType.LIST) return result;
  item.asListItem().setChoiceValues(choices);
  result.applied = true;
  return result;
}

/**
 * 「師匠リスト」を編集したとき（編集トリガーから呼ばれる）の、所属部屋の選択肢の反映。
 * ナイスチャレンジのフォームが未設定のときは、何も出さない（師匠リストの編集のたびに
 * 関係のないトーストを出さないため）。失敗しても師匠リストの反映は止めない。
 */
function syncVizRoomsFromSheet_(spreadsheet) {
  try {
    const settings = readVizSettings_(spreadsheet);
    if (!settings || !settings.formId) return;
    const result = syncVizRoomChoices_(spreadsheet, settings);
    if (result.applied) {
      spreadsheet.toast('所属部屋 ' + result.count + '件をフォームへ反映しました', SHEET_VIZ_SETTINGS, 8);
    } else if (result.count === 0) {
      spreadsheet.toast('師匠リストに表示名がある有効な行が無いため、所属部屋の選択肢は変えていません',
        SHEET_VIZ_SETTINGS, 8);
    }
  } catch (err) {
    console.warn('所属部屋の選択肢を反映できませんでした: ' + err);
  }
}

// ==================== スラッシュコマンド用の事前入力 ====================

// スラッシュコマンドはSlackの3秒ルールの対象で、FormApp.openById() は約1秒かかる。
// 応答経路では使わないため、フォームIDと「投稿者のSlackユーザーID」設問のエントリIDを
// ここで調べてスクリプトプロパティへ写しておく（シートの読み取りも応答経路に入れないため）。
const VIZ_PROP_FORM_ID = 'VIZ_FORM_ID';
const VIZ_PROP_ENTRY_AUTHOR = 'VIZ_FORM_ENTRY_AUTHOR';

/**
 * 設定のフォームIDと、投稿者IDの設問のエントリIDをスクリプトプロパティへ写す。
 * フォームIDが空なら消す（コマンドは「準備中」と返す）。設定の編集トリガーとセットアップから呼ぶ
 */
function refreshVizPrefill_(settings) {
  const props = PropertiesService.getScriptProperties();
  if (!settings || !settings.formId) {
    props.deleteProperty(VIZ_PROP_FORM_ID);
    props.deleteProperty(VIZ_PROP_ENTRY_AUTHOR);
    return;
  }
  const entryId = extractVizPrefillEntryId_(settings.formId, settings.authorQuestion);
  const values = {};
  values[VIZ_PROP_FORM_ID] = settings.formId;
  values[VIZ_PROP_ENTRY_AUTHOR] = entryId;
  props.setProperties(values);
  if (!entryId) {
    console.warn('フォームに設問「' + settings.authorQuestion + '」が見つかりません。' +
      'コマンドで開くフォームにIDは入りません');
  }
}

/**
 * 目印の値を入れた事前入力URLを1回生成し、entry.XXXXX=目印 を逆引きしてエントリIDを特定する
 * （FormApp の item.getId() は事前入力URLのエントリIDとは別物）。見つからなければ空文字。
 */
function extractVizPrefillEntryId_(formId, questionTitle) {
  // 設問の形式チェック（U/W始まりの英数字）に通る値にする。通らない値だと createResponse が弾く恐れがある
  const MARKER = 'UVIZAUTHOR0';
  const form = FormApp.openById(formId);
  const response = form.createResponse();
  let found = false;
  form.getItems().forEach(function (item) {
    if (item.getTitle() === questionTitle && item.getType() === FormApp.ItemType.TEXT) {
      response.withItemResponse(item.asTextItem().createResponse(MARKER));
      found = true;
    }
  });
  if (!found) return '';
  const query = String(response.toPrefilledUrl()).split('?')[1] || '';
  const pairs = query.split('&');
  for (let i = 0; i < pairs.length; i++) {
    const eq = pairs[i].indexOf('=');
    if (eq === -1) continue;
    const key = pairs[i].slice(0, eq);
    const value = decodeURIComponent(pairs[i].slice(eq + 1).replace(/\+/g, ' '));
    if (key.indexOf('entry.') === 0 && value === MARKER) return key.replace('entry.', '');
  }
  return '';
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
    { title: VIZ_FORM_TITLES.AUTHOR, type: 'TEXT', required: true },
    // 選択肢は「師匠リスト」シートが正。師匠の表示名が入るまでは、この1つだけが並ぶ
    { title: VIZ_FORM_TITLES.ROOM, type: 'LIST', required: true,
      help: 'あなたの所属する部屋を選択してください。投稿は師匠にもメンションされます。',
      choices: ['（「' + SHEET_MASTER_LIST + '」シートに師匠の表示名を入れてください）'] },
    { title: VIZ_FORM_TITLES.SECTION, type: 'PAGE_BREAK' },
    { title: VIZ_FORM_TITLES.SUMMARY, type: 'TEXT', required: true,
      help: '（記入例）新人向けの売上ダッシュボードを作りました。チャンネルの投稿に載ります。' },
    { title: VIZ_FORM_TITLES.LINK, type: 'TEXT', required: true },
    { title: VIZ_FORM_TITLES.TARGET, type: 'LIST', required: true, choices: [
      'パブリック Tableau PublicへのViz投稿',
      'パブリック Tableau Community Forumsでの質問回答',
      'パブリック Tableau関連のブログ記事の投稿',
      'パブリック Tableauユーザー会の開催',
      'パブリック Tableau関連の講演',
      '組織内 イベント開催',
      '組織内 Doctor開催',
      '組織内 オンラインコミュニティ運営',
      '組織内 Viz共有',
      '組織内 情報共有',
      '組織内 分析案件実施',
      'その他'
    ] },
    { title: VIZ_FORM_TITLES.STATE, type: 'MULTIPLE_CHOICE', required: true, choices: [
      'アイデア出し中', 'ドラフト作成中', '師匠レビュー依頼中', '師匠レビュー完了'
    ] },
    { title: VIZ_FORM_TITLES.WANT, type: 'MULTIPLE_CHOICE', required: true, choices: [
      'ざっくり（方向性・イメージ）', 'しっかり（内容・構成）', 'ことば（表現チェック）',
      'みため（体裁・デザイン）', '応用（発展アイデア・スキル）', '比較（他成果物の参考）'
    ] },
    { title: VIZ_FORM_TITLES.CONSULT, type: 'TEXT', required: false,
      help: '（記入例）投稿するVizをもう少し改善したいのでアドバイスが欲しい' }
  ];
}

/** ナイスチャレンジ用フォームを新規作成してIDを返す（マイドライブ直下にできる） */
function createVizForm_() {
  const form = FormApp.create(RESOURCE_NAMES.VIZ_FORM);
  form.setTitle(FORM_DISPLAY_TITLES.VIZ);
  form.setCollectEmail(false);            // メールアドレスは集めない（個人情報を持たない）
  form.setAllowResponseEdits(true);       // 期間中は、編集用URLから回答を直すと投稿も直る
  form.setLimitOneResponsePerUser(false); // 何作品でも依頼できるように
  // 全員に同じ文言が出る。IDの打ち間違いは投稿されないことで気づいてもらうので、その案内を書いておく
  form.setConfirmationMessage('回答を記録しました。ナイスチャレンジの投稿先チャンネルに投稿されない場合は、' +
    '「' + VIZ_FORM_TITLES.AUTHOR + '」の入力を確認して、もう一度送信してください。');
  vizFormSpec_().forEach(function (spec) { addFormItem_(form, spec); });
  const author = findFormItemByTitle_(form, VIZ_FORM_TITLES.AUTHOR).asTextItem();
  author.setHelpText('Slackで ' + VIZ_SLASH_COMMAND + ' と打つと、この欄が入力済みのフォームが開けます。' +
    '手で入れるときは、Slackのプロフィール →「︙」→「メンバーIDをコピー」で調べられます（U から始まる文字列）。' +
    '投稿者の特定にだけ使い、投稿には載せません。');
  author.setValidation(FormApp.createTextValidation()
    .requireTextMatchesPattern('^[UW][A-Z0-9]{4,}$').build());
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
  setupVizReview_(config); // 送信トリガーなどを、できたフォームに合わせる
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
