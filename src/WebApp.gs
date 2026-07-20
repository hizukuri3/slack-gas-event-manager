/**
 * WebApp.gs
 * 参加者リアルタイム確認ページ（GAS Webアプリの doGet）。
 * 例: https://script.google.com/macros/s/XXXX/exec?eventId=EV_XXX
 */

function doGet(e) {
  const eventId = (e && e.parameter && e.parameter.eventId) || '';
  if (!eventId) {
    return renderPage_('参加者確認', '<p class="empty">URLに eventId が指定されていません。</p>');
  }

  const config = getConfig_();
  const ev = findEventById_(config, eventId);
  if (!ev) {
    return renderPage_('参加者確認', '<p class="empty">指定されたイベントが見つかりません。</p>');
  }

  const participants = listParticipants_(config, eventId);
  const joined = participants.filter(function (p) { return p.status === PSTATUS.JOINED; });
  const waitlist = participants.filter(function (p) { return p.status === PSTATUS.WAITLIST; });
  const dateLabel = Utilities.formatDate(ev.start, 'Asia/Tokyo', 'yyyy/MM/dd(EEE) HH:mm') +
    ' - ' + Utilities.formatDate(ev.end, 'Asia/Tokyo', 'HH:mm');

  let body = '<h1>' + escapeHtml_(ev.title) + '</h1>';
  if (isCancelledStatus_(ev.status)) {
    body += '<p class="cancelled">このイベントは中止になりました</p>';
  }
  body += '<p class="meta">' + escapeHtml_(dateLabel) + '</p>';
  body += '<p class="meta">参加者: ' + joined.length + ' / 定員 ' + ev.capacity + '名' +
    (waitlist.length > 0 ? '（キャンセル待ち ' + waitlist.length + '名）' : '') + '</p>';

  if (joined.length === 0) {
    body += '<p class="empty">まだ参加者はいません。</p>';
  } else {
    body += '<h2>参加者</h2><ol class="participants">';
    joined.forEach(function (p) {
      body += '<li>' + escapeHtml_(p.displayName) + '</li>';
    });
    body += '</ol>';
  }
  if (waitlist.length > 0) {
    body += '<h2>キャンセル待ち（先着順で自動繰り上げ）</h2><ol class="participants waitlist">';
    waitlist.forEach(function (p) {
      body += '<li>' + escapeHtml_(p.displayName) + '</li>';
    });
    body += '</ol>';
  }
  body += '<p class="note">このページはSlackのボタン操作に連動してリアルタイムに更新されます（再読み込みで最新化）。</p>';

  return renderPage_(escapeHtml_(ev.title) + ' | 参加者リスト', body);
}

/** シンプルなHTMLページとして描画する */
function renderPage_(title, body) {
  const html =
    '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + title + '</title>' +
    '<style>' +
    'body{font-family:"Hiragino Sans","Yu Gothic",sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#333;line-height:1.7;}' +
    'h1{font-size:1.4rem;border-bottom:2px solid #4a90d9;padding-bottom:8px;}' +
    'h2{font-size:1rem;margin-top:24px;color:#4a90d9;}' +
    '.waitlist{color:#888;}' +
    '.meta{color:#666;margin:4px 0;}' +
    '.cancelled{color:#c0392b;font-weight:bold;}' +
    '.participants li{margin:4px 0;}' +
    '.empty{color:#999;}' +
    '.note{font-size:0.8rem;color:#aaa;margin-top:32px;}' +
    '</style></head><body>' + body + '</body></html>';
  return HtmlService.createHtmlOutput(html)
    .setTitle(title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** HTMLエスケープ（XSS対策） */
function escapeHtml_(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
