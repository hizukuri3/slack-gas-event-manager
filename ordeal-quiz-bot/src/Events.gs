/**
 * Events.gs
 * Slack Events API の受け口（ウェブアプリとしてデプロイして使う）。
 * 出題メッセージに設定シートの REACTION_EMOJI（既定: tabutta）が付けられた／外されたら、
 * 「リアクション」シートに1人×1メッセージを1行で記録する（追加日時／外されたら削除日時）。
 */

const SHEET_REACTIONS = 'リアクション';
// リアクションシート：1人×1メッセージにつき1行。外されたら削除日時を入れる（空欄＝現在もリアクション中）
const REACTION_COL = { ADDED_AT: 0, REMOVED_AT: 1, USER: 2, MESSAGE_TS: 8 };
const REACTION_HEADERS = ['追加日時', '削除日時', 'ユーザーID', '絵文字', '問題番号', 'Ord No', 'Q No', '出題日時', 'メッセージTS'];

function doPost(e) {
  const body = JSON.parse(e.postData.contents);

  // Event Subscriptions の Request URL 登録時の確認
  if (body.type === 'url_verification') {
    return ContentService.createTextOutput(body.challenge);
  }
  if (body.type !== 'event_callback') return ok_();

  // Slackの再送（リトライ）で同じイベントが届いても1回だけ処理する
  const cache = CacheService.getScriptCache();
  if (body.event_id) {
    if (cache.get(body.event_id)) return ok_();
    cache.put(body.event_id, '1', 21600);
  }

  const event = body.event || {};
  if (event.type !== 'reaction_added' && event.type !== 'reaction_removed') return ok_();

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    recordReaction_(event);
  } catch (err) {
    console.error('リアクションの記録に失敗しました: ' + err);
  } finally {
    lock.releaseLock();
  }
  return ok_();
}

function ok_() {
  return ContentService.createTextOutput('ok');
}

/** 対象の絵文字・出題メッセージへのリアクションだけを記録する */
function recordReaction_(event) {
  const config = getConfig_();
  const settings = config.settings;
  // カンマ区切りで複数指定できる（例: タブった,tabutta）。前後の : は無視する
  const emojis = String(settings.REACTION_EMOJI || 'タブった,tabutta')
    .split(/[,、]/)
    .map(function (s) { return s.trim().replace(/^:|:$/g, ''); })
    .filter(function (s) { return s; });
  console.log('reaction受信: ' + JSON.stringify({ type: event.type, reaction: event.reaction, item: event.item }));
  if (emojis.indexOf(event.reaction) === -1) {
    console.log('対象外の絵文字のためスキップ: ' + event.reaction + '（設定: ' + emojis.join(',') + '）');
    return;
  }

  const item = event.item || {};
  if (item.type !== 'message' || item.channel !== config.slackChannelId) {
    console.log('対象外のチャンネル／種類のためスキップ: ' + item.channel);
    return;
  }

  const spreadsheet = SpreadsheetApp.openById(config.spreadsheetId);
  const question = findQuestionByTs_(spreadsheet, item.ts);
  if (!question) { // 出題メッセージ以外へのリアクションは記録しない
    console.log('出題メッセージが見つからないためスキップ: ts=' + item.ts);
    return;
  }

  const sheet = getOrCreateReactionSheet_(spreadsheet);
  const eventAt = new Date(Number(event.event_ts) * 1000);

  if (event.type === 'reaction_removed') {
    // 同じ人・同じメッセージの、まだ削除されていない行に削除日時を入れる
    const values = sheet.getDataRange().getValues();
    for (let i = values.length - 1; i >= 1; i--) {
      const row = values[i];
      if (row[REACTION_COL.USER] === event.user &&
          String(row[REACTION_COL.MESSAGE_TS]) === String(item.ts) &&
          !row[REACTION_COL.REMOVED_AT]) {
        sheet.getRange(i + 1, REACTION_COL.REMOVED_AT + 1).setValue(eventAt);
        return;
      }
    }
    console.log('削除対象の行が見つかりません: user=' + event.user + ' ts=' + item.ts);
    return;
  }

  // reaction_added: 1人1メッセージにつき1行。削除後に付け直した場合は新しい行になる
  const match = question.number.match(/Ord\s*(\d+)\s*-\s*Q\s*(\d+)/i);
  sheet.appendRow([
    eventAt,
    '',
    event.user,
    event.reaction,
    question.number,
    match ? Number(match[1]) : '',
    match ? Number(match[2]) : '',
    question.postedAt,
    "'" + item.ts
  ]);
}

/** リアクションシートが無ければヘッダー付きで作る */
function getOrCreateReactionSheet_(spreadsheet) {
  let sheet = spreadsheet.getSheetByName(SHEET_REACTIONS);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(SHEET_REACTIONS);
    sheet.appendRow(REACTION_HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}
