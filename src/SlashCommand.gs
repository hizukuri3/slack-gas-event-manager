/**
 * SlashCommand.gs
 * Slackスラッシュコマンド（例: /event）でイベント登録フォームの
 * 「事前入力済みURL」を発行する。
 *
 * コマンドを打った本人の user_id をSlackペイロードから直接取得して
 * フォームの「主催者のSlackユーザーID」に埋め込むため、
 * 手入力によるIDの入力ミスが構造的に発生しない。
 */

/** スラッシュコマンドの処理（doPost から呼ばれる） */
function handleSlashCommand_(params) {
  const config = getConfig_();

  // 簡易検証：Verification Token の照合（設定されている場合のみ）
  if (config.slackVerificationToken && params.token !== config.slackVerificationToken) {
    return slashResponse_(':warning: 検証に失敗しました。');
  }

  const userId = params.user_id;
  const generalUrl = prefilledUrlOrFallback_(config, config.formId, userId);

  let text =
    ':spiral_note_pad: *イベント登録フォーム（あなた専用リンク）*\n' +
    '主催者のSlackユーザーID（<@' + userId + '>）は入力済みです。そのまま残りの項目を入力してください。\n' +
    generalUrl;

  // 師匠には師匠用フォームのリンクも返す（弟子には非公開）
  const isMaster = config.masterUserIds.indexOf(userId) !== -1;
  if (isMaster && config.masterFormId) {
    const masterUrl = prefilledUrlOrFallback_(config, config.masterFormId, userId);
    text += '\n\n:crown: *師匠イベント用フォーム(師匠専用・URLは共有しないでください)*\n' + masterUrl;
  }

  return slashResponse_(text);
}

/** 事前入力URLを生成し、失敗時は素のフォームURLで代替する */
function prefilledUrlOrFallback_(config, formId, userId) {
  try {
    return buildPrefilledFormUrl_(config, formId, userId);
  } catch (err) {
    console.warn('事前入力URLの生成に失敗（素のURLで代替）: ' + err);
    return 'https://docs.google.com/forms/d/' + formId + '/viewform';
  }
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
 * フォームの事前入力済みURLを生成する。
 */
function buildPrefilledFormUrl_(config, formId, slackUserId) {
  const form = FormApp.openById(formId);
  const response = form.createResponse();

  form.getItems().forEach(function (item) {
    const title = item.getTitle();

    if (title === FORM_TITLES.ORGANIZER && item.getType() === FormApp.ItemType.TEXT) {
      response.withItemResponse(item.asTextItem().createResponse(slackUserId));
    }

    if (title === FORM_TITLES.STATUS && item.getType() === FormApp.ItemType.MULTIPLE_CHOICE) {
      // 「中止」を含まない選択肢（=①開催）を初期選択にする
      const mcItem = item.asMultipleChoiceItem();
      const openChoice = mcItem.getChoices().find(function (choice) {
        return choice.getValue().indexOf('中止') === -1;
      });
      if (openChoice) {
        response.withItemResponse(mcItem.createResponse(openChoice.getValue()));
      }
    }
  });

  return response.toPrefilledUrl();
}
