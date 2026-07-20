/**
 * FormHandler.gs
 * Googleフォーム送信（新規登録・回答編集）を処理するエントリポイント。
 * setupTriggers() を1度手動実行してフォーム送信トリガーを登録すること。
 */

/** フォーム送信トリガーを登録する（初回セットアップ時に手動実行） */
function setupTriggers() {
  const config = getConfig_();
  // 二重登録を防ぐため既存の同名トリガーを削除
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'onFormSubmit') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  // 弟子用・師匠用（設定されていれば）の両フォームにトリガーを登録
  const formIds = [config.formId];
  if (config.masterFormId && config.masterFormId !== config.formId) {
    formIds.push(config.masterFormId);
  }
  formIds.forEach(function (formId) {
    ScriptApp.newTrigger('onFormSubmit')
      .forForm(formId)
      .onFormSubmit()
      .create();
    applyFormHints_(formId);
  });
  initializeSheets();
}

/**
 * フォームの設問に入力ヒント（説明文）を自動設定する。
 * 特に無料版Meetの60分制限と予定分割の挙動を、入力時点で主催者に伝える。
 */
function applyFormHints_(formId) {
  const form = FormApp.openById(formId);
  form.getItems().forEach(function (item) {
    const title = item.getTitle();
    if (title === FORM_TITLES.FORMAT) {
      item.setHelpText(
        '①オンライン・自動発行は無料版Google Meetを使用します。' +
        '3人以上の通話は60分で自動切断されるため、60分を超えるイベントは' +
        'カレンダー予定が60分ごとに自動分割されます（Meet URLは全予定共通。' +
        '切れたら同じURLで再入室）。切断なしで開催したい場合は' +
        '②を選び、時間制限のないツールのURLを入力してください。'
      );
    }
    if (title === FORM_TITLES.LOCATION) {
      item.setHelpText(
        '開催形式が「②オンライン・手動URL」「③オフライン・対面」の場合は必須です。' +
        '「①オンライン・自動発行」の場合は空欄のままにしてください（Meet URLが自動で入ります）。'
      );
    }
  });
}

/** フォーム送信時のメイン処理（新規登録と回答編集の両方が飛んでくる） */
function onFormSubmit(e) {
  const config = getConfig_();
  const formResponse = e.response;
  const responseId = formResponse.getId();
  // 送信元フォームで種別を判定（師匠用フォーム経由 = 師匠イベント）
  const isMaster = Boolean(config.masterFormId) &&
    e.source.getId() === config.masterFormId;

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const answers = extractAnswers_(formResponse);
    const existing = findEventByResponseId_(config, responseId);
    if (existing) {
      handleEventEdit_(config, existing, answers);
    } else {
      handleNewEvent_(config, formResponse, answers, isMaster);
    }
  } finally {
    lock.releaseLock();
  }
}

/** フォーム回答を設問タイトルで引いてオブジェクト化する */
function extractAnswers_(formResponse) {
  const map = {};
  formResponse.getItemResponses().forEach(function (itemResponse) {
    map[itemResponse.getItem().getTitle()] = itemResponse.getResponse();
  });

  const start = parseDateTime_(map[FORM_TITLES.START]);
  const end = combineEndTime_(start, map[FORM_TITLES.END_TIME]);

  return {
    title: String(map[FORM_TITLES.TITLE] || '').trim(),
    organizer: normalizeSlackUserId_(map[FORM_TITLES.ORGANIZER]),
    start: start,
    end: end,
    capacity: Number(map[FORM_TITLES.CAPACITY]),
    status: String(map[FORM_TITLES.STATUS] || ''),
    format: String(map[FORM_TITLES.FORMAT] || ''),
    location: String(map[FORM_TITLES.LOCATION] || '').trim(),
    description: String(map[FORM_TITLES.DESCRIPTION] || ''),
    preparation: String(map[FORM_TITLES.PREPARATION] || '')
  };
}

/** 「yyyy-MM-dd HH:mm」形式（フォームの日時回答）をDateに変換 */
function parseDateTime_(value) {
  const m = String(value).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/);
  if (!m) throw new Error('開始日時の形式が不正です: ' + value);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
}

/** 終了時刻（HH:mm）を開始日と組み合わせてDateに変換。開始より前なら翌日扱い */
function combineEndTime_(start, value) {
  const m = String(value).match(/(\d{1,2}):(\d{2})/);
  if (!m) throw new Error('終了時刻の形式が不正です: ' + value);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate(), Number(m[1]), Number(m[2]));
  if (end <= start) end.setDate(end.getDate() + 1);
  return end;
}

/** 「@名前」「<@U123>」等の揺れを補正してSlackユーザーIDだけを取り出す */
function normalizeSlackUserId_(value) {
  return String(value || '').trim().replace(/^<@/, '').replace(/>$/, '').replace(/^@/, '');
}

/** ステータス文字列が「中止」かどうか */
function isCancelledStatus_(status) {
  return String(status).indexOf('中止') !== -1;
}

// ==================== 新規登録 ====================

