/**
 * InteractionHandler.gs
 * Slack Interactivity（告知メッセージのボタン押下）を受け取るWebアプリ。
 * 参加登録・キャンセル・定員管理・キャンセル待ち繰り上げをリアルタイムに処理する。
 *
 * 注意: GASのWebアプリはHTTPヘッダーを参照できないため、署名検証
 * （X-Slack-Signature + SLACK_SIGNING_SECRET のHMAC検証）は実装できない。
 * 代替として、ペイロードに含まれる token を SLACK_VERIFICATION_TOKEN と照合する。
 */

function doPost(e) {
  // Interactivity は application/x-www-form-urlencoded の payload= で届く
  if (e && e.parameter && e.parameter.payload) {
    try {
      handleInteraction_(JSON.parse(e.parameter.payload));
    } catch (err) {
      console.error('ボタン処理でエラー: ' + err);
    }
    return ContentService.createTextOutput('');
  }
  // スラッシュコマンド（/event）は command= を含むフォームPOSTで届く
  if (e && e.parameter && e.parameter.command) {
    try {
      return handleSlashCommand_(e.parameter);
    } catch (err) {
      console.error('スラッシュコマンド処理でエラー: ' + err);
      return slashResponse_(':warning: エラーが発生しました。時間をおいて再度お試しください。');
    }
  }
  return ContentService.createTextOutput('');
}

/** ボタン押下（block_actions）のメイン処理 */
function handleInteraction_(payload) {
  if (payload.type !== 'block_actions') return;

  const config = getConfig_();

  // 簡易検証：Verification Token の照合（設定されている場合のみ）
  if (config.slackVerificationToken && payload.token !== config.slackVerificationToken) {
    return;
  }

  const action = (payload.actions && payload.actions[0]) || null;
  if (!action) return;
  if (action.action_id !== ACTION_JOIN &&
      action.action_id !== ACTION_JOIN_STAFF &&
      action.action_id !== ACTION_LEAVE) return;

  const userId = payload.user.id;
  const responseUrl = payload.response_url;

  // ボタンの value に埋めた イベントID で特定（旧メッセージ向けに ts でもフォールバック）
  let ev = action.value ? findEventById_(config, action.value) : null;
  if (!ev && payload.channel && payload.message) {
    ev = findEventByMessage_(config, payload.channel.id, payload.message.ts);
  }
  if (!ev) {
    respondEphemeral_(responseUrl, ':warning: 対象のイベントが見つかりませんでした。');
    return;
  }

  // 告知の再描画には、押されたメッセージ自身の channel/ts（ペイロード由来）を
  // 正として使う。シート上のtsが数値化の桁落ちで壊れていても再描画が失敗しない。
  // ズレを検知したらロック外でシートへ正しい値を書き戻して自己修復する
  let tsRepairNeeded = false;
  if (payload.channel && payload.message &&
      (ev.slackChannel !== payload.channel.id || ev.slackTs !== payload.message.ts)) {
    ev.slackChannel = payload.channel.id;
    ev.slackTs = payload.message.ts;
    tsRepairNeeded = true;
  }

  // 中止済みイベントは処理しない
  if (isCancelledStatus_(ev.status)) {
    respondEphemeral_(responseUrl, ':no_entry: このイベントは中止になったため、操作できません。');
    return;
  }

  // ガードレール：イベント終了後は一切の処理をスキップ
  if (ev.end.getTime() < Date.now()) {
    respondEphemeral_(responseUrl, ':hourglass: このイベントはすでに終了しています。');
    return;
  }

  // 表示名の取得（外部API呼び出し）はロックの外で済ませておく
  const isJoinAction = action.action_id === ACTION_JOIN || action.action_id === ACTION_JOIN_STAFF;
  const displayName = isJoinAction ? getDisplayName_(config, userId) : null;

  // 同時押下の競合を防ぐロック。取得できなければ本人にリトライを案内
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (err) {
    respondEphemeral_(
      responseUrl,
      ':hourglass: ただいま操作が混み合っています。数秒おいて、もう一度ボタンを押してください。'
    );
    return;
  }

  // ---- ロック内：シートの読み書きと判定のみ（通知・再描画はロック外へ）----
  let result;
  try {
    if (action.action_id === ACTION_JOIN) {
      result = handleJoin_(config, ev, userId, displayName);
    } else if (action.action_id === ACTION_JOIN_STAFF) {
      result = handleJoinStaff_(config, ev, userId, displayName);
    } else {
      result = handleLeave_(config, ev, userId);
    }
  } finally {
    lock.releaseLock();
  }

  // ---- ロック外：本人への応答・告知の再描画・各種通知 ----
  respondEphemeral_(responseUrl, result.feedback);
  if (result.changed) {
    refreshAnnouncement_(config, ev);
  }
  if (tsRepairNeeded) {
    // 壊れたts（数値化された過去データ）を正しい値で上書きし、
    // 中止・編集通知などボタン以外の経路でも参照できるようにする
    updateEvent_(config, ev);
  }
  if (result.promoted) {
    sendDirectMessage_(
      config, result.promoted.userId,
      ':tada: 「' + ev.title + '」に空きが出たため、キャンセル待ちから繰り上がりで参加が確定しました！\n' +
      Utilities.formatDate(ev.start, 'Asia/Tokyo', 'yyyy/MM/dd(EEE) HH:mm') + ' 開始です。'
    );
  }
  if (result.remainingNotice) {
    postMessage_(
      config, ev.slackChannel,
      ':bell: 空き枠が出ました（残り' + result.remainingNotice + '枠）。' +
      '参加希望の方は「✋ 参加する」ボタンからどうぞ！',
      ev.slackTs
    );
  }
  if (result.fullNotice) {
    postMessage_(
      config, ev.slackChannel,
      ':u6e80: 満席になりました（参加 ' + ev.capacity + '/' + ev.capacity + '名）。' +
      '以降の参加希望は「キャンセル待ち」として先着順で受け付けます。',
      ev.slackTs
    );
  }
}

