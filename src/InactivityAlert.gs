/**
 * InactivityAlert.gs
 * 弟子の離脱アラート。師匠ごとに決めた公開チャンネルで、参加している人のうち
 * 「指定した日数以上、投稿もスレッド返信もスタンプもない人」を、師匠へDMで知らせる。
 *
 * 設定は「離脱アラート設定」シート（管理用①）。毎日1回、時間トリガーが判定する。
 *
 * ★ 「活動あり」に数えるもの ★
 *   チャンネルへの投稿 / スレッドへの返信 / 投稿へのスタンプ
 * スタンプは「いつ押したか」をSlackが返さない。そのため「直近の日数以内に投稿された
 * メッセージに押したスタンプ」だけを数える。古い投稿へ押したスタンプは見えないので、
 * 通知がやや多めに出ることはあっても、見逃すことはない（取りこぼす向きが安全側）。
 * 同じ理由で、直近の日数より古いスレッドに付いた返信も見えない。
 *
 * ★ 部分的な結果では通知しない ★
 * 履歴の取得が途中で失敗した状態で判定すると、取れなかった分の人が全員
 * 「投稿なし」に見えてしまう。失敗した設定行は、通知せずに飛ばしてログに残す。
 */

/**
 * この機能のトリガーとシートだけを用意する。GASエディタから1度手動実行する。
 *
 * setupTriggers() を使わないのは、あちらはナイスチャレンジのフォーム説明文など
 * 手で直した箇所まで上書きするため。ここは離脱アラートの分しか触らない。
 * 何度実行しても、トリガーは1つしか残らない。
 */
function setupInactivityAlert() {
  const config = getConfig_();
  const spreadsheet = SpreadsheetApp.openById(config.managementSpreadsheetId);
  const sheet = getOrCreateSheet_(spreadsheet, SHEET_INACTIVITY_ALERT, INACTIVITY_HEADER);
  setupInactivityAlertSheet_(sheet);

  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'checkInactiveDisciples') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  ScriptApp.newTrigger('checkInactiveDisciples')
    .timeBased()
    .everyDays(1)
    .atHour(INACTIVITY_CHECK_HOUR)
    .create();
  console.log('離脱アラートを設定しました: 毎日' + INACTIVITY_CHECK_HOUR + '時台に判定します');
}

/**
 * 設定シートの見た目を整える。設定行のセルには書き込まない。
 * 右側の説明は表の外（J列〜）に置くので、設定の読み取りには影響しない。
 */
