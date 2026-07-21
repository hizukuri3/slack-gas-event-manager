/**
 * Repository.gs
 * スプレッドシート（管理用①・公開用②）への読み書きを担当する。
 * 書き込み系は必ず管理用・公開用の両方へ同じ内容を反映する（②は①のミラー）。
 */

/** 管理用・公開用の両スプレッドシートを開いて返す */
function openSpreadsheets_(config) {
  return [
    SpreadsheetApp.openById(config.managementSpreadsheetId),
    SpreadsheetApp.openById(config.publicSpreadsheetId)
  ];
}

/** シートを取得。無ければヘッダー付きで作成する */
function getOrCreateSheet_(spreadsheet, name, header) {
  let sheet = spreadsheet.getSheetByName(name);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(name);
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** 初回セットアップ：両スプレッドシートに2シートを作成する（手動実行用） */
function initializeSheets() {
  const config = getConfig_();
  openSpreadsheets_(config).forEach(function (ss) {
    getOrCreateSheet_(ss, SHEET_EVENT_MASTER, EVENT_MASTER_HEADER);
    getOrCreateSheet_(ss, SHEET_PARTICIPANTS, PARTICIPANTS_HEADER);
  });
}

// ==================== イベントマスター ====================

/** イベントオブジェクト → シート1行の配列に変換 */
function eventToRow_(ev) {
  const row = new Array(EVENT_MASTER_HEADER.length).fill('');
  row[COL.EVENT_ID] = ev.eventId;
  row[COL.RESPONSE_ID] = ev.responseId;
  row[COL.TITLE] = ev.title;
  row[COL.ORGANIZER] = ev.organizer;
  row[COL.START] = ev.start;
  row[COL.END] = ev.end;
  row[COL.CAPACITY] = ev.capacity;
  row[COL.STATUS] = ev.status;
  row[COL.FORMAT] = ev.format;
  row[COL.LOCATION] = ev.location;
  row[COL.DESCRIPTION] = ev.description;
  row[COL.PREPARATION] = ev.preparation;
  row[COL.CALENDAR_EVENT_ID] = ev.calendarEventId;
  row[COL.SLACK_CHANNEL] = ev.slackChannel;
  // Slackのts（例: 1784563559.123456）はシートに数値として解釈されると
  // 小数部の桁が失われ、chat.update が message_not_found になる。
  // 先頭にアポストロフィを付けて必ず「文字列」として保存する（表示・読み出しには含まれない）
  row[COL.SLACK_TS] = ev.slackTs ? "'" + ev.slackTs : '';
  row[COL.EDIT_URL] = ev.editUrl;
  row[COL.CREATED_AT] = ev.createdAt;
  row[COL.UPDATED_AT] = ev.updatedAt;
  row[COL.TYPE] = ev.type || EVENT_TYPE.DISCIPLE;
  return row;
}

/** シート1行の配列 → イベントオブジェクトに変換 */
function rowToEvent_(row) {
  return {
    eventId: row[COL.EVENT_ID],
    responseId: row[COL.RESPONSE_ID],
    title: row[COL.TITLE],
    organizer: row[COL.ORGANIZER],
    start: new Date(row[COL.START]),
    end: new Date(row[COL.END]),
    capacity: Number(row[COL.CAPACITY]),
    status: row[COL.STATUS],
    format: row[COL.FORMAT],
    location: row[COL.LOCATION],
    description: row[COL.DESCRIPTION],
    preparation: row[COL.PREPARATION],
    calendarEventId: row[COL.CALENDAR_EVENT_ID],
    slackChannel: String(row[COL.SLACK_CHANNEL]),
    slackTs: String(row[COL.SLACK_TS]),
    editUrl: row[COL.EDIT_URL],
    createdAt: row[COL.CREATED_AT],
    updatedAt: row[COL.UPDATED_AT],
    type: row[COL.TYPE] || EVENT_TYPE.DISCIPLE
  };
}

/**
 * 「師匠イベント」かどうか。
 * 判定は種別列（=どちらのフォームから登録されたか）のみで一意に決まる。
 */
function isMasterEvent_(ev) {
  return ev.type === EVENT_TYPE.MASTER;
}

/**
 * 公開用スプレッドシートへ書き込む行を返す。
 * 弟子イベントは性善説運用として編集用URLも含めて全列ミラーする
 * （主催者がDMを紛失しても公開シートから自力で参照できるようにする意図的な設計）。
 * 師匠イベントだけは、弟子に編集されないよう回答編集用URLを空欄にする。
 */
function rowForPublic_(config, ev, row) {
  if (!isMasterEvent_(ev)) return row;
  const masked = row.slice();
  masked[COL.EDIT_URL] = '';
  return masked;
}

/** イベントを管理用・公開用の両方へ新規追記する */
function insertEvent_(config, ev) {
  const row = eventToRow_(ev);
  openSpreadsheets_(config).forEach(function (ss, index) {
    const sheet = getOrCreateSheet_(ss, SHEET_EVENT_MASTER, EVENT_MASTER_HEADER);
    sheet.appendRow(index === 0 ? row : rowForPublic_(config, ev, row));
  });
}

/** イベントIDをキーに両スプレッドシートの行を上書き更新する */
function updateEvent_(config, ev) {
  const row = eventToRow_(ev);
  openSpreadsheets_(config).forEach(function (ss, index) {
    const sheet = getOrCreateSheet_(ss, SHEET_EVENT_MASTER, EVENT_MASTER_HEADER);
    const values = sheet.getDataRange().getValues();
    for (let i = 1; i < values.length; i++) {
      if (values[i][COL.EVENT_ID] === ev.eventId) {
        sheet.getRange(i + 1, 1, 1, EVENT_MASTER_HEADER.length)
          .setValues([index === 0 ? row : rowForPublic_(config, ev, row)]);
        break;
      }
    }
  });
}

/** 条件に一致する最初のイベントを管理用シートから探す */
function findEvent_(config, predicate) {
  const ss = SpreadsheetApp.openById(config.managementSpreadsheetId);
  const sheet = ss.getSheetByName(SHEET_EVENT_MASTER);
  if (!sheet) return null;
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    const ev = rowToEvent_(values[i]);
    if (predicate(ev)) return ev;
  }
  return null;
}

