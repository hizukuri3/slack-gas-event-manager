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
    if (handler === 'onFormSubmit' || handler === 'syncPublicSheets' ||
        handler === 'onManagementSpreadsheetEdit' ||
        handler === 'onManagementSpreadsheetChange') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  // 公開用シートへの参加者リスト定期同期（5分毎）
  ScriptApp.newTrigger('syncPublicSheets')
    .timeBased()
    .everyMinutes(5)
    .create();
  // 管理用①の「師匠リスト」シートの編集を、その場でスクリプトプロパティへ反映する。
  // onEdit（セルの値の変更）と onChange（行・シートの削除）の両方が要る。
  // 行削除は onEdit では発火しないため、片方だけだと「消したのに効かない」が起きる
  ScriptApp.newTrigger('onManagementSpreadsheetEdit')
    .forSpreadsheet(config.managementSpreadsheetId)
    .onEdit()
    .create();
  ScriptApp.newTrigger('onManagementSpreadsheetChange')
    .forSpreadsheet(config.managementSpreadsheetId)
    .onChange()
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
  });
  initializeSheets();
  // ヒントと選択肢の反映は initializeSheets() の後に回す。
  // VC部屋の選択肢はVCルームリストが正なので、シートが出来ていないと空になる
  syncVcRoomChoices();
  // 師匠リストシートの内容をプロパティへ反映する。
  // プロパティで師匠を管理していた既存インスタンスは、ここで初回移行が走る
  syncMasterList();
}

/**
 * フォームの設問に入力ヒント（説明文）と選択肢を反映する。
 *
 * 選択肢まで面倒を見るのは、開催形式もVC部屋も「コード／シートが正」で、
 * フォームはその写しにすぎないため。buildFormItems_（Bootstrap.gs）は
 * フォームを新規作成したときにしか走らないので、そちらだけを直しても
 * すでに動いているインスタンスには永久に反映されない。ここを通しておけば
 * setupTriggers() の実行で既存フォームも追随する。
 *
 * FormApp.openById() は1回およそ1秒かかるが、この関数はセットアップと
 * シート編集トリガーからしか呼ばれず、Slackの3秒ルールの外にある。
 */
function applyFormHints_(formId, vcRoomChoices) {
  const form = FormApp.openById(formId);
  form.getItems().forEach(function (item) {
    const title = item.getTitle();

    if (title === FORM_TITLES.FORMAT) {
      setChoicesIfMultipleChoice_(item, EVENT_FORMAT_VALUES);
      // ラベルを短くしたぶん、選択肢の意味はすべてここで説明する
      item.setHelpText(
        '「' + EVENT_FORMATS.DISCORD + '」… 下の「' + FORM_TITLES.VC_ROOM +
        '」で選んだ部屋を自動で押さえます（会場URLの入力は不要です）。\n' +
        '「' + EVENT_FORMATS.MEET + '」… URLを自動発行します。無料版のため3人以上の通話は' +
        '60分で自動切断され、60分を超えるイベントはカレンダー予定が60分ごとに自動分割されます' +
        '（各回で別々のURLを発行。切れても次の回へ待ち時間なしで入室可能）。\n' +
        '「' + EVENT_FORMATS.MANUAL_URL + '」「' + EVENT_FORMATS.OFFLINE + '」… 下の「' +
        FORM_TITLES.LOCATION + '」の入力が必要です。'
      );
    }

    if (title === FORM_TITLES.VC_ROOM) {
      if (vcRoomChoices && vcRoomChoices.length > 0) {
        setChoicesIfMultipleChoice_(item, vcRoomChoices);
      }
      item.setHelpText(
        '「' + EVENT_FORMATS.DISCORD + '」を選んだ場合のみ使われます（他の形式では無視されます）。\n' +
        '「' + VC_ROOM_AUTO + '」にしておくと、その時間に空いている部屋を自動で確保するため' +
        '「部屋が取れない」がほぼ起きません。部屋を指名した場合、その部屋が埋まっていると' +
        '登録できず差し戻しになります。'
      );
    }

    if (title === FORM_TITLES.LOCATION) {
      item.setHelpText(
        '開催形式が「' + EVENT_FORMATS.MANUAL_URL + '」「' + EVENT_FORMATS.OFFLINE +
        '」の場合は必須です。\n' +
        '「' + EVENT_FORMATS.DISCORD + '」「' + EVENT_FORMATS.MEET +
        '」の場合は空欄のままにしてください（URLが自動で入ります）。'
      );
    }
  });
}

