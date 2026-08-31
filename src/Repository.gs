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

/**
 * 既存シートの見出し行を定義に合わせ直す。
 *
 * getOrCreateSheet_ が見出しを書くのはシートを新規作成したときだけなので、
 * 列を追加してもすでに動いているインスタンスには反映されない。データは
 * 列番号で読み書きしていて支障なく動いてしまうぶん、見出しだけが古いまま
 * 残り、シートを開いた人が「この列は何か」を判断できなくなる。
 * setupEnabledColumn_ が「有効」列の見出しで同じ手当てをしているのと同じ趣旨。
 *
 * 対象はシステムが書くシートに限る。人が編集するシートで勝手に見出しを
 * 戻すと、運営が意図して直した文言を上書きしてしまう。
 */
function ensureHeader_(sheet, header) {
  const current = sheet.getRange(1, 1, 1, header.length).getValues()[0];
  const matches = header.every(function (label, i) { return current[i] === label; });
  if (matches) return;
  sheet.getRange(1, 1, 1, header.length).setValues([header]);
}

/**
 * 人が編集するシートの「有効」列に、見出しとドロップダウンを設定する。
 * 「絵文字転送マッピング」と「師匠リスト」で共通の処理。
 *
 * ★ データ行のセルには一切書き込まない ★
 * 空欄が有効を意味することは見出しで伝える。空欄へ「有効」と書き込めば
 * 見た目は分かりやすくなるが、人が書くシートにシステムが値を入れることになり、
 * 自分が書いていない文字がシートに現れる。ヘッダー行はもともと
 * getOrCreateSheet_ が作る行なので、そこで伝えるぶんには筋が通る。
 *
 * チェックボックスにしないのは、空欄と「オフ」を見た目で区別できず、
 * 行のコピーで意図せず外れる余地もあるため。
 *
 * @param {Sheet} sheet 対象シート
 * @param {number} enabledColumn 「有効」列（0始まり）
 */
function setupEnabledColumn_(sheet, enabledColumn) {
  // 見出しが書かれるのは getOrCreateSheet_ のシート作成時だけなので、
  // 文言を変えても既存シートには反映されない。ここで追随させる
  const headerCell = sheet.getRange(1, enabledColumn + 1);
  if (headerCell.getValue() !== ENABLED_HEADER) headerCell.setValue(ENABLED_HEADER);

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  // 候補以外の入力を弾く（「休止」「オフ」等と書いて止めたつもりになるのを防ぐ）。
  // ただし貼り付けは入力規則ごとセルを上書きするため、これだけでは防ぎきれない。
  // すり抜けた値は classifyEnabledFlag_ が判定不能として拾い、運営へ知らせる。
  // 同期のたびにここで貼り直すので、消された入力規則は次の編集で自動的に戻る。
  //
  // 検証範囲を1行だけ余分に広げているのは、新しく足す行にも最初から
  // ドロップダウンを効かせるため。行が増えてから設定したのでは、
  // その行の「有効」欄へ先に手入力されたときに素通りしてしまう
  sheet.getRange(2, enabledColumn + 1, lastRow, 1).setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInList(ENABLED_CHOICES, true)
      .setAllowInvalid(false)
      .build()
  );
}

// ==================== 管理用スプレッドシートのトリガー ====================
// 人が管理用①を編集したときの入口。GAS自身の書き込みでは発火しないため、
// 参加者リストなどへのシステム更新でここが呼ばれることはない。

/**
 * 編集トリガー（setupTriggers で登録）：セルの値の変更を拾う。
 * 入力・貼り付け・クリア・元に戻す が該当する。
 */
function onManagementSpreadsheetEdit(e) {
  if (!e || !e.range) return;
  const name = e.range.getSheet().getName();

  if (name === SHEET_MASTER_LIST) {
    // 師匠リストは編集内容をスクリプトプロパティへ反映する必要がある
    notifyMasterListSync_(e.source, syncMasterList());
    return;
  }
  if (name === SHEET_RELAY_MAPPING) {
    // 転送マッピングはリアクションの都度シートを直接読むので反映処理は不要。
    // 入力規則だけ師匠リストと揃える（トーストは出さない。
    // 反映結果という報せるべき中身が無く、毎回出しても雑音にしかならないため）
    setupEnabledColumn_(e.range.getSheet(), RELAY_COL.ENABLED);
    return;
  }
  if (name === SHEET_VC_ROOMS) {
    // 部屋の在庫は割り当てのたびに読み直すので、プロパティへの反映は不要。
    // ただしフォームの「VC部屋」の選択肢はこのシートが正なので、ここで追随させる。
    // 部屋を1行足したらフォームでも選べるようになる、を成立させるための処理
    setupEnabledColumn_(e.range.getSheet(), VC_ROOM_COL.ENABLED);
    notifyVcRoomSync_(e.source, syncVcRoomChoices());
  }
}

