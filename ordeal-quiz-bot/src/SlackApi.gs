/**
 * SlackApi.gs
 * Slack Web API の呼び出しヘルパー。
 * トークンはスクリプトプロパティ SLACK_BOT_TOKEN から読み込む（ハードコード禁止）。
 */

/** Slack Web API を JSON payload で呼び出す */
function callSlackApi_(config, method, payload) {
  const response = UrlFetchApp.fetch('https://slack.com/api/' + method, {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    headers: { Authorization: 'Bearer ' + config.slackBotToken },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const json = JSON.parse(response.getContentText());
  if (!json.ok) {
    console.error('Slack API error: ' + method + ' -> ' + json.error);
  }
  return json;
}

/** 設定シートの表示名・アイコンを chat.postMessage のパラメータに変換する */
function buildIdentity_(settings) {
  const identity = {};
  if (settings.BOT_NAME) identity.username = settings.BOT_NAME;
  if (settings.BOT_ICON_URL) {
    identity.icon_url = settings.BOT_ICON_URL;
  } else if (settings.BOT_ICON_EMOJI) {
    identity.icon_emoji = settings.BOT_ICON_EMOJI;
  }
  return identity;
}

/** 見出し（問題番号）＋問題文のメッセージ本文を作る */
function buildMessageText_(settings, question) {
  const header = settings.HEADER_FORMAT
    ? settings.HEADER_FORMAT.split('{number}').join(question.number)
    : '';
  return header ? header + '\n' + question.text : question.text;
}

/** テキストのみの問題を投稿する。成功したらメッセージのts、失敗したら null を返す */
function postText_(config, settings, text) {
  const payload = Object.assign({
    channel: config.slackChannelId,
    text: text
  }, buildIdentity_(settings));
  const json = callSlackApi_(config, 'chat.postMessage', payload);
  return json.ok ? json.ts : null;
}

/**
 * 画像付きの問題を投稿する。成功したらメッセージのts、失敗したら null を返す。
 * files.getUploadURLExternal → 画像バイナリPOST → files.completeUploadExternal（チャンネル指定なし）
 * → chat.postMessage の image ブロックでファイルを参照、の4段階。
 * ファイル投稿（completeUploadExternal にチャンネル指定）だと表示名・アイコンを変えられないため、
 * chat.postMessage 経由で投稿している。
 */
function postImage_(config, settings, text, imageBlob) {
  const filename = imageBlob.getName() || 'quiz.png';

  // files.getUploadURLExternal は application/x-www-form-urlencoded を要求するため
  // callSlackApi_（JSON専用）は使わず個別に呼び出す
  const uploadUrlResponse = UrlFetchApp.fetch('https://slack.com/api/files.getUploadURLExternal', {
    method: 'post',
    headers: { Authorization: 'Bearer ' + config.slackBotToken },
    payload: { filename: filename, length: String(imageBlob.getBytes().length) },
    muteHttpExceptions: true
  });
  const uploadUrlJson = JSON.parse(uploadUrlResponse.getContentText());
  if (!uploadUrlJson.ok) {
    console.error('files.getUploadURLExternal に失敗しました: ' + uploadUrlJson.error);
    return null;
  }

  const uploadResponse = UrlFetchApp.fetch(uploadUrlJson.upload_url, {
    method: 'post',
    payload: { file: imageBlob },
    muteHttpExceptions: true
  });
  if (uploadResponse.getResponseCode() !== 200) {
    console.error('画像バイナリのアップロードに失敗しました: HTTP ' + uploadResponse.getResponseCode());
    return null;
  }

  const completeJson = callSlackApi_(config, 'files.completeUploadExternal', {
    files: [{ id: uploadUrlJson.file_id, title: filename }]
  });
  if (!completeJson.ok) return null;

  const payload = Object.assign({
    channel: config.slackChannelId,
    text: text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: text } },
      { type: 'image', slack_file: { id: uploadUrlJson.file_id }, alt_text: filename }
    ]
  }, buildIdentity_(settings));

  // アップロード直後はSlack側の処理が終わっておらず invalid_blocks になることがあるので少し待って再試行する
  for (let attempt = 1; attempt <= 5; attempt++) {
    const json = callSlackApi_(config, 'chat.postMessage', payload);
    if (json.ok) return json.ts;
    if (json.error !== 'invalid_blocks') return null;
    Utilities.sleep(2000);
  }
  return null;
}