function setupInactivityAlertSheet_(sheet) {
  // 見出しの文言を変えたときに、稼働中のシートへ追随させる（ここは実行すると見出しを書き直す）
  ensureHeader_(sheet, INACTIVITY_HEADER);
  setupInactivityDropdowns_(sheet);

  const notes = [
    '通知を受け取る師匠のSlackユーザーID（U…）。<@U123> の形で貼ってもOK。必須',
    '誰の行か分かるためのメモ。処理には使いません',
    'チェックするチャンネル名（#なし）またはチャンネルID。公開チャンネルのみ。Botがそのチャンネルに参加している必要があります。必須',
    '「この日数以上、投稿・スレッド返信・スタンプがない人」を知らせます。例: 14。1以上の整数。必須',
    '「毎日」か「毎週月曜」を選びます。空欄なら日数で自動に決まります（' + INACTIVITY_WEEKLY_MIN_DAYS + '日以上は毎週月曜、未満は毎日）。毎週月曜は月曜の時点だけを見るので、日数が短いと週の途中の空白は拾えません',
    '通知に出したくない人（完全に離脱した人など）。通知に出た名前をそのまま書けます。SlackユーザーIDでもOK。複数はカンマか改行で区切ります。師匠本人とBotは自動で外れるので書かなくてOK',
    '「無効」にすると、この行の通知を止めます。空欄は有効',
    '自由記入。処理には使いません'
  ];
  notes.forEach(function (note, i) { sheet.getRange(1, i + 1).setNote(note); });

  // 設定のしかた。表（A〜H列）の右に常時表示する。ここの文字は処理に使わない
  const guide = [
    ['■ 設定のしかた'],
    ['1行 ＝ 師匠1人 × チェックするチャンネル1つ。チャンネルを増やすときは行を足します'],
    ['必須は「師匠のSlackユーザーID」「対象チャンネル」「日数」の3つ。他は空欄でOK'],
    ['日数が過ぎても、投稿・スレッド返信・スタンプのどれもない人が、師匠にDMで届きます'],
    ['通知頻度: 「毎日」は毎朝、「毎週月曜」は月曜の朝だけ判定してDMします（月曜以外は何も届きません）'],
    ['判定は毎朝' + INACTIVITY_CHECK_HOUR + '時台。該当者がいない日は何も届きません'],
    ['対象は、そのチャンネルに参加している人（師匠本人・Bot・退会した人は除く）'],
    ['完全に離脱した人は、通知に出た名前を「除外する人」へそのまま書くと、以降は通知に出ません'],
    ['Botがチャンネルに入っていないと読めません。その場合は師匠にその旨のDMが届きます'],
    ['スタンプは、日数以内に投稿されたメッセージへのものだけ数えます（押した日時が取れないため）'],
    ['※ この説明は処理に使われません。消してもかまいません']
  ];
  sheet.getRange(1, INACTIVITY_GUIDE_COLUMN, guide.length, 1).setValues(guide);
  sheet.getRange(1, INACTIVITY_GUIDE_COLUMN).setFontWeight('bold');
  sheet.setColumnWidth(INACTIVITY_GUIDE_COLUMN, 560);
}

/**
 * 「有効」列と「通知頻度」列のドロップダウン。行を足したときにも効くよう、編集のたびに貼り直す。
 * 説明文は書き換えない（運営が手を入れていることがあるため）
 */
function setupInactivityDropdowns_(sheet) {
  setupEnabledColumn_(sheet, INACTIVITY_COL.ENABLED);
  const lastRow = Math.max(sheet.getLastRow(), 2);
  sheet.getRange(2, INACTIVITY_COL.FREQUENCY + 1, lastRow, 1).setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInList(INACTIVITY_FREQUENCIES, true)
      .setAllowInvalid(false)
      .build());
}

/** 毎日の判定（時間トリガーのエントリポイント）。設定行が無ければ何もしない */
function checkInactiveDisciples() {
  runInactivityCheck_(false);
}

/**
 * 動作確認用。「通知頻度」を無視して、今すぐ全ての有効な行を判定して通知する。
 * 「毎週月曜」の行も月曜を待たずに試せる。GASエディタから手動で実行する。
 * 時間トリガーには登録しない（トリガーは実行時に引数を渡すため、頻度を無視する指定を
 * 取り違えかねない。入口を分けているのはそのため）。
 * 該当者がいない行にも「いません」と返すので、動いているかをその場で確かめられる
 */
function checkInactiveDisciplesNow() {
  runInactivityCheck_(true);
}

function runInactivityCheck_(ignoreFrequency) {
  const config = getConfig_();
  const spreadsheet = SpreadsheetApp.openById(config.managementSpreadsheetId);
  const sheet = spreadsheet.getSheetByName(SHEET_INACTIVITY_ALERT);
  if (!sheet || sheet.getLastRow() < 2) return;

  const parsed = parseInactivityRules_(
    sheet.getRange(2, 1, sheet.getLastRow() - 1, INACTIVITY_HEADER.length).getValues());
  parsed.problems.forEach(function (problem) {
    console.warn('離脱アラート設定の ' + problem);
  });

  // 通知の案内から、設定シートを直接開けるようにする
  const sheetUrl = 'https://docs.google.com/spreadsheets/d/' + config.managementSpreadsheetId +
    '/edit#gid=' + sheet.getSheetId();

  const now = new Date();
  const dueRules = parsed.rules.filter(function (rule) {
    return ignoreFrequency || isInactivityRuleDue_(rule.frequency, now);
  });
  if (dueRules.length === 0) return;

  // 人間のメンバー一覧（Bot・退会済みを除く）。ルールをまたいで1回だけ取る。
  // 判定の対象を絞るほか、通知に出す表示名と、設定シートの表示名の照合にも使う
  const members = listSlackMembers_(config);

  dueRules.forEach(function (rule) {
    try {
      runInactivityRule_(config, rule, members, now, ignoreFrequency, sheetUrl);
    } catch (err) {
      // 1行の失敗で他の師匠の通知を止めない
      console.error('離脱アラートに失敗しました（' + rule.channel + ' / ' + rule.masterId + '）: ' + err);
    }
  });
}

