/**
 * ReminderService.gs
 * 開催前リマインドを参加者へDMで送る（1時間毎の時間主導トリガー）。
 *
 * Googleカレンダー側の通知（reminders）は予定を作成したアカウント本人にしか効かず、
 * 参加者へ届けるにはゲスト招待＝メールアドレスの取得が必要になる。
 * 参加者のメールアドレスを一切扱わない方針のため、リマインドはSlack側で完結させる。
 *
 * 送信タイミングは2回。時間主導トリガーの発火時刻には数分〜十数分のゆらぎがあるため、
 * 「ちょうどN時間前」ではなく幅を持たせた条件で判定し、
 * 送信済みフラグ（スクリプトプロパティ）で二重送信を防ぐ。
 */

// 前日リマインドを送る時刻（この時刻以降の実行で、翌日開催のイベントを対象にする）
const REMINDER_PREV_DAY_HOUR = 20;
// 直前リマインドを送る猶予（開始までの残り時間がこれ以下になったら送る）
const REMINDER_BEFORE_MINUTES = 90;
// 送信済みフラグのプロパティキー接頭辞
const REMINDER_PROP_PREFIX = 'RMD_';

// リマインドの種類
const REMINDER_KIND = {
  PREV_DAY: 'prevday',  // 前日の夜
  BEFORE: 'before'      // 開催直前
};

/**
 * 開催前リマインドの送信（1時間毎の時間主導トリガーから呼ばれる）。
 * 中止・終了済みのイベントは対象外。キャンセル待ちの人へは送らない
 * （参加が確定していないため。繰り上がった時点で別途DMが飛ぶ）。
 */
function sendEventReminders() {
  const config = getConfig_();
  const now = new Date();
  const props = PropertiesService.getScriptProperties();
  // getProperty() の逐次呼び出しは通信が都度発生するため、まとめて1回で読む
  const sent = props.getProperties();

  // シート読み込みは1回だけにして、対象の絞り込みはメモリ上で行う
  const allEvents = listEvents_(config, null);
  const upcoming = allEvents.filter(function (ev) {
    return !isCancelledStatus_(ev.status) && ev.start.getTime() > now.getTime();
  });

  upcoming.forEach(function (ev) {
    [REMINDER_KIND.PREV_DAY, REMINDER_KIND.BEFORE].forEach(function (kind) {
      const key = reminderPropKey_(ev.eventId, kind);
      if (sent[key]) return;
      if (!isReminderDue_(ev, kind, now)) return;
      sendReminderFor_(config, ev, kind);
      props.setProperty(key, String(now.getTime()));
    });
  });

  purgeReminderFlags_(props, sent, allEvents, now);
}

/** 送信済みフラグのプロパティキー */
function reminderPropKey_(eventId, kind) {
  return REMINDER_PROP_PREFIX + eventId + '_' + kind;
}

/** 今このリマインドを送るべきかどうか */
function isReminderDue_(ev, kind, now) {
  if (kind === REMINDER_KIND.BEFORE) {
    const remainingMinutes = (ev.start.getTime() - now.getTime()) / 60000;
    return remainingMinutes <= REMINDER_BEFORE_MINUTES;
  }
  // 前日リマインド: 「実行時点の翌日」に開催するイベントを、20時以降の実行で送る
  if (now.getHours() < REMINDER_PREV_DAY_HOUR) return false;
  const tomorrow = new Date(now.getTime());
  tomorrow.setDate(tomorrow.getDate() + 1);
  return isSameDate_(ev.start, tomorrow);
}

/** 年月日が同じ日かどうか */
function isSameDate_(a, b) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

/** 対象イベントの参加者・運営へリマインドDMを送る */
function sendReminderFor_(config, ev, kind) {
  const targets = listParticipants_(config, ev.eventId).filter(function (p) {
    return p.status === PSTATUS.JOINED || p.status === PSTATUS.STAFF;
  });
  if (targets.length === 0) return;

  const permalink = ev.slackTs ? getPermalink_(config, ev.slackChannel, ev.slackTs) : '';
  const text = buildReminderText_(config, ev, kind, permalink);
  targets.forEach(function (p) {
    sendDirectMessage_(config, p.userId, text);
  });
}

/** リマインドDMの本文を組み立てる */
function buildReminderText_(config, ev, kind, permalink) {
  const lines = [];
  if (kind === REMINDER_KIND.PREV_DAY) {
    lines.push(':bell: *明日はイベント「' + ev.title + '」の開催日です*');
  } else {
    lines.push(':bell: *まもなくイベント「' + ev.title + '」が始まります*');
  }
  lines.push(':calendar: ' + formatDateRange_(ev.start, ev.end));
  lines.push(':round_pushpin: ' + (ev.location || '（未定）'));
  lines.push(':bust_in_silhouette: 主催: <@' + ev.organizer + '>');

  if (kind === REMINDER_KIND.PREV_DAY && ev.preparation) {
    lines.push('');
    lines.push('*事前準備・持ち物・資料リンク*');
    lines.push(ev.preparation);
  }
  if (needsMeetSplit_(ev)) {
    lines.push('');
    lines.push(':bulb: 無料版Meetのため60分ごとに接続が切れます。切れたら同じURLから再入室してください。');
  }
  if (permalink) {
    lines.push('');
    lines.push('▶ 告知を見る: ' + permalink);
  }
  if (kind === REMINDER_KIND.PREV_DAY) {
    lines.push('都合が悪くなった場合は、告知メッセージの「取り消す」ボタンからキャンセルしてください' +
      '（キャンセル待ちの方へ枠をお譲りできます）。');
  }
  return lines.join('\n');
}

/**
 * 終了済みイベントの送信済みフラグを削除する。
 * スクリプトプロパティは件数・容量に上限があるため、放置せず毎回掃除する。
 */
function purgeReminderFlags_(props, sent, allEvents, now) {
  const aliveIds = {};
  allEvents.forEach(function (ev) {
    if (ev.end.getTime() > now.getTime()) aliveIds[ev.eventId] = true;
  });

  Object.keys(sent).forEach(function (key) {
    if (key.indexOf(REMINDER_PROP_PREFIX) !== 0) return;
    const eventId = key.substring(REMINDER_PROP_PREFIX.length).replace(/_[^_]+$/, '');
    if (!aliveIds[eventId]) props.deleteProperty(key);
  });
}
