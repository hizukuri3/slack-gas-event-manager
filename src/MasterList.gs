/**
 * MasterList.gs
 * 師匠（/event で師匠用フォームのリンクを受け取るメンバー）を
 * 「師匠リスト」シート（管理用①）で管理する。
 *
 * 正はシートで、スクリプトプロパティ `MASTER_SLACK_USER_IDS` は
 * そこから自動生成される読み取り用キャッシュ。運営はシートだけを触ればよい。
 *
 * ★ なぜキャッシュを挟むのか ★
 * /event はSlackの3秒ルールの対象で、実測で doPost 全体が約0.6秒かかっている
 * （GASの実行数ダッシュボード。ネットワーク往復とコンテナ起動は含まない値）。
 * ここに SpreadsheetApp.openById() を毎回足すと0.3〜1秒上乗せされ、
 * すでに「まれに超過する」状態の余裕をさらに削ってしまう。
 * そのため応答経路はこれまで通りプロパティ1回読み（約0.07秒）のままとし、
 * シートの読み取りは編集トリガー側（3秒ルールの外）へ寄せている。
 */

/**
 * 「師匠リスト」シート → スクリプトプロパティへ書き写す。
 * シートのトリガーから自動で呼ばれる。手動実行してもよい（やり直し用）。
 *
 * シートが正で、プロパティはその写し。例外は設けない。
 * シートが消えていれば師匠は0名になる。ただし黙って0名にすると
 * 「/event の応答だけが静かに変わる」ことになるので、下の lostSheet で
 * 呼び出し元へ伝え、トーストとログで運営に知らせる。
 *
 * @return {{ids: string[], invalid: string[], unknownFlags: string[], lostSheet: boolean}}
 *   書き写したID / 形式が不正で無視したセルの値 / 有効とも無効とも判定できなかった値 /
 *   シートが見つからず、登録済みだった師匠が全員外れたか
 */
function syncMasterList() {
  const config = getConfig_();
  const spreadsheet = SpreadsheetApp.openById(config.managementSpreadsheetId);

  // シートが元からあったのか、ここで作り直したのかを区別しておく。
  // 「無かったので作った」＝運営がシートを削除・改名した可能性がある
  const existed = spreadsheet.getSheetByName(SHEET_MASTER_LIST) !== null;
  const sheet = getOrCreateSheet_(spreadsheet, SHEET_MASTER_LIST, MASTER_LIST_HEADER);

  const migrated = migrateMasterListIfNeeded_(sheet);
  const result = readMasterListSheet_(sheet);
  const scriptProps = PropertiesService.getScriptProperties();
  const current = String(scriptProps.getProperty('MASTER_SLACK_USER_IDS') || '')
    .split(',')
    .map(normalizeSlackUserId_)
    .filter(function (id) { return id !== ''; });

  // 「シートが無かった」「シートから読めた師匠は0名」「プロパティには師匠がいた」の
  // 3つが揃うのは、シートの削除・改名しか原因がない。運営がシート上で最後の1人を
  // 消した正当なケースは、シートが存在するのでここには来ない
  const lostSheet = !existed && result.ids.length === 0 && current.length > 0;
  if (lostSheet) {
    console.error(
      '「' + SHEET_MASTER_LIST + '」シートが見つかりませんでした。削除または名前変更された' +
      '可能性があります。空のシートを作り直し、登録されていた師匠 ' + current.length +
      '名を外しました。シート名を戻すか、スプレッドシートの版の履歴から復元してください。'
    );
  }

  scriptProps.setProperty('MASTER_SLACK_USER_IDS', result.ids.join(','));
  console.log('師匠リストを反映しました: ' + result.ids.length + '名' +
    (migrated ? '（スクリプトプロパティの既存値をシートへ移行）' : ''));
  if (result.invalid.length > 0) {
    console.warn('SlackユーザーIDの形式ではない行を無視しました: ' + result.invalid.join(', '));
  }
  if (result.unknownFlags.length > 0) {
    console.warn('「有効」列に判定できない値があります（有効として扱いました）: ' +
      result.unknownFlags.join(', ') + ' / 止めるときは「無効」を選んでください');
  }

  // 見出しと入力規則の貼り直し。反映結果そのものには影響しないので、
  // ここで失敗しても同期は止めない（プロパティへの書き込みは上で完了済み）
  try {
    setupEnabledColumn_(sheet, MASTER_LIST_COL.ENABLED);
  } catch (err) {
    console.warn('「有効」列の見出し・入力規則の設定に失敗しました（反映自体は完了しています）: ' + err.message);
  }
  return {
    ids: result.ids,
    invalid: result.invalid,
    unknownFlags: result.unknownFlags,
    lostSheet: lostSheet
  };
}

