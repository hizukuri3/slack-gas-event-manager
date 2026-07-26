/**
 * SlashCommand.gs
 * Slackスラッシュコマンド（例: /event）でイベント登録フォームの
 * 「事前入力済みURL」を発行する。
 *
 * コマンドを打った本人の user_id をSlackペイロードから直接取得して
 * フォームの「主催者のSlackユーザーID」に埋め込むため、
 * 手入力によるIDの入力ミスが構造的に発生しない。
 *
 * パフォーマンス注意: この経路はSlackの3秒ルールの対象。
 * FormApp.openById() はフォーム構成のロードだけで約1秒/回かかるため、
 * 応答経路では一切使用しない。事前入力URLは、スクリプトプロパティに
 * 登録済みのエントリID（entry.XXXXX）との文字列結合だけで組み立てる。
 * エントリIDの調査・登録は setupPrefillEntryIds()（手動実行）で行う。
 */

/** スラッシュコマンドの処理（doPost から呼ばれる） */
function handleSlashCommand_(params) {
  const config = getConfig_();

  // 簡易検証：Verification Token の照合（設定されている場合のみ）
  if (config.slackVerificationToken && params.token !== config.slackVerificationToken) {
    return slashResponse_(':warning: 検証に失敗しました。');
  }

  const userId = params.user_id;

  // 師匠には師匠用フォームのリンクのみを返す（弟子には非公開）。
  // 誰が師匠かは「師匠リスト」シート（管理用①）で管理する。config.masterUserIds は
  // そこから自動生成されたキャッシュで、ここでは追加の通信なしで参照できる（MasterList.gs 参照）
  const isMaster = config.masterUserIds.indexOf(userId) !== -1;
  if (isMaster && config.masterFormId) {
    const masterUrl = buildPrefilledFormUrl_(
      config.masterFormId, config.masterFormEntries, userId, config.formStatusOpenValue);
    return slashResponse_(
      ':crown: *師匠イベント登録フォーム（あなた専用リンク・URLは共有しないでください）*\n' +
      '主催者のSlackユーザーID（<@' + userId + '>）は入力済みです。そのまま残りの項目を入力してください。\n' +
      masterUrl);
  }

  const generalUrl = buildPrefilledFormUrl_(
    config.formId, config.formEntries, userId, config.formStatusOpenValue);
  return slashResponse_(
    ':spiral_note_pad: *イベント登録フォーム（あなた専用リンク）*\n' +
    '主催者のSlackユーザーID（<@' + userId + '>）は入力済みです。そのまま残りの項目を入力してください。\n' +
    generalUrl);
}

/** スラッシュコマンドへの応答（本人にのみ表示） */
function slashResponse_(text) {
  return ContentService.createTextOutput(JSON.stringify({
    response_type: 'ephemeral',
    text: text
  })).setMimeType(ContentService.MimeType.JSON);
}

/**
 * 「主催者のSlackユーザーID」と「ステータス=開催」を埋めた
 * フォームの事前入力済みURLを文字列結合だけで組み立てる。
 * 通信を伴わないためミリ秒単位で完了する。
 * エントリID未登録の設問は事前入力をスキップし、
 * どちらも未登録なら素のフォームURLを返す（リンク自体は常に有効）。
 */
function buildPrefilledFormUrl_(formId, entries, slackUserId, statusOpenValue) {
  const base = 'https://docs.google.com/forms/d/' + formId + '/viewform';
  const params = [];
  if (entries && entries.organizer) {
    params.push('entry.' + entries.organizer + '=' + encodeURIComponent(slackUserId));
  }
  if (entries && entries.status && statusOpenValue) {
    params.push('entry.' + entries.status + '=' + encodeURIComponent(statusOpenValue));
  }
  if (params.length === 0) return base;
  return base + '?usp=pp_url&' + params.join('&');
}

// ==================== セットアップ用（手動実行） ====================