/**
 * 変更トリガー（setupTriggers で登録）：行・シートの削除を拾う。
 *
 * onEdit は「セルの値の変更」でしか発火しないため、行を削除しても動かない。
 * 師匠を外すのに行ごと削除するのは自然な操作なので、これが無いと
 * 「消したのに効かない」（しかもトーストも出ない）という一番たちの悪い形になる。
 * シートごと削除された場合も、ここで検知して反映を中止する。
 *
 * 対象は師匠リストとVCルームリスト。どちらも「シートの外に持っている状態」
 * （スクリプトプロパティ / フォームの選択肢）があるため、行が消えたら
 * そちらも追随させないと辻褄が合わなくなる。転送マッピングは行が消えれば
 * ルールが消えるだけで、別に持っている状態が無いので追随の必要がない。
 *
 * onChange はどのシートが変わったかを教えてくれないため、行削除については
 * 操作した本人が開いているシートで判定する。シート削除（REMOVE_GRID）は
 * 削除後に別のシートが開かれるので、その判定はできず両方の同期を試みる。
 */
function onManagementSpreadsheetChange(e) {
  if (!e || !e.source) return;
  const type = e.changeType;

  if (type === 'REMOVE_ROW') {
    const active = e.source.getActiveSheet();
    const name = active ? active.getName() : '';
    if (name === SHEET_MASTER_LIST) {
      notifyMasterListSync_(e.source, syncMasterList());
    } else if (name === SHEET_VC_ROOMS) {
      notifyVcRoomSync_(e.source, syncVcRoomChoices());
    }
    return;
  }
  if (type !== 'REMOVE_GRID') return;
  notifyMasterListSync_(e.source, syncMasterList());
  notifyVcRoomSync_(e.source, syncVcRoomChoices());
}

/** 初回セットアップ：必要なシートを作成する（手動実行用） */
function initializeSheets() {
  const config = getConfig_();
  openSpreadsheets_(config).forEach(function (ss) {
    // システムが書くシートなので、列が増えたときは見出しも追随させる
    ensureHeader_(getOrCreateSheet_(ss, SHEET_EVENT_MASTER, EVENT_MASTER_HEADER),
      EVENT_MASTER_HEADER);
    ensureHeader_(getOrCreateSheet_(ss, SHEET_PARTICIPANTS, PARTICIPANTS_HEADER),
      PARTICIPANTS_HEADER);
  });

  // 次の4シートは管理用①にのみ作る。
  // イベントの参加状況とは無関係な運用設定・内部ログなので公開用②へは出さない。
  const management = SpreadsheetApp.openById(config.managementSpreadsheetId);
  const relayMapping = getOrCreateSheet_(management, SHEET_RELAY_MAPPING, RELAY_MAPPING_HEADER);
  getOrCreateSheet_(management, SHEET_RELAY_LOG, RELAY_LOG_HEADER);
  getOrCreateSheet_(management, SHEET_MASTER_LIST, MASTER_LIST_HEADER);
  // Discord VCの在庫台帳。空のままでも他の機能には影響しない
  // （開催形式でDiscord VCを選んだときだけ参照される）
  const vcRooms = getOrCreateSheet_(management, SHEET_VC_ROOMS, VC_ROOM_HEADER);

  // 「有効」列を持つ人編集シートは、編集トリガー経由でしか整えられないため
  // ここで一度通しておく。でないと、誰かがそのシートを編集するまで
  // 見出しもドロップダウンも入らない
  // （師匠リストは、この直後に呼ばれる syncMasterList が受け持つ）
  setupEnabledColumn_(relayMapping, RELAY_COL.ENABLED);
  setupEnabledColumn_(vcRooms, VC_ROOM_COL.ENABLED);
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
  row[COL.VC_ROOM] = ev.vcRoom || '';
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
    type: row[COL.TYPE] || EVENT_TYPE.DISCIPLE,
    // VCルーム列を持たない時代の行は undefined になるので空文字へ倒す。
    // ここを省くと vcRoomsInUse_ の判定で undefined が紛れ込む
    vcRoom: String(row[COL.VC_ROOM] || '')
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

/**
 * 条件に一致するイベントを全件返す。
 * VC部屋の被り判定のように「最初の1件」では足りない用途で使う
 * （同じ時間帯に何部屋押さえられているかを知る必要があるため）。
 */
function filterEvents_(config, predicate) {
  const sheet = SpreadsheetApp.openById(config.managementSpreadsheetId)
    .getSheetByName(SHEET_EVENT_MASTER);
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  const found = [];
  for (let i = 1; i < values.length; i++) {
    const ev = rowToEvent_(values[i]);
    if (predicate(ev)) found.push(ev);
  }
  return found;
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
