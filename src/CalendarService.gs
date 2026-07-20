/**
 * CalendarService.gs
 * Googleカレンダー連携（Calendar API 拡張サービス使用）。
 * 開催形式「オンライン・自動発行」の場合は conferenceData で Google Meet URL を自動生成する。
 */

/** 開催形式がMeet自動発行かどうか */
function isAutoMeet_(format) {
  return String(format).indexOf('自動発行') !== -1;
}

/** Date → Calendar API 用の dateTime オブジェクト */
function toDateTime_(date) {
  return {
    dateTime: Utilities.formatDate(date, 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ss+09:00"),
    timeZone: 'Asia/Tokyo'
  };
}

/**
 * カレンダー予定を新規作成する。
 * @return {{calendarEventId: string, meetUrl: string}}
 */
function createCalendarEvent_(config, ev) {
  const resource = {
    summary: ev.title,
    start: toDateTime_(ev.start),
    end: toDateTime_(ev.end)
  };
  const options = {};

  if (isAutoMeet_(ev.format)) {
    // Meet URLの自動発行：予定作成と同時に一意のMeet会議を生成・紐付け
    resource.conferenceData = {
      createRequest: {
        requestId: ev.eventId,
        conferenceSolutionKey: { type: 'hangoutsMeet' }
      }
    };
    options.conferenceDataVersion = 1;
  } else {
    // 手動URL・オフラインは入力テキストをそのまま「場所」欄へ格納
    resource.location = ev.location;
  }

  const created = Calendar.Events.insert(resource, config.calendarId, options);
  return {
    calendarEventId: created.id,
    meetUrl: created.hangoutLink || ''
  };
}

/** カレンダー予定の説明欄（Description）を組み立てる */
function buildCalendarDescription_(ev, participantsUrl, slackPermalink) {
  const lines = [];
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

/** カレンダー予定を更新する（内容変更時） */
function updateCalendarEvent_(config, ev, participantsUrl, slackPermalink) {
  const resource = {
    summary: ev.title,
    start: toDateTime_(ev.start),
    end: toDateTime_(ev.end),
    description: buildCalendarDescription_(ev, participantsUrl, slackPermalink),
    location: isAutoMeet_(ev.format) ? '' : ev.location
  };
  Calendar.Events.patch(resource, config.calendarId, ev.calendarEventId);
}

/** カレンダー予定の説明欄だけを後から書き込む（新規作成の仕上げに使用） */
function patchCalendarDescription_(config, calendarEventId, description) {
  Calendar.Events.patch({ description: description }, config.calendarId, calendarEventId);
}

/** カレンダー予定を削除する（イベント中止時） */
function deleteCalendarEvent_(config, calendarEventId) {
  try {
    Calendar.Events.remove(config.calendarId, calendarEventId);
  } catch (err) {
    // 既に削除済みの場合などは無視して処理を続行
    console.warn('カレンダー予定の削除に失敗: ' + err);
  }
}