/**
 * 【セットアップ用・GASエディタから手動で1回実行】
 * 弟子用・師匠用フォームの事前入力エントリIDを FormApp で調査し、
 * スクリプトプロパティに自動登録する。フォームの設問を作り直して
 * エントリIDが変わった場合も、この関数を再実行すれば追従できる。
 *
 * FormApp を使うのはこの手動実行時のみで、Slack応答経路（3秒ルール対象）
 * では一切使用しない。
 */
function setupPrefillEntryIds() {
  const scriptProps = PropertiesService.getScriptProperties();
  const props = scriptProps.getProperties();
  const updates = {};
  const logs = [];

  [
    { label: '弟子用フォーム (GOOGLE_FORM_ID)', formId: props['GOOGLE_FORM_ID'],
      organizerKey: 'FORM_ENTRY_ORGANIZER', statusKey: 'FORM_ENTRY_STATUS' },
    { label: '師匠用フォーム (MASTER_FORM_ID)', formId: props['MASTER_FORM_ID'],
      organizerKey: 'MASTER_FORM_ENTRY_ORGANIZER', statusKey: 'MASTER_FORM_ENTRY_STATUS' }
  ].forEach(function (target) {
    if (!target.formId) {
      logs.push(target.label + ': フォームID未設定のためスキップ');
      return;
    }
    const found = extractPrefillEntryIds_(target.formId);
    if (found.organizer) updates[target.organizerKey] = found.organizer;
    if (found.status) updates[target.statusKey] = found.status;
    if (found.statusOpenValue) updates['FORM_STATUS_OPEN_VALUE'] = found.statusOpenValue;
    logs.push(
      target.label + ': ' +
      target.organizerKey + '=' + (found.organizer || '(取得失敗)') + ', ' +
      target.statusKey + '=' + (found.status || '(取得失敗)') +
      (found.statusOpenValue ? ', FORM_STATUS_OPEN_VALUE=' + found.statusOpenValue : '')
    );
  });

  if (Object.keys(updates).length > 0) {
    scriptProps.setProperties(updates);
  }
  logs.push('スクリプトプロパティに登録しました: ' + JSON.stringify(updates));
  console.log(logs.join('\n'));
}

/**
 * フォームの「主催者のSlackユーザーID」「イベントのステータス」設問の
 * エントリIDを調べる。目印の値を入れた事前入力URLを1回生成し、
 * URL中の entry.XXXXX=値 を逆引きして特定する
 * （FormApp の item.getId() は事前入力URLのエントリIDとは別物のため、
 * この方法でしか正確に取得できない）。
 */
function extractPrefillEntryIds_(formId) {
  const ORGANIZER_MARKER = '__ORGANIZER_MARKER__';
  const form = FormApp.openById(formId);
  const response = form.createResponse();
  let statusOpenValue = '';

  form.getItems().forEach(function (item) {
    const title = item.getTitle();

    if (title === FORM_TITLES.ORGANIZER && item.getType() === FormApp.ItemType.TEXT) {
      response.withItemResponse(item.asTextItem().createResponse(ORGANIZER_MARKER));
    }

    if (title === FORM_TITLES.STATUS && item.getType() === FormApp.ItemType.MULTIPLE_CHOICE) {
      // 「中止」を含まない選択肢（=①開催）を事前入力の対象にする
      const mcItem = item.asMultipleChoiceItem();
      const openChoice = mcItem.getChoices().find(function (choice) {
        return choice.getValue().indexOf('中止') === -1;
      });
      if (openChoice) {
        statusOpenValue = openChoice.getValue();
        response.withItemResponse(mcItem.createResponse(statusOpenValue));
      }
    }
  });

  const result = { organizer: '', status: '', statusOpenValue: statusOpenValue };
  const query = String(response.toPrefilledUrl()).split('?')[1] || '';
  query.split('&').forEach(function (pair) {
    const eq = pair.indexOf('=');
    if (eq === -1) return;
    const key = pair.slice(0, eq);
    if (key.indexOf('entry.') !== 0) return;
    const value = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
    if (value === ORGANIZER_MARKER) {
      result.organizer = key.replace('entry.', '');
    } else if (statusOpenValue && value === statusOpenValue) {
      result.status = key.replace('entry.', '');
    }
  });
  return result;
}