/**
 * 選択式の設問なら選択肢を差し替える。
 * 型を確かめてから触るのは、設問を作り直して型が変わっていた場合に
 * asMultipleChoiceItem() が例外を投げ、ヒント付与ごと止まってしまうため。
 */
function setChoicesIfMultipleChoice_(item, choices) {
  if (item.getType() !== FormApp.ItemType.MULTIPLE_CHOICE) return;
  item.asMultipleChoiceItem().setChoiceValues(choices);
}

/**
 * VCルームリストの内容をフォームの「VC部屋」設問へ反映する。
 * 管理用①のシート編集・行削除トリガーから呼ばれ、部屋を1行足すと
 * その場でフォームでも選べるようになる。
 * @return {{roomCount: number, formCount: number, failed: number}}
 */
function syncVcRoomChoices() {
  const config = getConfig_();
  const choices = vcRoomChoiceValues_(config);
  const formIds = [config.formId];
  if (config.masterFormId && config.masterFormId !== config.formId) {
    formIds.push(config.masterFormId);
  }

  let formCount = 0;
  let failed = 0;
  formIds.forEach(function (formId) {
    if (!formId) return;
    try {
      applyFormHints_(formId, choices);
      formCount++;
    } catch (err) {
      // 片方のフォームが壊れていても、もう片方の反映は続ける
      failed++;
      console.warn('VC部屋の選択肢を反映できませんでした (' + formId + '): ' + err);
    }
  });
  // 先頭の「おまかせ」は部屋ではないので数から外す
  return { roomCount: choices.length - 1, formCount: formCount, failed: failed };
}

