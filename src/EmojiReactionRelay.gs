/**
 * EmojiReactionRelay.gs
 * 特定の絵文字リアクションをきっかけに、そのメッセージを別チャンネルへ転送する。
 * 絵文字と転送先の対応は「絵文字転送マッピング」シート（管理用①）で管理する。
 *
 * 転送内容は permalink 1本のみ。本文の表示は Slack の自動展開（unfurl）に任せているため、
 * 元メッセージが編集されても転送先の見え方が追従する。
 *
 * 注意: GASのWebアプリはHTTPヘッダーを参照できないため、Slackが3秒以内に200を
 * 受け取れなかったときの再送（X-Slack-Retry-Num）を検知できない。
 * 二重転送を防いでいるのは「絵文字転送ログ」シートによる冪等化だけであり、
 * ログを手で消すと同じメッセージが再転送されうる。
 *
 * ログは監査記録として扱い、行を削除しない。取り消しは「取り消し日時」列を埋める
 * 論理削除で表現し、冪等判定は「取り消し日時が空の行」だけを見る。
 */

/** Events API（event_callback）の入口。リアクション以外のイベントは無視する */
function handleSlackEvent_(body) {
  const config = getConfig_();

  // 署名検証ができないため、InteractionHandler と同じく token 照合で代替する
  if (config.slackVerificationToken && body.token !== config.slackVerificationToken) {
    return;
  }

  const event = body.event || {};
  // ファイルやファイルコメントへのリアクションは転送対象外
  if (!event.item || event.item.type !== 'message') return;

  if (event.type === 'reaction_added') {
    handleReactionAdded_(config, event);
  } else if (event.type === 'reaction_removed') {
    handleReactionRemoved_(config, event);
  }
}

/** リアクションが付いたとき：マッピングに一致すれば転送先へ permalink を投稿する */
function handleReactionAdded_(config, event) {
  const emoji = normalizeEmojiName_(event.reaction);
  const srcChannel = event.item.channel;
  const srcTs = String(event.item.ts);

  // 大半のリアクションはマッピングに無い。シート1枚読むだけでここを抜ける。
  // 実際に届いた絵文字名をログに残すのは、マッピングの綴り違い（特に後述のエイリアス問題）を
  // 追えるようにするため。ここで無言に抜けると設定ミスの手掛かりが一切なくなる
  const rules = listForwardRules_(config, emoji);
  if (rules.length === 0) {
    console.log('マッピングに無い絵文字のためスキップ: ' + emoji);
    return;
  }

  // 転送先へ投稿したメッセージ自体に同じ絵文字を押されても転送し返さない。
  // 転送先が別の転送元にもなっている構成での往復を防ぐ
  const log = readForwardLog_(config);
  const isForwarded = log.some(function (row) {
    return row.destChannel === srcChannel && row.destTs === srcTs;
  });
  if (isForwarded) return;

  // Slackの再送は数十分にわたって届く。その間にリアクションが外されていると、
  // 取り消し済みのログ行は冪等判定の対象外なので再送がすり抜け、
  // 削除したはずの転送先メッセージが復活してしまう。
  // いま実際に押されているかを見て打ち切る。
  // 取得に失敗したときは判断できないので、転送は止めずに続行する
  const message = getReactedMessage_(config, srcChannel, srcTs);
  if (message && !hasEmojiReaction_(message, emoji)) {
    console.log('リアクションが既に外されているため転送しません: ' + emoji);
    return;
  }

  // 転送内容は permalink だけなので、元メッセージが後から編集・削除されると
  // 「何を転送したのか」を追えなくなる。監査用に本文をログへ控えておく
  const srcText = truncateForLog_(message && message.text);

  const permalink = getPermalink_(config, srcChannel, srcTs);
  if (!permalink) return;

  rules.forEach(function (rule) {
    const destChannel = resolveChannelId_(config, rule.toChannel);
    if (!destChannel) {
      console.warn('転送先チャンネルが解決できません: ' + rule.toChannel);
      return;
    }
    forwardOnce_(config, srcChannel, srcTs, emoji, destChannel, permalink, srcText);
  });
}

/**
 * 1つの転送先へ permalink を投稿する。すでに転送済みなら何もしない。
 *
 * ロック内では「ログ行の予約」だけを行い、Slackへの投稿はロック外で実行する
 * （InteractionHandler と同じくロック保持時間を最小化する方針）。
 * 予約行は転送先TSが空のまま先に入るため、同時押しやSlackの再送はここで弾かれる。
 */
