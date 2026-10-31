/**
 * SlackMembers.gs
 * Slackメンバーの「表示名」と「ID」の対応表を「Slackメンバー一覧」シート（管理用①）へ書き出す。
 *
 * クイズ回答ログ・ナイスチャレンジのログはSlackユーザーIDで記録しているため、
 * 誰がどれだけ反応したかを人の名前で集計するときの突き合わせ表に使う。
 * 表示名は変わるので、変わったと思ったら exportSlackMembers を手動で実行し直す。
 * 表示名は常に最新へ上書きし、変更前の名前は持たない。退会した人の行は残す。
 */

/**
 * Slackの全メンバーを取得して、シートへ書き出す。GASエディタから手動で実行する。
 * 師匠・弟子の区別はしない。ゲストも含める（反応を集計する対象に入るため）。
 */
function exportSlackMembers() {
  const config = getConfig_();
  const members = listSlackMembers_(config);
  const spreadsheet = SpreadsheetApp.openById(config.managementSpreadsheetId);
  const sheet = getOrCreateSheet_(spreadsheet, SHEET_SLACK_MEMBERS, SLACK_MEMBER_HEADER);
  ensureHeader_(sheet, SLACK_MEMBER_HEADER);
  protectSystemSheet_(sheet);

  const lastRow = sheet.getLastRow();
  const existing = lastRow < 2 ? [] :
    sheet.getRange(2, 1, lastRow - 1, SLACK_MEMBER_HEADER.length).getValues();
  const merged = mergeSlackMembers_(existing, members);

  // 変わった行だけを書く。変化がなければ何も書き込まない
  merged.changedRows.forEach(function (i) {
    sheet.getRange(i + 2, 1, 1, SLACK_MEMBER_HEADER.length).setValues([merged.rows[i]]);
  });
  const message = 'Slackメンバー一覧を更新しました: 追加 ' + merged.added +
    '名 / 表示名の変更 ' + merged.renamed + '名 / 合計 ' + merged.rows.length + '行';
  console.log(message);
  spreadsheet.toast(message, SHEET_SLACK_MEMBERS, 8);
}

/**
 * users.list を最後のページまで読み、書き出す対象のメンバーを返す。
 * 途中のページで失敗したら例外にする。欠けた一覧をシートへ書くと、
 * 「いない人」と「取得できなかった人」が区別できなくなるため。
 * @return {{id: string, name: string}[]}
 */
function listSlackMembers_(config) {
  const members = [];
  let cursor = '';
  do {
    const params = { limit: 200 };
    if (cursor) params.cursor = cursor;
    const json = callSlackApiGet_(config, 'users.list', params);
    if (!json.ok) {
      throw new Error('users.list に失敗しました: ' + json.error);
    }
    (json.members || []).forEach(function (user) {
      const member = toSlackMember_(user);
      if (member) members.push(member);
    });
    cursor = (json.response_metadata && json.response_metadata.next_cursor) || '';
  } while (cursor);
  return members;
}

/**
 * users.list の1件を {id, name} にする。載せない人（退会済み・Bot）は null。
 * 表示名が未設定のときは実名→アカウント名の順で代替する（getDisplayName_ と同じ順）。
 */
function toSlackMember_(user) {
  if (!user || !user.id || user.deleted || user.is_bot || user.id === 'USLACKBOT') return null;
  const profile = user.profile || {};
  return { id: user.id, name: profile.display_name || profile.real_name || user.name || user.id };
}

/**
 * シートの現在の行に、取得したメンバーを重ねる。
 * 既にいる人は表示名だけ最新に、新しい人は末尾に足す。
 * 退会した人の行は消さない（過去のログのIDを名前に戻せるようにするため）。
 * 並び順は変えない（運営が手で並べ替えていても、横に足した列とずれない）。
 * @param {Array[]} existingRows シートの行 [[ID, 表示名], ...]
 * @param {{id: string, name: string}[]} members
 * @return {{rows: Array[], changedRows: number[], added: number, renamed: number}}
 *   changedRows は rows のうち書き込みが必要な行の位置（0始まり）
 */
function mergeSlackMembers_(existingRows, members) {
  const rows = existingRows.map(function (row) {
    return [String(row[0] || ''), String(row[1] || '')];
  });
  const indexById = {};
  rows.forEach(function (row, i) {
    if (row[0] !== '') indexById[row[0]] = i;
  });

  const changedRows = [];
  let added = 0;
  let renamed = 0;
  members.forEach(function (member) {
    if (Object.prototype.hasOwnProperty.call(indexById, member.id)) {
      const i = indexById[member.id];
      if (rows[i][1] !== member.name) {
        rows[i][1] = member.name;
        changedRows.push(i);
        renamed++;
      }
    } else {
      indexById[member.id] = rows.length;
      rows.push([member.id, member.name]);
      changedRows.push(rows.length - 1);
      added++;
    }
  });
  return { rows: rows, changedRows: changedRows, added: added, renamed: renamed };
}