/** VC部屋の同期結果を、操作した人へトーストで知らせる（師匠リストと同じ流儀） */
function notifyVcRoomSync_(spreadsheet, result) {
  if (!spreadsheet) return;
  let message = '使えるVC部屋 ' + result.roomCount + '件をフォームへ反映しました';
  if (result.roomCount === 0) {
    message = '使えるVC部屋が0件です。この状態で「' + EVENT_FORMATS.DISCORD +
      '」を選ぶと登録できません（VC名とチャンネルURLの両方が必要です）';
  }
  if (result.failed > 0) {
    message += ' / ' + result.failed + '件のフォームへは反映できませんでした（ログを確認してください）';
  }
  spreadsheet.toast(message, SHEET_VC_ROOMS, result.roomCount === 0 || result.failed > 0 ? 20 : 8);
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
      handleEventEdit_(config, existing, answers, formResponse);
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
    // 判定は EVENT_FORMATS との完全一致なので、入り口で前後の空白を落としておく
    format: String(map[FORM_TITLES.FORMAT] || '').trim(),
    // 設問そのものが無い古いフォームでは空になる。assignVcRoom_ は
    // 空を「おまかせ」と同じ扱いにするので、それでも登録は通る
    vcRoom: String(map[FORM_TITLES.VC_ROOM] || '').trim(),
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
  // 開催形式は選択肢のどれかでなければならない。一致しない値が届くのは、フォームの
  // 選択肢が手で書き換えられたときで、放っておくと「会場URLが要る形式」として静かに
  // 扱われる。ここで弾いておけば、運営がその場で気づける
  if (EVENT_FORMAT_VALUES.indexOf(answers.format) === -1) {
    errors.push('開催形式「' + answers.format + '」は選択肢にありません。' +
      'フォームの選択肢が書き換えられた可能性があります。運営にお問い合わせください。');
  } else if (!isAutoMeet_(answers.format) && !isDiscordVc_(answers.format) && !answers.location) {
    // Discord VCとMeet自動発行は、会場URLをシステムが埋めるので入力を求めない
    errors.push('開催形式が「' + EVENT_FORMATS.MANUAL_URL + '」「' + EVENT_FORMATS.OFFLINE +
      '」の場合、「' + FORM_TITLES.LOCATION + '」の入力は必須です。');
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
    editUrl: formResponse.getEditResponseUrl(),
    createdAt: now,
    updatedAt: now,
    vcRoom: ''
  };

  // 0. Discord VCなら部屋を確保する。カレンダー登録より先に済ませるのは、
  //    確保できなかったときにカレンダー予定も告知も作らずに差し戻すため
  //    （先に作ってしまうと、差し戻しのたびに孤児の予定が残る）
  if (isDiscordVc_(ev.format)) {
    const assigned = assignVcRoom_(config, ev, answers.vcRoom);
    if (!assigned.room) {
      notifyFormError_(config, formResponse, assigned.errors);
      return;
    }
    ev.vcRoom = assigned.room.name;
    ev.location = assigned.room.url;
  }

  // 1. カレンダー登録（自動発行の場合はMeet URLを取得して場所に採用。60分超なら分割）
  const calendarResult = createCalendarEvents_(config, ev);
  ev.calendarEventId = calendarResult.calendarEventIds.join(',');
  if (isAutoMeet_(ev.format) && calendarResult.meetUrls.length) {
    // 区間ごとのMeet URLをカンマ区切りで保持（分割なしなら1件）
    ev.location = calendarResult.meetUrls.join(',');
  }

  // 2. Slack告知投稿（参加/取り消しボタン付きBlock Kitメッセージ）
  const participantsUrl = buildParticipantsPageUrl_(config, eventId);
  const msg = buildAnnouncementBlocks_(ev, [], participantsUrl, buildCalendarViewUrl_(config));
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
  if (ev.vcRoom) {
    // どの部屋が確保されたかは主催者が最初に知りたい情報なので、編集URLの直後に置く
    dmText += '\n\n:speaker: 会場VC: *' + ev.vcRoom + '* を確保しました\n' + ev.location;
  }
  if (calendarResult.htmlLink) {
    // 登録内容がカレンダーへ正しく反映されたか、主催者がその場で確認できるようにする
    dmText += '\n\n:calendar: 登録された予定を確認する:\n' + calendarResult.htmlLink;
  }
  if (needsMeetSplit_(ev)) {
    dmText += '\n\n:bulb: 60分を超えるオンラインイベントのため、無料版Meetの制限（3人以上は60分で切断）に合わせて' +
      'カレンダー予定を' + calendarEventIds_(ev).length + 'つに分割しました。各回で別々のMeet URLになっており' +
      '（切れても次の回のURLへ待ち時間なしで入室可能）、URL一覧はSlack告知メッセージに掲載しています。';
  }
  sendDirectMessage_(config, ev.organizer, dmText);
}

// ==================== 回答編集（変更・中止） ====================