function forwardOnce_(config, srcChannel, srcTs, emoji, destChannel, permalink, srcText) {
  const key = buildForwardKey_(srcChannel, srcTs, emoji, destChannel);

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (err) {
    console.warn('転送のロック取得に失敗しました: ' + key);
    return;
  }

  let alreadyForwarded = true;
  try {
    if (findActiveForwardLogRow_(config, key) === 0) {
      reserveForwardLog_(config, key, srcChannel, srcTs, emoji, destChannel, srcText);
      alreadyForwarded = false;
    }
  } finally {
    lock.releaseLock();
  }
  if (alreadyForwarded) return;

  const destTs = postMessage_(config, destChannel, permalink);
  if (destTs) {
    setForwardLogDestTs_(config, key, destTs);
    return;
  }
  // 投稿に失敗した予約は無効化して、次に同じ絵文字が押されたら再挑戦できるようにする。
  // 行自体は残すため、転送先TSが空のまま取り消し日時が入った行＝転送失敗の記録になる
  markForwardLogRemoved_(config, [key]);
}

/**
 * リアクションが外れたとき：誰も押していない状態になっていれば転送先の投稿を削除する。
 *
 * 転送ログは「誰が押したか」を持たない（＝何人押しても転送は1回）ため、
 * 1人が外しただけでは消せない。Slack側の現状を見てから判断する。
 */
function handleReactionRemoved_(config, event) {
  const emoji = normalizeEmojiName_(event.reaction);
  const srcChannel = event.item.channel;
  const srcTs = String(event.item.ts);

  // 取り消し済みの行は対象外。過去に押して外した履歴が残っていても二重処理しない
  const targets = readForwardLog_(config).filter(function (row) {
    return row.srcChannel === srcChannel && row.srcTs === srcTs &&
      row.emoji === emoji && !row.removedAt;
  });
  if (targets.length === 0) return;

  // 取得できなかったときは「誰も押していない」と決めつけず、削除を見送る。
  // 一時的な通信エラーで転送先を消してしまうと復旧できないため、安全側に倒す
  const message = getReactedMessage_(config, srcChannel, srcTs);
  if (!message) {
    console.warn('reactions.get に失敗したため取り消しを見送りました: ' + srcChannel + '/' + srcTs);
    return;
  }
  if (hasEmojiReaction_(message, emoji)) return;

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (err) {
    console.warn('転送取り消しのロック取得に失敗しました: ' + srcChannel + '/' + srcTs);
    return;
  }
  try {
    markForwardLogRemoved_(config, targets.map(function (row) { return row.key; }));
  } finally {
    lock.releaseLock();
  }

  // Slackの削除はロック外で行う。ここで失敗しても取り消し日時は戻さない
  // （再試行の経路が無く、転送先を手で消す方が確実なため）
  targets.forEach(function (row) {
    if (row.destTs) deleteMessage_(config, row.destChannel, row.destTs);
  });
}

// ==================== 絵文字転送マッピング ====================

/**
 * 指定の絵文字に対する有効な転送先の一覧を返す。
 * 同じ絵文字の行を複数書けば、その全チャンネルへ転送される。
 */
function listForwardRules_(config, emoji) {
  const sheet = SpreadsheetApp.openById(config.managementSpreadsheetId)
    .getSheetByName(SHEET_RELAY_MAPPING);
  if (!sheet) return [];

  const values = sheet.getDataRange().getValues();
  const rules = [];
  for (let i = 1; i < values.length; i++) {
    if (normalizeEmojiName_(values[i][RELAY_COL.EMOJI]) !== emoji) continue;
    if (!isEnabledFlag_(values[i][RELAY_COL.ENABLED])) continue;
    const toChannel = String(values[i][RELAY_COL.TO_CHANNEL] || '').trim();
    if (toChannel) rules.push({ toChannel: toChannel });
  }
  return rules;
}

/**
 * 絵文字名を照合用に正規化する。
 * シートに「:pin:」と書かれていても、Slackから「pin::skin-tone-3」で届いても
 * 同じ「pin」として扱えるようにする。
 *
 * 注意: エイリアスは解決できない。Slackは reaction_added で**正規名**を送るため、
 * 👍 は `thumbsup` ではなく `+1` として届く（同様に 👎 は `-1`、💯 は `100`）。
 * マッピングシートには正規名を書くこと。実際に届いた名前は
 * handleReactionAdded_ のスキップログで確認できる。
 */
/** メッセージに指定の絵文字のリアクションが今も付いているか */
function hasEmojiReaction_(message, emoji) {
  return (message.reactions || []).some(function (reaction) {
    return normalizeEmojiName_(reaction.name) === emoji;
  });
}

function normalizeEmojiName_(value) {
  return String(value || '')
    .trim()
    .replace(/^:/, '')
    .replace(/:$/, '')
    .replace(/::skin-tone-\d+$/, '')
    .toLowerCase();
}

// ==================== 絵文字転送ログ ====================