/**
 * 「参加する」ボタン：定員内なら参加、満員ならキャンセル待ちとして受付。
 * ロック内で呼ばれるため、シート操作と判定のみを行い、通知内容は結果として返す。
 * @return {{changed: boolean, feedback: string, fullNotice: boolean}}
 */
function handleJoin_(config, ev, userId, displayName) {
  const participants = listParticipants_(config, ev.eventId);
  const mine = participants.find(function (p) { return p.userId === userId; });
  if (mine) {
    return {
      changed: false,
      feedback: mine.status === PSTATUS.JOINED
        ? ':information_source: すでに参加登録済みです。'
        : ':information_source: すでにキャンセル待ちに登録済みです。空きが出たら自動で繰り上げてDMでお知らせします。'
    };
  }

  const joinedCount = countByStatus_(participants, PSTATUS.JOINED);
  if (joinedCount < ev.capacity) {
    appendParticipant_(config, ev.eventId, userId, displayName, PSTATUS.JOINED);
    return {
      changed: true,
      feedback: ':white_check_mark: 「' + ev.title + '」に参加登録しました（' +
        (joinedCount + 1) + '/' + ev.capacity + '名）',
      // この登録で最後の枠が埋まった場合のみ、スレッドで満席を全体へお知らせ
      fullNotice: joinedCount + 1 === ev.capacity
    };
  }

  const position = countByStatus_(participants, PSTATUS.WAITLIST) + 1;
  appendParticipant_(config, ev.eventId, userId, displayName, PSTATUS.WAITLIST);
  return {
    changed: true,
    feedback: ':hourglass_flowing_sand: 満員のため、キャンセル待ち *' + position + '番目* で受け付けました。\n' +
      '空きが出たら先着順で自動繰り上げし、DMでお知らせします。'
  };
}

/**
 * 「運営として参加」ボタン：師匠・主催者・運営スタッフ用。
 * 定員カウント・キャンセル待ちの対象外として登録するため、満員でも常に参加できる。
 * ロック内で呼ばれるため、シート操作と判定のみを行い、通知内容は結果として返す。
 * すでに一般参加（参加）で登録済みの人が押した場合は運営へ切り替え、
 * 空いた1枠へキャンセル待ちを繰り上げる。
 * @return {{changed: boolean, feedback: string, promoted: ?Object, remainingNotice: ?number}}
 */
