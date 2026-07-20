/**
 * SlackApi.gs
 * Slack Web API の呼び出しヘルパー。
 * トークンはスクリプトプロパティ SLACK_BOT_TOKEN から読み込む（ハードコード禁止）。
 */

/** Slack Web API を呼び出して JSON を返す */
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
    console.warn('Slack API error: ' + method + ' -> ' + json.error);
  }
  return json;
}

/** チャンネルへメッセージを投稿する。成功時は ts を返す。blocks は省略可 */
function postMessage_(config, channel, text, threadTs, blocks) {
  const payload = { channel: channel, text: text };
  if (threadTs) payload.thread_ts = threadTs;
  if (blocks) payload.blocks = blocks;
  const json = callSlackApi_(config, 'chat.postMessage', payload);
  return json.ok ? json.ts : null;
}

/** 既存メッセージを Block Kit ごと上書き更新する */
function updateMessageBlocks_(config, channel, ts, text, blocks) {
  return callSlackApi_(config, 'chat.update', {
    channel: channel, ts: ts, text: text, blocks: blocks
  });
}

/**
 * ボタン押下への即時フィードバック（本人にのみ見える応答）。
 * Interactivity ペイロードの response_url へ POST する。Botトークン不要。
 */
function respondEphemeral_(responseUrl, text) {
  if (!responseUrl) return;
  UrlFetchApp.fetch(responseUrl, {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    payload: JSON.stringify({
      response_type: 'ephemeral',
      replace_original: false,
      text: text
    }),
    muteHttpExceptions: true
  });
}

/** メッセージのパーマリンクを取得する */
function getPermalink_(config, channel, ts) {
  const response = UrlFetchApp.fetch(
    'https://slack.com/api/chat.getPermalink?channel=' + encodeURIComponent(channel) +
    '&message_ts=' + encodeURIComponent(ts),
    { headers: { Authorization: 'Bearer ' + config.slackBotToken }, muteHttpExceptions: true }
  );
  const json = JSON.parse(response.getContentText());
  return json.ok ? json.permalink : '';
}

/**
 * ユーザーの表示名（Display Name）を取得する。未設定時は実名→アカウント名の順で代替。
 * ボタン応答の3秒制限対策として結果を6時間キャッシュする。
 */
function getDisplayName_(config, userId) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'dn_' + userId;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const response = UrlFetchApp.fetch(
    'https://slack.com/api/users.info?user=' + encodeURIComponent(userId),
    { headers: { Authorization: 'Bearer ' + config.slackBotToken }, muteHttpExceptions: true }
  );
  const json = JSON.parse(response.getContentText());
  if (!json.ok) return userId;
  const profile = json.user.profile || {};
  const name = profile.display_name || profile.real_name || json.user.name || userId;
  cache.put(cacheKey, name, 21600);
  return name;
}

/** 指定ユーザーへDMを送る */
function sendDirectMessage_(config, userId, text) {
  const opened = callSlackApi_(config, 'conversations.open', { users: userId });
  if (!opened.ok) return;
  postMessage_(config, opened.channel.id, text);
}