/** フォーム回答IDでイベントを検索（回答編集の照合に使用） */
function findEventByResponseId_(config, responseId) {
  return findEvent_(config, function (ev) { return ev.responseId === responseId; });
}

/** Slackのチャンネル+メッセージtsでイベントを検索（リアクション処理に使用） */
function findEventByMessage_(config, channel, ts) {
  return findEvent_(config, function (ev) {
    return ev.slackChannel === channel && ev.slackTs === ts;
  });
}

/** イベントIDでイベントを検索（Webアプリ表示に使用） */
function findEventById_(config, eventId) {
  return findEvent_(config, function (ev) { return ev.eventId === eventId; });
}

// ==================== 参加者リスト ====================
// 参加者リストの書き込みは管理用スプレッドシートのみに行う（ボタン応答の高速化のため）。
// 公開用へは syncPublicSheets（5分毎の時間トリガー）が丸ごと同期する。

/** 公開用シートの同期が必要であることを記録する */
function markPublicSyncDirty_() {
  PropertiesService.getScriptProperties().setProperty('PUBLIC_SYNC_DIRTY', '1');
}

/** 参加者（またはキャンセル待ち）を管理用シートへ1行追記する */
function appendParticipant_(config, eventId, userId, displayName, status) {
  const ss = SpreadsheetApp.openById(config.managementSpreadsheetId);
  const sheet = getOrCreateSheet_(ss, SHEET_PARTICIPANTS, PARTICIPANTS_HEADER);
  sheet.appendRow([eventId, userId, displayName, status, new Date()]);
  markPublicSyncDirty_();
}

/**
 * 管理用シートから該当参加者の行を検索して1行削除する。
 * @return {boolean} 削除が発生したか
 */
