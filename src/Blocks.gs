/**
 * Blocks.gs
 * Slack告知メッセージ（Block Kit）の組み立て。
 * メッセージ本文が常に「正」となるよう、参加状況・残枠・キャンセル待ちを
 * 状態変化のたびに chat.update で再描画する。
 */

/** Slack mrkdwn 用エスケープ */
function escapeSlackText_(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Block Kit の section text 上限（3000文字）に収める */
function truncateForBlock_(text, limit) {
  const s = String(text || '');
  return s.length > limit ? s.substring(0, limit - 1) + '…' : s;
}

/**
 * 告知メッセージの blocks とフォールバック text を組み立てる。
 * @param {Object} ev イベント
 * @param {Array} participants listParticipants_ の結果
 * @param {string} participantsUrl 参加者確認WebページURL
 * @return {{text: string, blocks: Array}}
 */
function buildAnnouncementBlocks_(ev, participants, participantsUrl) {
  const joined = participants.filter(function (p) { return p.status === PSTATUS.JOINED; });
  const waitlist = participants.filter(function (p) { return p.status === PSTATUS.WAITLIST; });
  const staff = participants.filter(function (p) { return p.status === PSTATUS.STAFF; });
  const remaining = Math.max(0, ev.capacity - joined.length);
  const cancelled = isCancelledStatus_(ev.status);
  const ended = ev.end.getTime() < Date.now();

  const dateLabel = Utilities.formatDate(ev.start, 'Asia/Tokyo', 'yyyy/MM/dd(EEE) HH:mm') +
    ' - ' + Utilities.formatDate(ev.end, 'Asia/Tokyo', 'HH:mm');
  const titleLabel = (cancelled ? '【中止】' : '') + escapeSlackText_(ev.title);

  const blocks = [];

  // ---- ヘッダー（イベント基本情報）----
  let headerText = ':loudspeaker: *' + titleLabel + '*\n' +
    ':calendar: 日時: ' + dateLabel + '\n' +
    ':round_pushpin: 場所: ' + escapeSlackText_(ev.location || '（未定）') + '\n' +
    ':bust_in_silhouette: 主催: <@' + ev.organizer + '>';
  if (needsMeetSplit_(ev)) {
    headerText += '\n:bulb: 無料版Meetのため60分ごとに接続が切れます。切れたら同じURLから再入室してください。';
  }
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: headerText } });

  // ---- 概要・事前準備 ----
  let detail = '*概要・対象者*\n' + escapeSlackText_(ev.description);
  if (ev.preparation) {
    detail += '\n\n*事前準備・持ち物・資料リンク*\n' + escapeSlackText_(ev.preparation);
  }
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: truncateForBlock_(detail, 3000) }
  });

  blocks.push({ type: 'divider' });

  // ---- 参加状況（このメッセージが常に最新の「正」）----
  let statusText;
  if (cancelled) {
    statusText = ':no_entry: *このイベントは中止になりました*';
  } else {
    statusText = remaining > 0
      ? ':busts_in_silhouette: *参加 ' + joined.length + '/' + ev.capacity + '名*（残り' + remaining + '枠）'
      : ':u6e80: *満員*（参加 ' + joined.length + '/' + ev.capacity + '名）';
    if (waitlist.length > 0) {
      statusText += '　:hourglass_flowing_sand: キャンセル待ち ' + waitlist.length + '名';
    }
    if (staff.length > 0) {
      statusText += '　:busts_in_silhouette: 運営 ' + staff.length + '名（定員外）';
    }
  }
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: statusText } });

  // ---- 参加者名の列挙（多すぎる場合は省略表示）----
  if (!cancelled && joined.length > 0) {
    const MAX_NAMES = 30;
    let names = joined.slice(0, MAX_NAMES)
      .map(function (p) { return escapeSlackText_(p.displayName); })
      .join('、');
    if (joined.length > MAX_NAMES) {
      names += ' ほか' + (joined.length - MAX_NAMES) + '名';
    }
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '参加: ' + truncateForBlock_(names, 3000) }]
    });
  }

  // ---- 運営（定員外）の列挙 ----
  if (!cancelled && staff.length > 0) {
    const staffNames = staff
      .map(function (p) { return escapeSlackText_(p.displayName); })
      .join('、');
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '運営: ' + truncateForBlock_(staffNames, 3000) }]
    });
  }

  // ---- 操作ボタン（中止・終了後は表示しない）----
  if (!cancelled && !ended) {
    const joinButton = remaining > 0
      ? { type: 'button', action_id: ACTION_JOIN, value: ev.eventId, style: 'primary',
          text: { type: 'plain_text', text: '✋ 参加する', emoji: true } }
      : { type: 'button', action_id: ACTION_JOIN, value: ev.eventId,
          text: { type: 'plain_text', text: '🈵 キャンセル待ちに登録', emoji: true } };
    blocks.push({
      type: 'actions',
      elements: [
        joinButton,
        // 運営（師匠・主催者・運営スタッフ）用。満員でも定員外で常に参加できる
        { type: 'button', action_id: ACTION_JOIN_STAFF, value: ev.eventId,
          text: { type: 'plain_text', text: '🛡 運営として参加', emoji: true } },
        { type: 'button', action_id: ACTION_LEAVE, value: ev.eventId,
          text: { type: 'plain_text', text: '取り消す', emoji: true } }
      ]
    });
  }

  // ---- フッター（参加者確認ページ）----
  if (participantsUrl) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: ':link: <' + participantsUrl + '|参加者リスト（リアルタイム）>' }]
    });
  }

  const fallback = (cancelled ? '【中止】' : '') + ev.title + ' ' + dateLabel +
    '（参加 ' + joined.length + '/' + ev.capacity + '名）';
  return { text: fallback, blocks: blocks };
}

/** 最新の参加状況で告知メッセージを再描画する */
function refreshAnnouncement_(config, ev) {
  if (!ev.slackTs) return;
  const participants = listParticipants_(config, ev.eventId);
  const participantsUrl = buildParticipantsPageUrl_(config, ev.eventId);
  const msg = buildAnnouncementBlocks_(ev, participants, participantsUrl);
  updateMessageBlocks_(config, ev.slackChannel, ev.slackTs, msg.text, msg.blocks);
}
