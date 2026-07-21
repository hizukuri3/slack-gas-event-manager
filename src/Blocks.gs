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
 * スレッドへ詳細を分けて投稿する必要があるか。
 * 事前準備・持ち物・資料リンクがある／Meet補足がある場合に true。
 * どちらも無いイベントは本文1通で完結させ、スレッドを作らない。
 * （概要は省略せず常に本文へ全文載せるため、スレッド作成の条件には含めない）
 */
function needsDetailThread_(ev) {
  return !!ev.preparation || needsMeetSplit_(ev);
}

/** 開催日時レンジを「yyyy/MM/dd(EEE) HH:mm - HH:mm」形式の文字列に整形する */
function formatDateRange_(start, end) {
  return Utilities.formatDate(start, 'Asia/Tokyo', 'yyyy/MM/dd(EEE) HH:mm') +
    ' - ' + Utilities.formatDate(end, 'Asia/Tokyo', 'HH:mm');
}

/**
 * 告知メッセージ（本文）の blocks とフォールバック text を組み立てる。
 *
 * 「目が泳ぐ」というフィードバックを受け、本文には参加ボタン・開催日時・
 * 場所・参加状況に加え、内容が伝わる“概要”を（省略せず全文）載せる。
 * 概要が無いとそもそもスレッドを開こうと思えないため。
 * 事前準備・持ち物・資料リンクは buildDetailBlocks_ 側でスレッドへ投稿する。
 *
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

  const dateLabel = formatDateRange_(ev.start, ev.end);
  const titleLabel = (cancelled ? '【中止】' : '') + escapeSlackText_(ev.title);

  const blocks = [];

  // ---- ヘッダー（イベント基本情報）----
  let headerText = ':loudspeaker: *' + titleLabel + '*\n' +
    ':calendar: 日時: ' + dateLabel + '\n' +
    ':round_pushpin: 場所: ' + escapeSlackText_(ev.location || '（未定）') + '\n' +
    ':bust_in_silhouette: 主催: <@' + ev.organizer + '>';
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: headerText } });

  // ---- 概要（内容が伝わるよう本文の上部に全文載せる）----
  if (!cancelled) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: truncateForBlock_('*概要・対象者*\n' + escapeSlackText_(ev.description), 3000)
      }
    });
  }

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

  // ---- 詳細への導線（事前準備・持ち物などはスレッドに投稿している）----
  if (!cancelled && needsDetailThread_(ev)) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: ':thread: 事前準備・持ち物・資料リンクは、このメッセージのスレッドをご覧ください。' }]
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

/**
 * スレッドへ投稿する「詳細情報」の blocks とフォールバック text を組み立てる。
 * 概要は本文に全文載せるため、ここには事前準備・持ち物・資料リンクとMeet補足のみを載せる。
 * @param {Object} ev イベント
 * @return {{text: string, blocks: Array}}
 */
function buildDetailBlocks_(ev) {
  const blocks = [];

  if (ev.preparation) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: truncateForBlock_('*事前準備・持ち物・資料リンク*\n' + escapeSlackText_(ev.preparation), 3000)
      }
    });
  }

  if (needsMeetSplit_(ev)) {
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: ':bulb: 無料版Meetのため60分ごとに接続が切れます。切れたら同じURLから再入室してください。'
      }]
    });
  }

  // 編集で事前準備が消され、Meet補足も無くなった場合の空更新を避けるフォールバック。
  // （スレッドは chat.update でその場を書き換えるため、順番はずれない）
  if (blocks.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '現在、事前準備・持ち物・資料リンクの登録はありません。' }
    });
  }

  return { text: escapeSlackText_(ev.title) + ' の詳細情報', blocks: blocks };
}

/** 最新の参加状況で告知メッセージ（本文）を再描画する */
function refreshAnnouncement_(config, ev) {
  if (!ev.slackTs) return;
  const participants = listParticipants_(config, ev.eventId);
  const participantsUrl = buildParticipantsPageUrl_(config, ev.eventId);
  const msg = buildAnnouncementBlocks_(ev, participants, participantsUrl);
  updateMessageBlocks_(config, ev.slackChannel, ev.slackTs, msg.text, msg.blocks);
}

/**
 * スレッドの詳細情報を最新のイベント内容で更新する。
 * 概要・持ち物は参加状況では変わらないため、内容が変わり得る編集時のみ呼ぶ
 * （ボタン押下の頻繁な再描画では呼ばず、無駄な chat.update を避ける）。
 * detailTs が無い旧イベントは、この機会にスレッドへ詳細を投稿して ts を保存する
 * （本文からは詳細を外したため、旧イベントでも情報が失われないようにする）。
 */
function refreshDetailThread_(config, ev) {
  if (!ev.slackTs) return;
  // 既にスレッドがあれば内容を最新化する（事前準備が消えても空更新で追随）
  if (ev.detailTs) {
    const msg = buildDetailBlocks_(ev);
    updateMessageBlocks_(config, ev.slackChannel, ev.detailTs, msg.text, msg.blocks);
    return;
  }
  // まだスレッドが無く、かつ詳細が必要になった場合だけ新規投稿してtsを保存する
  if (!needsDetailThread_(ev)) return;
  const msg = buildDetailBlocks_(ev);
  const ts = postMessage_(config, ev.slackChannel, msg.text, ev.slackTs, msg.blocks);
  if (ts) {
    ev.detailTs = ts;
    updateEvent_(config, ev);
  }
}
