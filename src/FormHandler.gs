/**
 * FormHandler.gs
 * Googleフォーム送信（新規登録・回答編集）を処理するエントリポイント。
 * setupTriggers() を1度手動実行してフォーム送信トリガーを登録すること。
 */

/** フォーム送信・定期同期トリガーを登録する（初回セットアップ時に手動実行） */
function setupTriggers() {
  const config = getConfig_();
  // 二重登録を防ぐため既存の同名トリガーを削除
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    const handler = trigger.getHandlerFunction();
    if (handler === 'onFormSubmit' || handler === 'syncPublicSheets') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  // 公開用シートへの参加者リスト定期同期（5分毎）
  ScriptApp.newTrigger('syncPublicSheets')
    .timeBased()
    .everyMinutes(5)
    .create();
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
    // 1. 回答の取り出し（日時の解釈に失敗したら主催者へDMで通知して終了）
    let answers;
    try {
      answers = extractAnswers_(formResponse);
    } catch (err) {
      notifyFormError_(config, formResponse, ['日時を解釈できませんでした: ' + err.message]);
      return;
    }

    // 2. 入力検証（不備があれば登録・更新せず、修正用リンク付きでDM通知）
    const existing = findEventByResponseId_(config, responseId);
    const errors = validateAnswers_(answers, existing);
    if (errors.length > 0) {
      notifyFormError_(config, formResponse, errors);
      return;
    }

    if (existing) {
      handleEventEdit_(config, existing, answers);
    } else {
      // 3. 二重登録ガード（「編集のつもりで新規送信」対策）
      const duplicate = findDuplicateEvent_(config, answers);
      if (duplicate) {
        notifyDuplicateEvent_(config, answers, duplicate);
        return;
      }
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

/** SlackユーザーIDとして妥当な形式かどうか（U/W始まりの英数字） */
function isValidSlackUserId_(id) {
  return /^[UW][A-Z0-9]{4,}$/.test(String(id || ''));
}

// ==================== 入力検証・二重登録ガード ====================

/**
 * フォーム回答を検証してエラー文言の配列を返す（空配列なら問題なし）。
 * @param {Object} answers 回答
 * @param {?Object} existing 編集の場合は既存イベント、新規なら null
 */
function validateAnswers_(answers, existing) {
  const errors = [];
  if (!answers.title) {
    errors.push('イベント名を入力してください。');
  }
  if (!isValidSlackUserId_(answers.organizer)) {
    errors.push('主催者のSlackユーザーIDの形式が不正です（例: U0123ABCD）。' +
      'Slackで `/event` を実行すると、IDが自動入力されたフォームが届きます。');
  }
  // 開始日時の過去チェック（編集で開始日時を変えていない場合は開催後の修正を許容）
  const startChanged = !existing || existing.start.getTime() !== answers.start.getTime();
  if (startChanged && answers.start.getTime() < Date.now()) {
    errors.push('開始日時が過去になっています。日付・時刻を確認してください。');
  }
  if (!Number.isInteger(answers.capacity) || answers.capacity < 1) {
    errors.push('定員は1以上の整数で入力してください。');
  }
  if (!isAutoMeet_(answers.format) && !answers.location) {
    errors.push('開催形式が「②オンライン・手動URL」「③オフライン・対面」の場合、' +
      '「会場URL または 開催場所」の入力は必須です。');
  }
  return errors;
}

/** 入力不備を主催者へDMで通知する（IDが不正でDMできない場合は告知チャンネルへ案内） */
function notifyFormError_(config, formResponse, errors) {
  let organizer = '';
  try {
    formResponse.getItemResponses().forEach(function (itemResponse) {
      if (itemResponse.getItem().getTitle() === FORM_TITLES.ORGANIZER) {
        organizer = normalizeSlackUserId_(itemResponse.getResponse());
      }
    });
  } catch (err) {
    console.warn('主催者IDの取り出しに失敗: ' + err);
  }

  if (isValidSlackUserId_(organizer)) {
    sendDirectMessage_(
      config, organizer,
      ':warning: *イベントの登録・更新を受け付けられませんでした*\n' +
      errors.map(function (msg) { return '• ' + msg; }).join('\n') + '\n\n' +
      '以下のURLから修正して再送信してください:\n' + formResponse.getEditResponseUrl()
    );
  } else {
    // DMの宛先が分からないため、告知チャンネルで心当たりのある人へ案内
    postMessage_(
      config, config.slackChannelId,
      ':warning: フォームからのイベント登録を受け付けられませんでした' +
      '（主催者のSlackユーザーIDが不正なため、通知をお送りできません）。\n' +
      '心当たりのある方は、Slackで `/event` を実行して届くフォームから再登録してください。'
    );
  }
}

/**
 * 「編集のつもりで新規送信」による二重登録を検知する。
 * 同じ主催者が、同じ開始日時で開催中ステータスのイベントを既に持っていれば重複とみなす
 * （同じイベント名でも開始日時が異なれば連続講座として正常に登録できる）。
 */
function findDuplicateEvent_(config, answers) {
  return findEvent_(config, function (ev) {
    return ev.organizer === answers.organizer &&
      !isCancelledStatus_(ev.status) &&
      ev.start.getTime() === answers.start.getTime();
  });
}

/** 二重登録を検知した旨を主催者へDMで通知する（今回の送信は登録しない） */
function notifyDuplicateEvent_(config, answers, duplicate) {
  sendDirectMessage_(
    config, answers.organizer,
    ':warning: *二重登録の可能性があるため、今回の送信は登録していません*\n' +
    '同じ開始日時のイベント「' + duplicate.title + '」がすでに登録されています。\n\n' +
    '• 既存イベントの内容を変更したい場合 → こちらの編集用URLから修正してください:\n' +
    duplicate.editUrl + '\n' +
    '• 別イベントとして開催したい場合 → 開始日時を変えて、もう一度フォームを送信してください。'
  );
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
    detailTs: '',
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

  // 2. Slack告知投稿（本文は参加ボタン・日時など重要情報のみのBlock Kitメッセージ）
  const participantsUrl = buildParticipantsPageUrl_(config, eventId);
  const msg = buildAnnouncementBlocks_(ev, [], participantsUrl);
  const ts = postMessage_(config, config.slackChannelId, msg.text, null, msg.blocks);
  if (ts) {
    ev.slackTs = ts;
    // 概要の続き・事前準備・持ち物などは、本文を長くしないようスレッド返信へ回す
    // （短い概要だけで完結するイベントはスレッドを作らない）
    if (needsDetailThread_(ev)) {
      const detailMsg = buildDetailBlocks_(ev);
      const detailTs = postMessage_(config, config.slackChannelId, detailMsg.text, ts, detailMsg.blocks);
      if (detailTs) {
        ev.detailTs = detailTs;
      }
    }
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
  // 変更前の日時を控える（時間変更の周知でビフォー/アフターを示すため）
  const prevStart = existing.start;
  const prevEnd = existing.end;
  // 開催時間そのものが変わったか（開催形式の変更は含めない。参加者への時間変更周知の判定に使う）
  const timeChanged =
    existing.start.getTime() !== answers.start.getTime() ||
    existing.end.getTime() !== answers.end.getTime();
  // 日時・開催形式が変わった場合はカレンダー予定の作り直しが必要（分割数が変わり得るため）
  const scheduleChanged =
    timeChanged ||
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
  // 概要・持ち物などが変わり得るため、スレッドの詳細情報も最新化する
  refreshDetailThread_(config, ev);
  // 定員減少時：既存の参加者リストは維持したまま、以降の新規受付は
  // ボタン処理側の「現在人数 >= 定員」判定で自動的にキャンセル待ちへ回る。

  // 開催時間が変わった場合は、告知スレッドと参加者DMで能動的に周知する
  // （Slackはメッセージ編集ではプッシュ通知を出さず、告知の再描画だけでは参加者が気づけないため）
  if (timeChanged) {
    notifyScheduleChange_(config, ev, prevStart, prevEnd);
  }

  let dmText = ':pencil2: イベント「' + ev.title + '」の内容を更新しました。';
  if (scheduleChanged && isAutoMeet_(ev.format)) {
    dmText += '\n:bulb: 日時・開催形式の変更に伴い、Meet URLが再発行されています。最新のURLはSlack告知メッセージをご確認ください。';
  }
  sendDirectMessage_(config, ev.organizer, dmText);
}

/**
 * 開催時間の変更を、告知スレッドへの投稿と参加者・キャンセル待ちへのDMで周知する。
 * @param {Object} config 設定
 * @param {Object} ev 変更後のイベント（ev.start / ev.end は更新済み）
 * @param {Date} prevStart 変更前の開始日時
 * @param {Date} prevEnd 変更前の終了日時
 */
function notifyScheduleChange_(config, ev, prevStart, prevEnd) {
  const before = formatDateRange_(prevStart, prevEnd);
  const after = formatDateRange_(ev.start, ev.end);

  // 1. 告知スレッドへお知らせを投稿（フォロワー全体にプッシュ通知が飛ぶ）
  if (ev.slackTs) {
    postMessage_(
      config, ev.slackChannel,
      ':alarm_clock: イベント「' + ev.title + '」の開催日時が変更されました。\n' +
      '• 変更前: ' + before + '\n' +
      '• 変更後: ' + after + '\n' +
      '参加登録済みの方へは個別にDMでもお知らせしています。',
      ev.slackTs
    );
  }

  // 2. 参加者・キャンセル待ちの各人へDM（時間変更は双方に影響するため両方へ送る）
  // DMは告知チャンネルと別の場所に届くため、告知メッセージへのリンクを添えて
  // どのイベントかをすぐ辿れるようにする（同名の連続講座がある場合の取り違え防止）。
  const permalink = ev.slackTs ? getPermalink_(config, ev.slackChannel, ev.slackTs) : '';
  const linkLine = permalink ? '\n▶ 告知を見る: ' + permalink : '';
  listParticipants_(config, ev.eventId).forEach(function (p) {
    const suffix = p.status === PSTATUS.WAITLIST ? '（現在キャンセル待ちで登録中です）' : '';
    sendDirectMessage_(
      config, p.userId,
      ':alarm_clock: 参加登録中のイベント「' + ev.title + '」の開催日時が変更されました。' + suffix + '\n' +
      '• 変更前: ' + before + '\n' +
      '• 変更後: ' + after + '\n' +
      'ご都合が合わなくなった場合は、告知メッセージの「取り消す」ボタンからキャンセルできます。' +
      linkLine
    );
  });
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

