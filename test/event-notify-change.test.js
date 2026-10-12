// 登録済みのイベントで、日時・会場VC・開催形式・場所が変わったときの、参加者への通知を確かめる。
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas, plain } = require('./harness');

function setup() {
  const gas = loadGas({
    Utilities: { formatDate: (d) => d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + d.getHours() + ':00' }
  });
  const F = gas.get('EVENT_FORMATS');
  const posts = [];
  const dms = [];
  gas.stub({
    postMessage_: (c, channel, text, threadTs) => posts.push({ text, threadTs }),
    sendDirectMessage_: (c, user, text) => dms.push({ user, text }),
    getPermalink_: () => 'https://slack/permalink',
    listParticipants_: () => [{ userId: 'UJOIN1', status: '参加' }, { userId: 'UWAIT1', status: 'キャンセル待ち' }]
  });
  const start = new Date(2099, 0, 5, 10);
  const end = new Date(2099, 0, 5, 11);
  const ev = (over) => Object.assign({
    eventId: 'E1', title: '勉強会', start, end, format: F.OFFLINE, location: '会議室A', vcRoom: '',
    slackTs: '1.1', slackChannel: 'C1'
  }, over || {});
  // 変更前の値
  const prev = (over) => Object.assign({ start, end, room: '', format: F.OFFLINE, location: '会議室A' }, over || {});
  const run = (after, before) => {
    const p = prev(before);
    gas.ctx.notifyScheduleChange_({}, ev(after), p.start, p.end, p.room, p.format, p.location);
  };
  return { gas, F, posts, dms, run, start, end };
}

test('何も変わっていなければ、通知しない', () => {
  const { posts, dms, run } = setup();
  run({}, {});
  assert.equal(posts.length, 0);
  assert.equal(dms.length, 0);
});

test('開催形式が変わる（対面 → Google Meet）: スレッドと全員へDM。形式・場所・Meetの案内が載る', () => {
  const { F, posts, dms, run } = setup();
  run({ format: F.MEET, location: 'https://meet.google.com/aaa,https://meet.google.com/bbb' }, { format: F.OFFLINE });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].threadTs, '1.1');
  const t = posts[0].text;
  assert.match(t, /開催形式・会場が変更されました/);
  assert.match(t, new RegExp('開催形式（変更前）: ' + F.OFFLINE));
  assert.match(t, new RegExp('開催形式（変更後）: ' + F.MEET));
  assert.match(t, /場所（変更前）: 会議室A/);
  assert.match(t, /場所（変更後）: Google Meet/);
  assert.ok(!t.includes('meet.google.com'), '長いURLは載せない');
  assert.match(t, /Meet の URL は新しく発行/);
  assert.deepEqual(plain(dms.map((d) => d.user)), ['UJOIN1', 'UWAIT1']);
  assert.match(dms[1].text, /現在キャンセル待ちで登録中/);
});

test('場所のURL・住所だけが変わる（対面）: 開催形式の行は出ず、場所の変更として通知する', () => {
  const { posts, run } = setup();
  run({ location: '会議室B' }, { location: '会議室A' });
  const t = posts[0].text;
  assert.match(t, /会場が変更されました/);
  assert.match(t, /場所（変更前）: 会議室A/);
  assert.match(t, /場所（変更後）: 会議室B/);
  assert.ok(!t.includes('開催形式（変更前）'));
});

test('Discord の部屋だけが変わる: 会場VCの行（従来どおり）。場所の行は出ない', () => {
  const { F, posts, run } = setup();
  run({ format: F.DISCORD, vcRoom: '部屋B', location: 'https://discord.com/b' },
    { format: F.DISCORD, room: '部屋A', location: 'https://discord.com/a' });
  const t = posts[0].text;
  assert.match(t, /会場が変更されました/);
  assert.match(t, /会場VC（変更前）: 部屋A/);
  assert.match(t, /会場VC（変更後）: 部屋B/);
  assert.ok(!t.includes('場所（変更前）'));
  assert.ok(!t.includes('開催形式（変更前）'));
});

