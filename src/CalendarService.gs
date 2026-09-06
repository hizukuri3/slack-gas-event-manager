/**
 * CalendarService.gs
 * Googleカレンダー連携（Calendar API 拡張サービス使用）。
 * 開催形式「Google Meet」の場合は conferenceData で Google Meet URL を自動生成する。
 *
 * 無料版Google Meetは3人以上の通話が60分で自動切断されるため、
 * 自動発行かつ60分超のイベントはカレンダー予定を60分ごとに分割登録する。
 * その際、区間ごとに別々のMeet会議を発行する。60分で切れても次の区間は
 * "新品"のURLになるため、クールタイムなしで即入室できる
 * （参加者は次の回のURLへ入り直せばよい）。各区間のURLはLOCATION列に
 * カンマ区切りで保持する。
 */

const MEET_FREE_LIMIT_MINUTES = 60;

/** 開催形式がMeet自動発行かどうか（EVENT_FORMATS の値と完全一致で判定する） */
function isAutoMeet_(format) {
  return String(format).trim() === EVENT_FORMATS.MEET;
}

/** 自動発行Meetで60分を超え、予定の分割が必要かどうか */
function needsMeetSplit_(ev) {
  return isAutoMeet_(ev.format) &&
    (ev.end.getTime() - ev.start.getTime()) > MEET_FREE_LIMIT_MINUTES * 60 * 1000;
}