function handleNewEvent_(config, formResponse, answers, isMaster) {
  const now = new Date();
  const eventId = 'EV_' + Utilities.formatDate(now, 'Asia/Tokyo', 'yyyyMMddHHmmss') +
    '_' + Math.floor(Math.random() * 1000);

  const ev = {
    eventId: eventId,
    type: isMaster ? EVENT_TYPE.MASTER : EVENT_TYPE.DISCIPLE,
    responseId: formResponse.getId(),
    title: answers.title,
    organizer: answers.organizer,
    start: answers.start,
    end: answers.end,
    capacity: answers.capacity,
    status: answers.status || '開催',
    format: answers.format,
    location: answers.location,
    description: answers.description,
    preparation: answers.preparation,
    calendarEventId: '',
    slackChannel: config.slackChannelId,
    slackTs: '',
    editUrl: formResponse.getEditResponseUrl(),
    createdAt: now,
    updatedAt: now
  };

  // 1. カレンダー登録（自動発行の場合はMeet URLを取得して場所に採用。60分超なら分割）
  const calendarResult = createCalendarEvents_(config, ev);
  ev.calendarEventId = calendarResult.calendarEventIds.join(',');
  if (isAutoMeet_(ev.format) && calendarResult.meetUrl) {
    ev.location = calendarResult.meetUrl;
  }

  // 2. Slack告知投稿（参加/取り消しボタン付きBlock Kitメッセージ）
  const participantsUrl = buildParticipantsPageUrl_(config, eventId);
  const msg = buildAnnouncementBlocks_(ev, [], participantsUrl);
  const ts = postMessage_(config, config.slackChannelId, msg.text, null, msg.blocks);
  if (ts) {
    ev.slackTs = ts;
  }

  // 3. スプレッドシートへ記録（管理用・公開用の両方）
  insertEvent_(config, ev);

  // 4. カレンダー説明欄に概要・参加者確認URL・Slackパーマリンクを書き込み
  const permalink = ts ? getPermalink_(config, config.slackChannelId, ts) : '';
  patchCalendarDescriptions_(config, ev, buildCalendarDescription_(ev, participantsUrl, permalink));

  // 5. 主催者へ回答編集用URLをDMで通知
  let dmText =
    ':white_check_mark: イベント「' + ev.title + '」を登録しました。\n' +
    '内容の変更・中止はこちらの回答編集用URLから行ってください:\n' + ev.editUrl;
  if (needsMeetSplit_(ev)) {
    dmText += '\n\n:bulb: 60分を超えるオンラインイベントのため、無料版Meetの制限（3人以上は60分で切断）に合わせて' +
      'カレンダー予定を' + calendarEventIds_(ev).length + 'つに分割しました。Meet URLは全予定共通です。';
  }
  sendDirectMessage_(config, ev.organizer, dmText);
}

// ==================== 回答編集（変更・中止） ====================

function handleEventEdit_(config, existing, answers) {
  const now = new Date();
  const ev = existing;
  // 日時・開催形式が変わった場合はカレンダー予定の作り直しが必要（分割数が変わり得るため）
  const scheduleChanged =
    existing.start.getTime() !== answers.start.getTime() ||
    existing.end.getTime() !== answers.end.getTime() ||
    existing.format !== answers.format;
  ev.title = answers.title;
  ev.organizer = answers.organizer;
  ev.start = answers.start;
  ev.end = answers.end;
  ev.capacity = answers.capacity;
  ev.status = answers.status;
  ev.format = answers.format;
  ev.description = answers.description;
  ev.preparation = answers.preparation;
  ev.updatedAt = now;
  // Meet自動発行の場合は既存のMeet URLを維持、それ以外はフォーム入力値を採用
  if (!isAutoMeet_(ev.format)) {
    ev.location = answers.location;
  }

  if (isCancelledStatus_(ev.status)) {
    cancelEvent_(config, ev);
    return;
  }

  // ---- ステータス「開催」のままの内容変更：一括更新 ----
  const participantsUrl = buildParticipantsPageUrl_(config, ev.eventId);
  const permalink = ev.slackTs ? getPermalink_(config, ev.slackChannel, ev.slackTs) : '';

  // カレンダー更新（日時・形式変更時は作り直し。ev の calendarEventId / location が更新される）
  updateCalendarEvents_(config, ev, scheduleChanged);
  patchCalendarDescriptions_(config, ev, buildCalendarDescription_(ev, participantsUrl, permalink));
  updateEvent_(config, ev);
  // 定員増加時：空いた枠の分だけキャンセル待ちを先着順で自動繰り上げ（本人へDM通知）
  promoteWaitlistedUpToCapacity_(config, ev);
  refreshAnnouncement_(config, ev);
  // 定員減少時：既存の参加者リストは維持したまま、以降の新規受付は
  // ボタン処理側の「現在人数 >= 定員」判定で自動的にキャンセル待ちへ回る。

  let dmText = ':pencil2: イベント「' + ev.title + '」の内容を更新しました。';
  if (scheduleChanged && isAutoMeet_(ev.format)) {
    dmText += '\n:bulb: 日時・開催形式の変更に伴い、Meet URLが再発行されています。最新のURLはSlack告知メッセージをご確認ください。';
  }
  sendDirectMessage_(config, ev.organizer, dmText);
}

/** イベント中止処理：カレンダー削除（分割予定を含む全件）・シート更新・Slack告知へ【中止】追記 */
function cancelEvent_(config, ev) {
  deleteCalendarEvents_(config, ev);
  updateEvent_(config, ev); // ステータス「中止」を記録 → 以降のスタンプ検知はスキップされる

  if (ev.slackTs) {
    // 告知メッセージを【中止】表示に再描画（ボタンは自動的に消える）
    refreshAnnouncement_(config, ev);
    postMessage_(
      config, ev.slackChannel,
      ':no_entry: イベント「' + ev.title + '」は中止になりました。',
      ev.slackTs
    );
  }

  sendDirectMessage_(
    config, ev.organizer,
    ':no_entry: イベント「' + ev.title + '」を中止として処理しました（カレンダー削除・告知更新済み）。'
  );
}

