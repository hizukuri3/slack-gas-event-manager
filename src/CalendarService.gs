/**
 * CalendarService.gs
 * Googleカレンダー連携（Calendar API 拡張サービス使用）。
 * 開催形式「オンライン・自動発行」の場合は conferenceData で Google Meet URL を自動生成する。
 *
 * 無料版Google Meetは3人以上の通話が60分で自動切断されるため、
 * 自動発行かつ60分超のイベントはカレンダー予定を60分ごとに分割登録する。
 * その際、Meet URLは先頭予定の会議情報を全区間へコピーして共通化する
 * （参加者は同じURLに再入室すればよい）。
 */

const MEET_FREE_LIMIT_MINUTES = 60;

/** 開催形式がMeet自動発行かどうか */
function isAutoMeet_(format) {
  return String(format).indexOf('自動発行') !== -1;
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
 * htmlLink は先頭予定のもの（主催者が登録内容を確認するためのリンク）。
 * @return {{calendarEventIds: string[], meetUrl: string, htmlLink: string}}
 */
function createCalendarEvents_(config, ev) {
  const segments = splitSegments_(ev);
  const ids = [];
  let meetUrl = '';
  let htmlLink = '';
  let sharedConferenceData = null;

  segments.forEach(function (seg, i) {
    const resource = {
      summary: ev.title + segmentLabel_(i, segments.length),
      start: toDateTime_(seg.start),
      end: toDateTime_(seg.end)
    };
    const options = {};

    if (isAutoMeet_(ev.format)) {
      if (i === 0) {
        // 先頭区間でMeet会議を新規発行
        resource.conferenceData = {
          createRequest: {
            requestId: ev.eventId,
            conferenceSolutionKey: { type: 'hangoutsMeet' }
          }
        };
      } else {
        // 2区間目以降は先頭の会議情報をコピーして同一Meet URLを使い回す
        resource.conferenceData = sharedConferenceData;
      }
      options.conferenceDataVersion = 1;
    } else {
      // 手動URL・オフラインは入力テキストをそのまま「場所」欄へ格納（分割もしない）
      resource.location = ev.location;
    }

    const created = Calendar.Events.insert(resource, config.calendarId, options);
    ids.push(created.id);
    if (i === 0) {
      meetUrl = created.hangoutLink || '';
      htmlLink = created.htmlLink || '';
      sharedConferenceData = created.conferenceData || null;
    }
  });

  return { calendarEventIds: ids, meetUrl: meetUrl, htmlLink: htmlLink };
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
    if (isAutoMeet_(ev.format) && result.meetUrl) {
      ev.location = result.meetUrl;
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
    lines.push('※無料版Google Meetの制限により60分ごとに接続が切れます。');
    lines.push('　切れたら同じMeet URLから再入室してください（URLは全予定共通）。');
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