/** Date → Calendar API 用の dateTime オブジェクト */
function toDateTime_(date) {
  return {
    dateTime: Utilities.formatDate(date, 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ss+09:00"),
    timeZone: 'Asia/Tokyo'
  };
}

/** イベントを60分ごとの区間に分割する（分割不要なら1区間） */
function splitSegments_(ev) {
  if (!needsMeetSplit_(ev)) {
    return [{ start: ev.start, end: ev.end }];
  }
  const segments = [];
  let cursor = new Date(ev.start.getTime());
  while (cursor < ev.end) {
    let segEnd = new Date(cursor.getTime() + MEET_FREE_LIMIT_MINUTES * 60000);
    if (segEnd > ev.end) segEnd = new Date(ev.end.getTime());
    segments.push({ start: cursor, end: segEnd });
    cursor = segEnd;
  }
  return segments;
}

/** 分割時の予定タイトル用ラベル（例:「（2/3）」）。単一予定なら空文字 */
function segmentLabel_(index, total) {
  return total > 1 ? '（' + (index + 1) + '/' + total + '）' : '';
}

/** カンマ区切りで保存しているカレンダーイベントIDを配列に戻す */
function calendarEventIds_(ev) {
  return String(ev.calendarEventId || '').split(',').filter(function (id) { return id !== ''; });
}

/**
 * カレンダー予定を新規作成する（必要に応じて60分ごとに分割）。
 * 自動発行Meetは区間ごとに別々の会議を発行する（meetUrls が区間順のURL配列）。
 * htmlLink は先頭予定のもの（主催者が登録内容を確認するためのリンク）。
 * @return {{calendarEventIds: string[], meetUrls: string[], htmlLink: string}}
 */
function createCalendarEvents_(config, ev) {
  const segments = splitSegments_(ev);
  const ids = [];
  const meetUrls = [];
  let htmlLink = '';

  segments.forEach(function (seg, i) {
    const resource = {
      summary: ev.title + segmentLabel_(i, segments.length),
      start: toDateTime_(seg.start),
      end: toDateTime_(seg.end)
    };
    const options = {};

    if (isAutoMeet_(ev.format)) {
      // 区間ごとに別々のMeet会議を発行する。requestId を区間ごとに一意にすることで
      // それぞれ独立した会議になり、60分で切れても次の区間は待ち時間なしで入室できる。
      resource.conferenceData = {
        createRequest: {
          requestId: ev.eventId + '_' + i,
          conferenceSolutionKey: { type: 'hangoutsMeet' }
        }
      };
      options.conferenceDataVersion = 1;
    } else {
      // 手動URL・オフラインは入力テキストをそのまま「場所」欄へ格納（分割もしない）
      resource.location = ev.location;
    }

    const created = Calendar.Events.insert(resource, config.calendarId, options);
    ids.push(created.id);
    if (isAutoMeet_(ev.format)) {
      meetUrls.push(created.hangoutLink || '');
    }
    if (i === 0) {
      htmlLink = created.htmlLink || '';
    }
  });

  return { calendarEventIds: ids, meetUrls: meetUrls, htmlLink: htmlLink };
}

/** 自動発行Meetの各区間URL（LOCATION列にカンマ区切りで保持）。Meet以外は空配列 */
function meetUrls_(ev) {
  if (!isAutoMeet_(ev.format)) return [];
  return String(ev.location || '').split(',').filter(function (u) { return u !== ''; });
}

/**
 * 分割Meetの「各回の時間＋URL」表示行を組み立てる。
 * 分割なし（単一予定）や非Meetの場合は null を返す（呼び出し側は従来の場所表示を使う）。
 * @return {?string[]} 例: ['第1回 20:00-21:00　https://meet.google.com/xxx', ...]
 */
function meetScheduleLines_(ev) {
  if (!needsMeetSplit_(ev)) return null;
  const urls = meetUrls_(ev);
  return splitSegments_(ev).map(function (seg, i) {
    const time = Utilities.formatDate(seg.start, 'Asia/Tokyo', 'HH:mm') + '-' +
      Utilities.formatDate(seg.end, 'Asia/Tokyo', 'HH:mm');
    return '第' + (i + 1) + '回 ' + time + '　' + (urls[i] || '（URL未取得）');
  });
}

/**
 * 内容変更時のカレンダー更新。
 * 日時・開催形式が変わった場合は全予定を削除して作り直す（分割数の変化に追随。
 * 自動発行の場合はMeet URLも再発行される）。
 * それ以外の変更はタイトル・場所のみを既存予定へパッチする。
 * @return {Object} ev（calendarEventId / location を更新して返す）
 */
function updateCalendarEvents_(config, ev, scheduleChanged) {
  if (scheduleChanged) {
    deleteCalendarEvents_(config, ev);
    const result = createCalendarEvents_(config, ev);
    ev.calendarEventId = result.calendarEventIds.join(',');
    if (isAutoMeet_(ev.format) && result.meetUrls.length) {
      ev.location = result.meetUrls.join(',');
    }
    return ev;
  }

  const ids = calendarEventIds_(ev);
  ids.forEach(function (id, i) {
    const resource = { summary: ev.title + segmentLabel_(i, ids.length) };
    if (!isAutoMeet_(ev.format)) {
      resource.location = ev.location;
    }
    Calendar.Events.patch(resource, config.calendarId, id);
  });
  return ev;
}

/** カレンダー予定の説明欄（Description）を組み立てる */
function buildCalendarDescription_(ev, participantsUrl, slackPermalink) {
  const lines = [];
  if (needsMeetSplit_(ev)) {
    lines.push('※無料版Google Meetの60分制限に合わせ、この予定は60分ごとに分割されています。');
    lines.push('　各回で別々のMeet URLになっています。次の回は次のカレンダー予定を開いてください（待ち時間なしで入れます）。');
    lines.push('');
  }
  lines.push('【概要・対象者】');
  lines.push(ev.description);
  if (ev.preparation) {
    lines.push('');
    lines.push('【事前準備・持ち物・資料リンク】');
    lines.push(ev.preparation);
  }
  if (participantsUrl) {
    lines.push('');
    lines.push('【参加者リアルタイム確認】');
    lines.push(participantsUrl);
  }
  if (slackPermalink) {
    lines.push('');
    lines.push('【Slack告知メッセージ】');
    lines.push(slackPermalink);
  }
  return lines.join('\n');
}

/** 全予定の説明欄を書き込む */
function patchCalendarDescriptions_(config, ev, description) {
  calendarEventIds_(ev).forEach(function (id) {
    Calendar.Events.patch({ description: description }, config.calendarId, id);
  });
}

/** カレンダー予定をすべて削除する（イベント中止・作り直し時） */
function deleteCalendarEvents_(config, ev) {
  calendarEventIds_(ev).forEach(function (id) {
    try {
      Calendar.Events.remove(config.calendarId, id);
    } catch (err) {
      // 既に削除済みの場合などは無視して処理を続行
      console.warn('カレンダー予定の削除に失敗: ' + err);
    }
  });
}