function removeParticipant_(config, eventId, userId) {
  const ss = SpreadsheetApp.openById(config.managementSpreadsheetId);
  const sheet = ss.getSheetByName(SHEET_PARTICIPANTS);
  if (!sheet) return false;
  const values = sheet.getDataRange().getValues();
  for (let i = values.length - 1; i >= 1; i--) {
    if (values[i][0] === eventId && values[i][1] === userId) {
      sheet.deleteRow(i + 1);
      markPublicSyncDirty_();
      return true;
    }
  }
  return false;
}

/** 対象イベントの参加者・キャンセル待ち（登録順）を返す */
function listParticipants_(config, eventId) {
  const ss = SpreadsheetApp.openById(config.managementSpreadsheetId);
  const sheet = ss.getSheetByName(SHEET_PARTICIPANTS);
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  const result = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === eventId) {
      result.push({
        userId: values[i][1],
        displayName: values[i][2],
        status: values[i][3],
        registeredAt: values[i][4]
      });
    }
  }
  return result;
}

/** 状態でフィルタした人数を数える */
function countByStatus_(participants, status) {
  return participants.filter(function (p) { return p.status === status; }).length;
}

/**
 * 対象参加者の状態列を書き換える（例: 参加→運営 への切り替え）。
 * @return {boolean} 更新が発生したか
 */
function setParticipantStatus_(config, eventId, userId, status) {
  const statusColumn = PARTICIPANTS_HEADER.indexOf('状態') + 1;
  const sheet = SpreadsheetApp.openById(config.managementSpreadsheetId)
    .getSheetByName(SHEET_PARTICIPANTS);
  if (!sheet) return false;
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === eventId && values[i][1] === userId) {
      sheet.getRange(i + 1, statusColumn).setValue(status);
      markPublicSyncDirty_();
      return true;
    }
  }
  return false;
}

/**
 * キャンセル待ちの先頭（登録が最も早い人）を「参加」へ繰り上げる。
 * @return {?Object} 繰り上げた参加者。待ちがいなければ null
 */
function promoteFirstWaitlisted_(config, eventId) {
  const first = listParticipants_(config, eventId).find(function (p) {
    return p.status === PSTATUS.WAITLIST;
  });
  if (!first) return null;

  const statusColumn = PARTICIPANTS_HEADER.indexOf('状態') + 1;
  const sheet = SpreadsheetApp.openById(config.managementSpreadsheetId)
    .getSheetByName(SHEET_PARTICIPANTS);
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === eventId && values[i][1] === first.userId) {
      sheet.getRange(i + 1, statusColumn).setValue(PSTATUS.JOINED);
      break;
    }
  }
  markPublicSyncDirty_();
  first.status = PSTATUS.JOINED;
  return first;
}

// ==================== 公開用シートへの定期同期 ====================

/**
 * 参加者リストを管理用→公開用へ丸ごと同期する（5分毎の時間トリガーで実行）。
 * 変更フラグが立っていない場合は即終了する。
 * ヘッダーごと全行を上書きするため、過去に同期が失敗していても次回実行で必ず一致する（自己修復）。
 */
function syncPublicSheets() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('PUBLIC_SYNC_DIRTY') !== '1') return;
  // 先にフラグを消す（同期中に新たな書き込みがあれば再度立ち、次回実行で拾われる）
  props.deleteProperty('PUBLIC_SYNC_DIRTY');

  const config = getConfig_();
  const source = SpreadsheetApp.openById(config.managementSpreadsheetId)
    .getSheetByName(SHEET_PARTICIPANTS);
  const target = getOrCreateSheet_(
    SpreadsheetApp.openById(config.publicSpreadsheetId),
    SHEET_PARTICIPANTS, PARTICIPANTS_HEADER
  );
  const values = source
    ? source.getDataRange().getValues()
    : [PARTICIPANTS_HEADER];
  target.clearContents();
  target.getRange(1, 1, values.length, values[0].length).setValues(values);
}
