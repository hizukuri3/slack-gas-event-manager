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
 * 「師匠リスト」シート → スクリプトプロパティへ反映する。
 * シート編集トリガーから自動で呼ばれる。手動実行してもよい（反映のやり直し用）。
 * @return {{ids: string[], invalid: string[]}} 反映したID と、形式が不正で無視したセルの値
 */
function syncMasterList() {
  const config = getConfig_();
  const sheet = getOrCreateSheet_(
    SpreadsheetApp.openById(config.managementSpreadsheetId),
    SHEET_MASTER_LIST, MASTER_LIST_HEADER
  );

  const migrated = migrateMasterListIfNeeded_(sheet);
  const result = readMasterListSheet_(sheet);
  PropertiesService.getScriptProperties()
    .setProperty('MASTER_SLACK_USER_IDS', result.ids.join(','));

  console.log('師匠リストを反映しました: ' + result.ids.length + '名' +
    (migrated ? '（スクリプトプロパティの既存値をシートへ移行）' : ''));
  if (result.invalid.length > 0) {
    console.warn('SlackユーザーIDの形式ではない行を無視しました: ' + result.invalid.join(', '));
  }
  return result;
}

/**
 * 管理用スプレッドシートの編集トリガー（setupTriggers で登録）。
 * 師匠リスト以外のシートの編集は即座に抜ける。
 *
 * GAS自身の書き込みでは編集トリガーは発火しないため、参加者リストなどへの
 * システム更新でここが呼ばれることはない（発火するのは人の手編集だけ）。
 */
function onManagementSpreadsheetEdit(e) {
  if (!e || !e.range) return;
  if (e.range.getSheet().getName() !== SHEET_MASTER_LIST) return;

  const result = syncMasterList();
  // 編集した本人へ反映結果を返す（シート右下のトースト）。
  // 逆に言えば、編集してもトーストが出ないときは反映されていない
  // ＝トリガーが外れているので、setupTriggers() を再実行すること
  if (!e.source) return;
  let message = '有効な師匠 ' + result.ids.length + '名を反映しました';
  if (result.invalid.length > 0) {
    message += ' / ID形式ではないため無視: ' + result.invalid.join(', ');
  }
  e.source.toast(message, '師匠リスト', 8);
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
  for (let i = 1; i < values.length; i++) {
    if (!isEnabledFlag_(values[i][MASTER_LIST_COL.ENABLED])) continue;
    const raw = String(values[i][MASTER_LIST_COL.USER_ID] || '').trim();
    if (raw === '') continue;
    const id = normalizeSlackUserId_(raw);
    if (!isValidSlackUserId_(id)) {
      invalid.push(raw);
      continue;
    }
    if (ids.indexOf(id) === -1) ids.push(id);
  }
  return { ids: ids, invalid: invalid };
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
  scriptProps.setProperty('MASTER_LIST_MIGRATED', '1');

  // すでにシートへ書かれているなら、そちらが新しい運用。プロパティの値は捨てる
  if (sheet.getLastRow() > 1) return false;

  const existing = String(scriptProps.getProperty('MASTER_SLACK_USER_IDS') || '')
    .split(',')
    .map(normalizeSlackUserId_)
    .filter(function (id) { return id !== ''; });
  if (existing.length === 0) return false;

  // メモ欄に出自を残す。移行後のシートを見た運営が「この行は誰が入れたのか」で
  // 迷わないようにするためで、処理には使わない
  sheet.getRange(2, 1, existing.length, MASTER_LIST_HEADER.length).setValues(
    existing.map(function (id) {
      return [id, '', '', 'スクリプトプロパティ MASTER_SLACK_USER_IDS から自動移行'];
    })
  );
  return true;
}