/**
 * 1行ぶんの判定と通知。
 * @param {string} sheetUrl 通知の案内に載せる、設定シートのURL（省略可）
 * @param {boolean} manual 手動実行か。手動のときだけ、該当者がいなくても「いません」と返す
 *   （動いているのかを確かめるため。毎朝の自動実行は、該当者がいなければ何も送らない）
 */
function runInactivityRule_(config, rule, members, now, manual, sheetUrl) {
  const masterId = rule.masterId;
  const excludeIds = [masterId];
  rule.excludeTokens.forEach(function (token) {
    const person = resolveSlackPerson_(token, members);
    if (person.id) {
      excludeIds.push(person.id);
    } else {
      console.warn('離脱アラート: 除外する人「' + token + '」を特定できないため、除外していません（' +
        person.reason + '）。SlackユーザーIDで書いてください');
    }
  });

  const channelId = resolveChannelId_(config, rule.channel);
  if (!channelId) {
    notifyInactivityProblem_(config, rule, masterId,
      'チャンネル「' + rule.channel + '」が見つかりません（公開チャンネルの名前かIDを確認してください）');
    return;
  }

  const memberIds = listChannelMemberIds_(config, channelId);
  if (memberIds === null) {
    notifyInactivityProblem_(config, rule, masterId, 'チャンネルの参加者を取得できませんでした');
    return;
  }
  const messages = listRecentChannelMessages_(config, channelId, rule.days, now);
  if (messages === null) {
    notifyInactivityProblem_(config, rule, masterId,
      'チャンネルの投稿を読めませんでした（Botをそのチャンネルに追加してください）');
    return;
  }

  const humanIds = members.map(function (member) { return member.id; });
  const inactive = findInactiveMembers_(
    memberIds, humanIds, collectActiveUserIds_(messages), excludeIds);
  const since = new Date(now.getTime() - rule.days * 86400000);
  if (inactive.length === 0) {
    if (manual) {
      sendDirectMessage_(config, masterId, buildInactivityMessage_(channelId, rule.days, [], since));
    }
    return;
  }
  const nameById = {};
  members.forEach(function (member) { nameById[member.id] = member.name; });
  const names = inactive.map(function (id) { return nameById[id] || id; });
  sendDirectMessage_(config, masterId, buildInactivityMessage_(channelId, rule.days, names, since, sheetUrl));
}

/** 読めなかった理由を、その行の師匠へ知らせる。黙って通知が止まるのを防ぐため */
function notifyInactivityProblem_(config, rule, masterId, reason) {
  console.error('離脱アラート: ' + reason + ' / ' + masterId);
  sendDirectMessage_(config, masterId,
    ':x: 離脱アラートを実行できませんでした（対象: ' + rule.channel + '）\n' + reason);
}

/**
 * 設定シートの行を読み、通知する設定（rules）と、読めなかった行の理由（problems）に分ける。
 * 空行・「無効」の行は黙って飛ばす。
 * @param {Array[]} values 見出しを除いたデータ行
 */