function handleJoinStaff_(config, ev, userId, displayName) {
  const result = { changed: false, feedback: '', promoted: null, remainingNotice: null };
  const participants = listParticipants_(config, ev.eventId);
  const mine = participants.find(function (p) { return p.userId === userId; });

  if (mine && mine.status === PSTATUS.STAFF) {
    result.feedback = ':information_source: すでに運営として登録済みです。';
    return result;
  }

  const staffFeedback = ':white_check_mark: 「' + ev.title +
    '」に *運営* として参加登録しました（定員には含みません）。';

  if (!mine) {
    appendParticipant_(config, ev.eventId, userId, displayName, PSTATUS.STAFF);
    result.changed = true;
    result.feedback = staffFeedback;
    return result;
  }

  // 既存の登録（参加 / キャンセル待ち）を運営へ切り替える
  const wasJoined = mine.status === PSTATUS.JOINED;
  setParticipantStatus_(config, ev.eventId, userId, PSTATUS.STAFF);
  result.changed = true;
  result.feedback = staffFeedback;

  // 一般参加の枠を1つ空けた場合のみ、キャンセル待ちを繰り上げる
  if (wasJoined) {
    const joinedAfter = countByStatus_(participants, PSTATUS.JOINED) - 1;
    if (joinedAfter < ev.capacity) {
      result.promoted = promoteFirstWaitlisted_(config, ev.eventId);
      if (!result.promoted && joinedAfter === ev.capacity - 1) {
        result.remainingNotice = ev.capacity - joinedAfter;
      }
    }
  }
  return result;
}

/**
 * 参加者数が定員に達するまでキャンセル待ちを先着順で繰り上げ、本人へDMする。
 * 定員増枠時（フォーム編集）に使用。
 */
function promoteWaitlistedUpToCapacity_(config, ev) {
  while (true) {
    const participants = listParticipants_(config, ev.eventId);
    if (countByStatus_(participants, PSTATUS.JOINED) >= ev.capacity) break;
    const promoted = promoteFirstWaitlisted_(config, ev.eventId);
    if (!promoted) break;
    sendDirectMessage_(
      config, promoted.userId,
      ':tada: 「' + ev.title + '」の定員が増えたため、キャンセル待ちから繰り上がりで参加が確定しました！\n' +
      Utilities.formatDate(ev.start, 'Asia/Tokyo', 'yyyy/MM/dd(EEE) HH:mm') + ' 開始です。'
    );
  }
}

/**
 * 「取り消す」ボタン：登録解除。参加者が抜けた場合はキャンセル待ちを自動繰り上げ。
 * ロック内で呼ばれるため、シート操作と判定のみを行い、通知内容は結果として返す。
 * @return {{changed: boolean, feedback: string, promoted: ?Object, remainingNotice: ?number}}
 */
function handleLeave_(config, ev, userId) {
  const result = { changed: false, feedback: '', promoted: null, remainingNotice: null };

  const before = listParticipants_(config, ev.eventId);
  const mine = before.find(function (p) { return p.userId === userId; });
  if (!mine) {
    result.feedback = ':information_source: 参加登録が見つかりませんでした。';
    return result;
  }

  removeParticipant_(config, ev.eventId, userId);
  result.changed = true;
  result.feedback = ':wave: 「' + ev.title + '」の登録を取り消しました。';

  // キャンセル待ちだった人が抜けただけなら枠は動かない
  if (mine.status !== PSTATUS.JOINED) return result;

  const joinedAfter = countByStatus_(before, PSTATUS.JOINED) - 1;
  // 定員減少後などで参加者数がまだ定員以上の場合は繰り上げ・通知を行わない
  if (joinedAfter >= ev.capacity) return result;

  // 公平な先着順（FIFO）で自動繰り上げ（DM送信はロック外で行う）
  result.promoted = promoteFirstWaitlisted_(config, ev.eventId);
  if (!result.promoted && joinedAfter === ev.capacity - 1) {
    // 満員→空き発生かつ待ちがいない場合のみ、スレッドで全体へお知らせ
    result.remainingNotice = ev.capacity - joinedAfter;
  }
  return result;
}
