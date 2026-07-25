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

/** Slack Web API を GET で呼び出して JSON を返す */
function callSlackApiGet_(config, method, params) {
  const query = Object.keys(params).map(function (key) {
    return key + '=' + encodeURIComponent(params[key]);
  }).join('&');
  const response = UrlFetchApp.fetch('https://slack.com/api/' + method + '?' + query, {
    headers: { Authorization: 'Bearer ' + config.slackBotToken },
    muteHttpExceptions: true
  });
  const json = JSON.parse(response.getContentText());
  if (!json.ok) {
    console.warn('Slack API error: ' + method + ' -> ' + json.error);
  }
  return json;
}

/** Bot自身が投稿したメッセージを削除する（絵文字転送の取り消しに使用） */
function deleteMessage_(config, channel, ts) {
  return callSlackApi_(config, 'chat.delete', { channel: channel, ts: ts });
}

/**
 * 指定メッセージに現在ついているリアクションの絵文字名を配列で返す。
 * リアクションを外した人以外がまだ押しているかの判定に使う。
 *
 * API が失敗したときは空配列ではなく null を返す。呼び出し側は
 * 「リアクションが1つも無い」と「取得できなかった」を区別する必要があり、
 * 混同すると一時的な通信エラーで転送先を誤って削除してしまうため。
 * @return {?Array<string>} 取得できなければ null
 */
function listReactionNames_(config, channel, ts) {
  const json = callSlackApiGet_(config, 'reactions.get', { channel: channel, timestamp: ts });
  if (!json.ok) return null;
  if (!json.message || !json.message.reactions) return [];
  return json.message.reactions.map(function (reaction) { return reaction.name; });
}

/**
 * チャンネル名（#archive / archive）をチャンネルIDへ変換する。
 * マッピングシートを人が読み書きしやすくするためチャンネル名で書けるようにしているが、
 * Slack API はIDしか受け付けないためここで解決する。
 *
 * conversations.list はページングがあり重い（実測で数百ms〜）ので、
 * 一度引いたら全チャンネルの名前→IDをまとめて6時間キャッシュする。
 * チャンネルIDが直接書かれていればAPIを呼ばずそのまま返す。
 */
function resolveChannelId_(config, channelName) {
  const name = String(channelName || '').trim().replace(/^#/, '');
  if (!name) return '';
  if (/^[CG][A-Z0-9]{6,}$/.test(name)) return name;

  const cache = CacheService.getScriptCache();
  const cacheKey = 'ch_' + name;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const found = {};
  let cursor = '';
  do {
    const json = callSlackApiGet_(config, 'conversations.list', {
      types: 'public_channel', exclude_archived: true, limit: 1000, cursor: cursor
    });
    if (!json.ok) break;
    (json.channels || []).forEach(function (channel) {
      found['ch_' + channel.name] = channel.id;
    });
    cursor = (json.response_metadata && json.response_metadata.next_cursor) || '';
  } while (cursor);

  // putAll は一度に大量投入すると失敗するため100件ずつに分けて入れる
  const keys = Object.keys(found);
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = {};
    keys.slice(i, i + 100).forEach(function (key) { chunk[key] = found[key]; });
    cache.putAll(chunk, 21600);
  }
  return found[cacheKey] || '';
}