function parseInactivityRules_(values) {
  const rules = [];
  const problems = [];
  values.forEach(function (row, i) {
    const line = (i + 2) + '行目';
    const masterRaw = String(row[INACTIVITY_COL.MASTER_ID] || '').trim();
    const channel = String(row[INACTIVITY_COL.CHANNEL] || '').trim().replace(/^#/, '');
    const daysRaw = row[INACTIVITY_COL.DAYS];
    if (masterRaw === '' && channel === '' && String(daysRaw).trim() === '') return;
    if (classifyEnabledFlag_(row[INACTIVITY_COL.ENABLED]) === 'disabled') return;

    const masterId = normalizeSlackUserId_(masterRaw);
    if (!isValidSlackUserId_(masterId)) {
      problems.push(line + ': 師匠のSlackユーザーIDが正しくありません（「' + masterRaw + '」）。この行は飛ばしました');
      return;
    }
    if (channel === '') {
      problems.push(line + ': 対象チャンネルが空です。この行は飛ばしました');
      return;
    }
    const days = Number(daysRaw);
    if (!Number.isInteger(days) || days < 1) {
      problems.push(line + ': 日数は1以上の整数で入力してください（「' + daysRaw + '」）。この行は飛ばしました');
      return;
    }
    // 空欄は日数で決める。選んであればその値を優先する
    const frequency = String(row[INACTIVITY_COL.FREQUENCY] || '').trim() ||
      (days >= INACTIVITY_WEEKLY_MIN_DAYS ? '毎週月曜' : '毎日');
    if (INACTIVITY_FREQUENCIES.indexOf(frequency) === -1) {
      problems.push(line + ': 通知頻度は「' + INACTIVITY_FREQUENCIES.join('」「') +
        '」から選んでください（「' + frequency + '」）。この行は飛ばしました');
      return;
    }
    // 表示名には空白が入りうるので、区切りはカンマと改行だけにする。
    // IDか表示名かの判定は、メンバー一覧と突き合わせる実行時に行う
    const excludeTokens = String(row[INACTIVITY_COL.EXCLUDE] || '')
      .split(/[,、\n]+/)
      .map(function (token) { return token.trim(); })
      .filter(function (token) { return token !== ''; });
    rules.push({
      masterId: masterId, channel: channel, days: days, frequency: frequency, excludeTokens: excludeTokens
    });
  });
  return { rules: rules, problems: problems };
}

/** 今日が通知日か。トリガーは毎日動くので、頻度の判定はここで行う */
function isInactivityRuleDue_(frequency, now) {
  if (frequency === '毎週月曜') return now.getDay() === 1;
  return true;
}

/**
 * 投稿・返信のリストから、「活動あり」のユーザーIDを集める。
 * 入退室などのシステムメッセージは、本人の意思による活動ではないので数えない。
 * @return {string[]}
 */
function collectActiveUserIds_(messages) {
  const active = {};
  messages.forEach(function (message) {
    const subtype = String(message.subtype || '');
    if (message.user && subtype.indexOf('channel_') !== 0) active[message.user] = true;
    (message.reactions || []).forEach(function (reaction) {
      (reaction.users || []).forEach(function (userId) { active[userId] = true; });
    });
  });
  return Object.keys(active);
}

/**
 * 通知対象（活動がない人）を、チャンネルの参加者の並び順で返す。
 * 人間のメンバーに含まれない人（Bot・退会済み）と、除外指定の人は外す。
 */
function findInactiveMembers_(channelMemberIds, humanIds, activeIds, excludeIds) {
  return channelMemberIds.filter(function (id) {
    return humanIds.indexOf(id) !== -1 &&
      activeIds.indexOf(id) === -1 &&
      excludeIds.indexOf(id) === -1;
  });
}

/**
 * 設定シートに書かれた人（SlackユーザーID、または表示名）を、メンバー一覧からIDに解決する。
 * 表示名で書く人がいるための対応。同じ表示名の人が複数いるときは、誰か決められないので解決しない。
 * @return {{id: string, reason: string}} 解決できなければ id は空で、reason に理由
 */
function resolveSlackPerson_(token, members) {
  const id = normalizeSlackUserId_(token);
  if (isValidSlackUserId_(id)) return { id: id, reason: '' };

  const key = normalizePersonName_(token);
  const matches = members.filter(function (member) {
    return normalizePersonName_(member.name) === key;
  });
  if (matches.length === 1) return { id: matches[0].id, reason: '' };
  return {
    id: '',
    reason: matches.length === 0 ? '該当する表示名のメンバーがいません' : '同じ表示名のメンバーが複数います'
  };
}

/** 表示名の照合用。先頭の@・前後の空白・大文字小文字の違いを無視する */
function normalizePersonName_(name) {
  return String(name || '').trim().replace(/^[@＠]/, '').trim().toLowerCase();
}

/** 通知文。該当者がいないとき（手動実行のみ）は「いません」の1行。名前の並びだけにして、メンションにはしない（師匠のDMに弟子の通知を飛ばさないため） */
function buildInactivityMessage_(channelId, days, names, since, sheetUrl) {
  const escape = function (text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };
  const period = (since.getMonth() + 1) + '/' + since.getDate() + '〜今日の' + days + '日間';
  if (names.length === 0) {
    return ':white_check_mark: <#' + channelId + '> で、' + period + '、投稿・スレッド返信・スタンプがない方はいません';
  }
  const lines = [
    ':warning: <#' + channelId + '> で、' + period + '、投稿・スレッド返信・スタンプがない方（' + names.length + '名）'
  ];
  names.forEach(function (name) { lines.push('• ' + escape(name)); });
  const sheetLabel = sheetUrl ? '<' + sheetUrl + '|' + SHEET_INACTIVITY_ALERT + '>' : '「' + SHEET_INACTIVITY_ALERT + '」';
  lines.push('※ 通知に出したくない方は、' + sheetLabel +
    'シートの「除外する人」に、上の名前をそのまま書いて追加してください');
  return lines.join('\n');
}

/**
 * チャンネルの参加者IDを全ページ読む。途中で失敗したら null。
 * 欠けた一覧で判定すると、取れなかった人が通知から漏れるため。
 */
function listChannelMemberIds_(config, channelId) {
  const ids = [];
  let cursor = '';
  do {
    const params = { channel: channelId, limit: 200 };
    if (cursor) params.cursor = cursor;
    const json = callSlackApiGet_(config, 'conversations.members', params);
    if (!json.ok) return null;
    (json.members || []).forEach(function (id) { ids.push(id); });
    cursor = (json.response_metadata && json.response_metadata.next_cursor) || '';
  } while (cursor);
  return ids;
}

/**
 * 直近 days 日の投稿と、そのスレッドの返信を全部読む。途中で失敗したら null。
 * @return {Object[]|null}
 */
function listRecentChannelMessages_(config, channelId, days, now) {
  const oldest = String(now.getTime() / 1000 - days * 86400);
  const messages = [];
  const threadParents = [];
  let cursor = '';
  do {
    const params = { channel: channelId, oldest: oldest, limit: 200 };
    if (cursor) params.cursor = cursor;
    const json = callSlackApiGet_(config, 'conversations.history', params);
    if (!json.ok) return null;
    (json.messages || []).forEach(function (message) {
      messages.push(message);
      if (message.reply_count > 0) threadParents.push(message.ts);
    });
    cursor = (json.response_metadata && json.response_metadata.next_cursor) || '';
  } while (cursor);

  for (let i = 0; i < threadParents.length; i++) {
    let replyCursor = '';
    do {
      const params = { channel: channelId, ts: threadParents[i], oldest: oldest, limit: 200 };
      if (replyCursor) params.cursor = replyCursor;
      const json = callSlackApiGet_(config, 'conversations.replies', params);
      if (!json.ok) return null;
      (json.messages || []).forEach(function (message) { messages.push(message); });
      replyCursor = (json.response_metadata && json.response_metadata.next_cursor) || '';
    } while (replyCursor);
  }
  return messages;
}