test('Meet → Discord VC: 開催形式と会場VCの行。場所の行（URL）は出ない', () => {
  const { F, posts, run } = setup();
  run({ format: F.DISCORD, vcRoom: '部屋A', location: 'https://discord.com/a' },
    { format: F.MEET, location: 'https://meet.google.com/aaa' });
  const t = posts[0].text;
  assert.match(t, /開催形式・会場が変更されました/);
  assert.match(t, /会場VC（変更後）: 部屋A/);
  assert.ok(!t.includes('場所（変更前）'));
  assert.ok(!t.includes('meet.google.com'));
});

test('日時だけが変わる（Google Meet）: 日時の通知に、Meet の URL が新しくなる案内が付く', () => {
  const { F, gas, posts, run, end } = setup();
  run({ format: F.MEET, start: new Date(2099, 0, 6, 10), end: new Date(2099, 0, 6, 11), location: 'https://meet.google.com/new' },
    { format: F.MEET, location: 'https://meet.google.com/old' });
  const t = posts[0].text;
  assert.match(t, /開催日時が変更されました/);
  assert.match(t, /Meet の URL は新しく発行/);
  assert.ok(!t.includes('場所（変更前）'), 'Meet のURLの違いは、場所の変更として並べない');
});

test('日時だけが変わる（対面）: 従来どおり日時だけ', () => {
  const { posts, run } = setup();
  run({ start: new Date(2099, 0, 6, 10), end: new Date(2099, 0, 6, 11) }, {});
  const t = posts[0].text;
  assert.match(t, /開催日時が変更されました/);
  assert.ok(!t.includes('場所（変更前）') && !t.includes('Meet の URL'));
});

test('日時と開催形式を同時に変える: 通知は1回にまとめる', () => {
  const { F, posts, dms, run } = setup();
  run({ format: F.MEET, location: 'https://meet.google.com/x', start: new Date(2099, 0, 6, 10), end: new Date(2099, 0, 6, 11) },
    { format: F.OFFLINE });
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /開催日時・開催形式・会場が変更されました/);
  assert.equal(dms.length, 2);
});

test('編集の処理: 開催形式だけを変えたときも、通知が呼ばれる', () => {
  const { gas, F } = setup();
  const calls = [];
  gas.stub({
    buildParticipantsPageUrl_: () => 'p', getPermalink_: () => 'perma', buildCalendarViewUrl_: () => 'v',
    updateCalendarEvents_: () => {}, updateEvent_: () => {}, tryPatchCalendarDescriptions_: () => true,
    buildCalendarDescription_: () => 'd', promoteWaitlistedUpToCapacity_: () => {}, refreshAnnouncement_: () => {},
    sendDirectMessage_: () => {},
    notifyScheduleChange_: (config, ev, ps, pe, pr, pf, pl) => calls.push({ prevFormat: pf, prevLocation: pl, format: ev.format })
  });
  const start = new Date(2099, 0, 5, 10);
  const end = new Date(2099, 0, 5, 11);
  const existing = { eventId: 'E1', title: 't', organizer: 'U0123ABCD', start, end, capacity: 5, status: '開催',
    format: F.OFFLINE, location: '会議室A', description: '', preparation: '', calendarEventId: 'c1', slackTs: '1.1',
    slackChannel: 'C1', vcRoom: '' };
  const answers = { title: 't', organizer: 'U0123ABCD', start, end, capacity: 5, status: '開催',
    format: F.OTHER_ONLINE, location: 'https://example.com', description: '', preparation: '', vcRoom: '' };
  gas.ctx.handleEventEdit_({ calendarId: 'c' }, existing, answers, {});
  assert.deepEqual(plain(calls), [{ prevFormat: F.OFFLINE, prevLocation: '会議室A', format: F.OTHER_ONLINE }]);
});