/**
 * 反映結果を、操作した本人へシート右下のトーストで返す。
 * 逆に言えば、シートを触ってもトーストが出ないときは反映されていない
 * ＝トリガーが外れているので、setupTriggers() を再実行すること。
 */
function notifyMasterListSync_(spreadsheet, result) {
  if (!spreadsheet) return;

  if (result.lostSheet) {
    // 師匠が全員外れた直後。Slackの挙動が変わっているので、最優先で知らせる
    spreadsheet.toast(
      'シートが見つからなかったため、空のシートを作り直しました。' +
      '登録されていた師匠は全員外れています（いま師匠は0名です）。' +
      'シート名を戻すか、スプレッドシートの版の履歴から復元してください',
      '師匠リスト', 30);
    return;
  }

  let message = '有効な師匠 ' + result.ids.length + '名を反映しました';
  if (result.invalid.length > 0) {
    message += ' / ID形式ではないため無視: ' + result.invalid.join(', ');
  }
  if (result.unknownFlags.length > 0) {
    // 止めたつもりの人が師匠のまま残っている状態。長めに表示して気付かせる
    message += ' / 「' + result.unknownFlags.join('」「') +
      '」は判定できないため有効のままです。止めるなら「無効」を選んでください';
  }
  spreadsheet.toast(message, '師匠リスト', result.unknownFlags.length > 0 ? 20 : 8);
}

/**
 * シートから有効な師匠のSlackユーザーIDを読む（重複は除く）。
 * IDの形式チェックまでするのは、打ち間違えた1文字が「/event を打っても
 * 師匠用フォームが来ない」という分かりにくい形でしか現れないため。
 * 弾いた値は呼び出し元がトースト・ログで運営に見せる。
 */
function readMasterListSheet_(sheet) {
  const values = sheet.getDataRange().getValues();
  const ids = [];
  const invalid = [];
  const unknownFlags = [];
  for (let i = 1; i < values.length; i++) {
    const flag = values[i][MASTER_LIST_COL.ENABLED];
    if (classifyEnabledFlag_(flag) === 'disabled') continue;
    const raw = String(values[i][MASTER_LIST_COL.USER_ID] || '').trim();
    if (raw === '') continue;
    const id = normalizeSlackUserId_(raw);
    if (!isValidSlackUserId_(id)) {
      invalid.push(raw);
      continue;
    }
    // 「休止」「オフ」など、有効とも無効とも判定できない書き方。
    // 従来どおり有効として扱うが、止めたつもりでいる可能性があるので拾っておく。
    // 手入力は入力規則が弾くので、ここに来るのは貼り付け（入力規則ごと
    // セルを上書きしてしまう）ですり抜けた値
    if (classifyEnabledFlag_(flag) === 'unknown') {
      const text = String(flag).trim();
      if (unknownFlags.indexOf(text) === -1) unknownFlags.push(text);
    }
    if (ids.indexOf(id) === -1) ids.push(id);
  }
  return { ids: ids, invalid: invalid, unknownFlags: unknownFlags };
}

/**
 * プロパティで師匠を管理していた既存インスタンスの初回移行。
 * `MASTER_SLACK_USER_IDS` の値をシートへ書き出し、以後はシートを正にする。
 *
 * 移行済みフラグを立てるのは、「シートが空」を「まだ移行していない」と
 * 取り違えないため。フラグが無いと、運営が最後の1人を消したときに
 * 古いプロパティ値からその人が復活してしまう。
 *
 * @return {boolean} 実際に移行したか
 */
function migrateMasterListIfNeeded_(sheet) {
  const scriptProps = PropertiesService.getScriptProperties();
  if (scriptProps.getProperty('MASTER_LIST_MIGRATED') === '1') return false;

  // すでにシートに行があるなら、そちらが新しい運用。プロパティの値は移さない
  const existing = sheet.getLastRow() > 1
    ? []
    : String(scriptProps.getProperty('MASTER_SLACK_USER_IDS') || '')
      .split(',')
      .map(normalizeSlackUserId_)
      .filter(function (id) { return id !== ''; });

  if (existing.length > 0) {
    // メモ欄に出自を残す。移行後のシートを見た運営が「この行は誰が入れたのか」で
    // 迷わないようにするためで、処理には使わない
    sheet.getRange(2, 1, existing.length, MASTER_LIST_HEADER.length).setValues(
      existing.map(function (id) {
        return [id, '', '', 'スクリプトプロパティ MASTER_SLACK_USER_IDS から自動移行'];
      })
    );
    SpreadsheetApp.flush();
  }

  // フラグを立てるのは書き込みが確定してから。先に立ててしまうと、書き込みが
  // 失敗したときに「移行済みなのに空のシート」が正になり、次の反映で
  // プロパティが空で上書きされて師匠が全員消える
  scriptProps.setProperty('MASTER_LIST_MIGRATED', '1');
  return existing.length > 0;
}