function handleEventEdit_(config, existing, answers, formResponse) {
  const now = new Date();
  const ev = existing;
  // 変更前の日時を控える（時間変更の周知でビフォー/アフターを示すため）
  const prevStart = existing.start;
  const prevEnd = existing.end;
  // 変更前のVC部屋。取り直しで変わったら参加者へ周知する必要がある
  const prevRoom = existing.vcRoom;
  // 中止から「開催」へ戻す編集か。中止の間その部屋は空き扱いになっており、
  // 他のイベントに取られている可能性があるため、復活時は必ず取り直す
  const revived = isCancelledStatus_(existing.status) && !isCancelledStatus_(answers.status);
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
  // Meet自動発行とDiscord VCは会場URLをシステムが持つので、フォーム入力値で上書きしない。
  // ここを素通しにすると、主催者が会場欄を空にしたまま再送信しただけでURLが消える
  if (!isAutoMeet_(ev.format) && !isDiscordVc_(ev.format)) {
    ev.location = answers.location;
  }

  if (isCancelledStatus_(ev.status)) {
    // 中止すると vcRoomsInUse_ の対象から外れるので、部屋は自動的に空く。
    // シートには部屋名を残す（中止の告知に会場を出したままにするため）。
    // 「開催」へ戻す編集は上の revived で必ず取り直すので、空いた部屋を
    // 持ったまま復活することはない
    cancelEvent_(config, ev);
    return;
  }

  // ---- Discord VCの部屋の取り直し ----
  // 取り直すのは、日時か開催形式が変わったとき・部屋を指名し直したとき・
  // 中止から復活したとき・まだ部屋を持っていないとき（他形式からの切り替え）だけ。
  // 変わっていないのに取り直すと、同じ部屋を取り戻せる保証がなく
  // 「イベント名を直しただけで部屋が変わった」が起こりうる
  if (isDiscordVc_(ev.format)) {
    const namedDifferentRoom = answers.vcRoom &&
      answers.vcRoom !== VC_ROOM_AUTO && answers.vcRoom !== ev.vcRoom;
    if (scheduleChanged || namedDifferentRoom || revived || !ev.vcRoom) {
      const assigned = assignVcRoom_(config, ev, answers.vcRoom);
      if (!assigned.room) {
        // 何も更新せずに差し戻す。イベントは変更前の日時・部屋のまま残る
        notifyFormError_(config, formResponse, assigned.errors);
        return;
      }
      ev.vcRoom = assigned.room.name;
      ev.location = assigned.room.url;
    }
  } else if (ev.vcRoom) {
    // Discord以外へ切り替えたら部屋を手放す（押さえたままにしない）
    ev.vcRoom = '';
  }
  const roomChanged = ev.vcRoom !== prevRoom;

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

  // 開催時間が変わった場合は、告知スレッドと参加者DMで能動的に周知する
  // （Slackはメッセージ編集ではプッシュ通知を出さず、告知の再描画だけでは参加者が気づけないため）
  if (timeChanged || roomChanged) {
    notifyScheduleChange_(config, ev, prevStart, prevEnd, prevRoom);
  }

  let dmText = ':pencil2: イベント「' + ev.title + '」の内容を更新しました。';
  if (scheduleChanged && isAutoMeet_(ev.format)) {
    dmText += '\n:bulb: 日時・開催形式の変更に伴い、Meet URLが再発行されています。最新のURLはSlack告知メッセージをご確認ください。';
  }
  const calendarUrl = buildCalendarViewUrl_(config);
  if (calendarUrl) {
    dmText += '\n\n:calendar: カレンダーで確認する:\n' + calendarUrl;
  }
  sendDirectMessage_(config, ev.organizer, dmText);
}

/**
 * 開催時間・会場VCの変更を、告知スレッドへの投稿と参加者・キャンセル待ちへのDMで周知する。
 *
 * 会場VCの変更も同じ強度で伝えるのは、時間の変更とまったく同じ理由による。
 * Slackはメッセージの編集では通知も未読も出さないため、告知を再描画しただけでは
 * 「いつもの部屋」に集まってしまう人が出る。黙って部屋が変わるのが一番まずい。
 *
 * @param {Object} config 設定
 * @param {Object} ev 変更後のイベント（start / end / vcRoom は更新済み）
 * @param {Date} prevStart 変更前の開始日時
 * @param {Date} prevEnd 変更前の終了日時
 * @param {string} prevRoom 変更前のVC部屋名（無ければ空文字）
 */
function notifyScheduleChange_(config, ev, prevStart, prevEnd, prevRoom) {
  const timeChanged = prevStart.getTime() !== ev.start.getTime() ||
    prevEnd.getTime() !== ev.end.getTime();
  const roomChanged = String(prevRoom || '') !== String(ev.vcRoom || '');
  if (!timeChanged && !roomChanged) return;

  const lines = [];
  if (timeChanged) {
    lines.push('• 日時（変更前）: ' + formatDateRange_(prevStart, prevEnd));
    lines.push('• 日時（変更後）: ' + formatDateRange_(ev.start, ev.end));
  }
  if (roomChanged) {
    lines.push('• 会場VC（変更前）: ' + (prevRoom || '（なし）'));
    lines.push('• 会場VC（変更後）: ' + (ev.vcRoom || '（なし）'));
  }
  const detail = lines.join('\n');
  const headline = timeChanged && roomChanged ? '開催日時と会場が変更されました'
    : timeChanged ? '開催日時が変更されました'
    : '会場が変更されました';

  // 1. 告知スレッドへお知らせを投稿（フォロワー全体にプッシュ通知が飛ぶ）
  if (ev.slackTs) {
    postMessage_(
      config, ev.slackChannel,
      ':alarm_clock: イベント「' + ev.title + '」の' + headline + '。\n' +
      detail + '\n' +
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
      ':alarm_clock: 参加登録中のイベント「' + ev.title + '」の' + headline + '。' + suffix + '\n' +
      detail + '\n' +
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