/**
 * 転送ログの一意キー。転送先まで含める。
 * 1つの絵文字を複数チャンネルへ配る仕様のため、転送先ごとに冪等判定する必要がある。
 * 押した人は含めない（何人押しても転送は1回）。
 */
function buildForwardKey_(srcChannel, srcTs, emoji, destChannel) {
  return srcChannel + '#' + srcTs + '#' + emoji + '#' + destChannel;
}

/** 絵文字転送ログのシートを取得。無ければヘッダー付きで作成する */
function getForwardLogSheet_(config) {
  return getOrCreateSheet_(
    SpreadsheetApp.openById(config.managementSpreadsheetId),
    SHEET_RELAY_LOG, RELAY_LOG_HEADER
  );
}

/**
 * 転送ログを全件読む（取り消し済みも含む）。
 * 取り消し日時は `|| ''` で正規化する。列を追加する前に作られたシートでは
 * その列が存在せず undefined になり、そのまま String() すると
 * 'undefined' という真値になって全行が取り消し済みに見えてしまうため。
 */
function readForwardLog_(config) {
  const values = getForwardLogSheet_(config).getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    rows.push({
      key: String(values[i][RELAY_LOG_COL.KEY]),
      srcChannel: String(values[i][RELAY_LOG_COL.SRC_CHANNEL]),
      srcTs: String(values[i][RELAY_LOG_COL.SRC_TS]),
      emoji: String(values[i][RELAY_LOG_COL.EMOJI]),
      destChannel: String(values[i][RELAY_LOG_COL.DEST_CHANNEL]),
      destTs: String(values[i][RELAY_LOG_COL.DEST_TS]),
      removedAt: String(values[i][RELAY_LOG_COL.REMOVED_AT] || '')
    });
  }
  return rows;
}

/**
 * キーに一致する「有効な（取り消されていない）」行の行番号（1始まり）を返す。無ければ 0。
 * 取り消し済みの行を除外することで、一度外した絵文字を押し直したときに再転送できる。
 */
function findActiveForwardLogRow_(config, key) {
  const values = getForwardLogSheet_(config).getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][RELAY_LOG_COL.KEY]) !== key) continue;
    if (String(values[i][RELAY_LOG_COL.REMOVED_AT] || '') !== '') continue;
    return i + 1;
  }
  return 0;
}

/**
 * 転送前に「予約」としてログ行を先に入れる。転送先TSは投稿成功後に埋める。
 *
 * ts（例: 1784563559.123456）はシートで数値化されると小数部が失われ、
 * chat.delete が失敗する。先頭にアポストロフィを付けて必ず文字列として保存する
 * （Repository.gs の eventToRow_ と同じ理由）。
 */
function reserveForwardLog_(config, key, srcChannel, srcTs, emoji, destChannel, srcText) {
  // 並びは RELAY_LOG_HEADER と一致させること
  getForwardLogSheet_(config).appendRow([
    new Date(), emoji, srcText || '', srcChannel, destChannel, '', key, "'" + srcTs, ''
  ]);
}

/**
 * ログに載せる本文を切り詰める。
 * readForwardLog_ はリアクションのたびに全行を読むため、長文をそのまま溜め込むと
 * 3秒ルールを圧迫する。監査で必要なのは冒頭なので先頭2000字に留める。
 */
function truncateForLog_(text) {
  const value = String(text || '');
  return value.length > 2000 ? value.slice(0, 2000) + '…' : value;
}

/** 予約したログ行に、転送先メッセージのtsを書き込む */
function setForwardLogDestTs_(config, key, destTs) {
  const row = findActiveForwardLogRow_(config, key);
  if (row === 0) return;
  getForwardLogSheet_(config)
    .getRange(row, RELAY_LOG_COL.DEST_TS + 1)
    .setValue("'" + destTs);
}

/**
 * キーに一致する有効な行に取り消し日時を入れて無効化する（論理削除）。
 *
 * 行は決して削除しない。「いつ何がどこへ転送され、いつ取り消されたか」は
 * 後から追える必要があるため。同じ絵文字が押し直されたときは新しい行が追記され、
 * 同一キーの行が履歴として複数並ぶ。
 */
function markForwardLogRemoved_(config, keys) {
  const sheet = getForwardLogSheet_(config);
  const values = sheet.getDataRange().getValues();
  const now = new Date();
  for (let i = 1; i < values.length; i++) {
    if (keys.indexOf(String(values[i][RELAY_LOG_COL.KEY])) === -1) continue;
    if (String(values[i][RELAY_LOG_COL.REMOVED_AT] || '') !== '') continue;
    sheet.getRange(i + 1, RELAY_LOG_COL.REMOVED_AT + 1).setValue(now);
  }
}
