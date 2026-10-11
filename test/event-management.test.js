const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas, plain } = require('./harness');

// 外部へ出る関数を差し替えるテストは、テストごとに読み込み直す（差し替えが他のテストへ漏れないように）
const fresh = () => { const gas = loadGas({ Utilities: { formatDate: () => '20990105100000' } }); return { gas, ctx: gas.ctx }; };
const { gas: pureGas, ctx } = fresh();

// ---- 既存の純粋関数 ----

test('時間帯の重なり: 境界が接するだけは重なりではない', () => {
  const d = (h) => new Date(2099, 0, 5, h, 0);
  assert.equal(ctx.timeRangesOverlap_(d(10), d(12), d(11), d(13)), true);
  assert.equal(ctx.timeRangesOverlap_(d(10), d(12), d(12), d(13)), false);
  assert.equal(ctx.timeRangesOverlap_(d(10), d(12), d(8), d(10)), false);
});

test('終了時刻: 開始以前なら翌日扱い', () => {
  const start = new Date(2099, 0, 5, 14, 0);
  assert.equal(ctx.combineEndTime_(start, '16:00').getDate(), 5);
  assert.equal(ctx.combineEndTime_(start, '13:00').getDate(), 6);
});

test('開始日時の解釈', () => {
  const d = ctx.parseDateTime_('2099-01-05 09:30');
  assert.deepEqual([d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()], [2099, 1, 5, 9, 30]);
  assert.throws(() => ctx.parseDateTime_('あした'));
});

test('参加者の集計', () => {
  const ps = [{ status: '参加' }, { status: '参加' }, { status: 'キャンセル待ち' }, { status: '運営' }];
  assert.equal(ctx.countByStatus_(ps, '参加'), 2);
  assert.equal(ctx.countByStatus_(ps, '運営'), 1);
});

// ---- 入力検証: 開始から12時間まで ----

test('イベントの長さ: 12時間までは通り、超えると差し戻す', () => {
  const E = pureGas.get('EVENT_FORMATS');
  const base = { title: 't', organizer: 'U0123ABCD', capacity: 10, format: E.OFFLINE, location: '会議室' };
  const make = (startHour, endTime) => {
    const start = new Date(2099, 0, 5, startHour, 0);
    return Object.assign({}, base, { start, end: ctx.combineEndTime_(start, endTime) });
  };
  assert.equal(ctx.validateAnswers_(make(14, '16:00'), null).length, 0);
  assert.equal(ctx.validateAnswers_(make(10, '22:00'), null).length, 0, 'ちょうど12時間');
  assert.equal(ctx.validateAnswers_(make(10, '23:00'), null).length, 1, '13時間');
  const errors = ctx.validateAnswers_(make(14, '13:00'), null);   // 打ち間違い: 翌日扱いで23時間
  assert.equal(errors.length, 1);
  assert.match(errors[0], /23時間/);
});

test('イベントの長さ: 日時を変えない既存イベントは、12時間を超えていても中止できる', () => {
  const E = pureGas.get('EVENT_FORMATS');
  const start = new Date(2099, 0, 5, 9, 0);
  const end = new Date(2099, 0, 5, 23, 0);           // 14時間（上限が入る前に登録された想定）
  const answers = { title: 't', organizer: 'U0123ABCD', capacity: 10, format: E.OFFLINE, location: '会議室', start, end };
  assert.equal(ctx.validateAnswers_(answers, null).length, 1, '新規なら差し戻す');
  assert.equal(ctx.validateAnswers_(answers, { start, end }).length, 0, '日時を変えない編集は通す');
  const longer = Object.assign({}, answers, { end: new Date(2099, 0, 5, 23, 30) });
  assert.equal(ctx.validateAnswers_(longer, { start, end }).length, 1, '終了を変えて超えるなら差し戻す');
});

// ---- 中止: 参加者へのメンションと、繰り返さない ----

function cancelHarness(participants) {
  const { gas, ctx } = fresh();
  const calls = [];
  const posted = [];
  gas.stub({
    listParticipants_: () => participants,
    deleteCalendarEvents_: () => calls.push('deleteCalendar'),
    updateEvent_: () => calls.push('updateEvent'),
    refreshAnnouncement_: () => calls.push('refresh'),
    postMessage_: (c, channel, text) => { calls.push('post'); posted.push(text); },
    sendDirectMessage_: () => calls.push('dm')
  });
  return { calls, posted, ctx };
}
const ev = { eventId: 'E1', title: 'もくもく会', slackTs: '1.1', slackChannel: 'C1', organizer: 'UO' };

test('中止: 参加登録中・キャンセル待ちの全員（運営を含む）をメンションする', () => {
  const { calls, posted, ctx } = cancelHarness([
    { userId: 'UA', status: '参加' }, { userId: 'UB', status: 'キャンセル待ち' }, { userId: 'UC', status: '運営' }]);
  ctx.cancelEvent_({}, ev, false);
  assert.deepEqual(plain(calls), ['deleteCalendar', 'updateEvent', 'refresh', 'post', 'dm']);
  assert.match(posted[0], /参加登録: <@UA> <@UC>/);
  assert.match(posted[0], /キャンセル待ち: <@UB>/);
});

test('中止: すでに中止のイベントの再送信では、通知もカレンダー削除も繰り返さない', () => {
  const { calls, ctx } = cancelHarness([{ userId: 'UA', status: '参加' }]);
  ctx.cancelEvent_({}, ev, true);
  assert.deepEqual(plain(calls), ['updateEvent', 'refresh']);
});

test('中止: 参加者がいなければ、メンションの行は付かない', () => {
  const { posted, ctx } = cancelHarness([]);
  ctx.cancelEvent_({}, ev, false);
  assert.equal(posted[0], ':no_entry: イベント「もくもく会」は中止になりました。');
});

// ---- 新規登録: 告知に失敗したら全部取り消す ----

test('新規登録: Slackへの告知に失敗したら、カレンダーを消し、シートに書かず、差し戻す', () => {
  const { gas, ctx } = fresh();
  const calls = [];
  let slackTs = null;
  gas.stub({
    isDiscordVc_: () => false, isAutoMeet_: () => false,
    createCalendarEvents_: () => ({ calendarEventIds: ['c1', 'c2'], meetUrls: [], htmlLink: 'cal' }),
    buildParticipantsPageUrl_: () => 'p', buildAnnouncementBlocks_: () => ({ text: 't', blocks: [] }),
    buildCalendarViewUrl_: () => 'v',
    postMessage_: () => slackTs,
    deleteCalendarEvents_: (c, e) => calls.push('deleteCalendar:' + e.calendarEventId),
    notifyFormError_: (c, r, errors) => calls.push('formError:' + errors.length),
    insertEvent_: () => calls.push('insert'),
    getPermalink_: () => 'perma', patchCalendarDescriptions_: () => calls.push('patch'),
    buildCalendarDescription_: () => 'd', needsMeetSplit_: () => false, calendarEventIds_: () => [],
    sendDirectMessage_: () => calls.push('dm')
  });
  const answers = { title: 't', organizer: 'U0123ABCD', start: new Date(2099, 0, 5, 10), end: new Date(2099, 0, 5, 12),
    capacity: 5, status: '開催', format: 'x', location: '', description: '', preparation: '', vcRoom: '' };
  const response = { getId: () => 'R1', getEditResponseUrl: () => 'edit' };

  ctx.handleNewEvent_({ slackChannelId: 'C1' }, response, answers, false);
  assert.deepEqual(plain(calls), ['deleteCalendar:c1,c2', 'formError:1']);

  calls.length = 0;
  slackTs = '1.1';
  ctx.handleNewEvent_({ slackChannelId: 'C1' }, response, answers, false);
  assert.deepEqual(plain(calls), ['insert', 'patch', 'dm']);
});

// ---- フォーム送信: 実在しない主催者IDは登録も告知もしない ----

test('フォーム送信: Slackに存在しない主催者IDは登録せず、告知チャンネルへ案内する', () => {
  const { gas, ctx } = fresh();
  const calls = [];
  let exists = true;
  let existing = null;
  let organizer = 'U0123ABCD';
  gas.stub({
    getConfig_: () => ({ slackChannelId: 'C1', masterFormId: '' }),
    handleVizFormSubmit_: () => false,
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    extractAnswers_: () => ({ organizer, title: 't', start: new Date(2099, 0, 1, 10), end: new Date(2099, 0, 1, 11),
      capacity: 5, format: gas.get('EVENT_FORMATS').OFFLINE, location: 'x', status: '開催' }),
    findEventByResponseId_: () => existing,
    slackUserExists_: (c, id) => { calls.push('exists?' + id); return exists; },
    postMessage_: () => calls.push('channelNotice'),
    notifyFormError_: () => calls.push('formError'),
    findDuplicateEvent_: () => null,
    handleNewEvent_: () => calls.push('new'),
    handleEventEdit_: () => calls.push('edit')
  });
  const e = { response: { getId: () => 'R1' }, source: { getId: () => 'F1' } };
  const run = () => { calls.length = 0; ctx.onFormSubmit(e); return plain(calls); };

  assert.deepEqual(run(), ['exists?U0123ABCD', 'new'], '実在するIDは通常どおり登録');
  exists = false;
  assert.deepEqual(run(), ['exists?U0123ABCD', 'channelNotice'], '存在しないIDは登録せず案内');
  existing = { organizer: 'U0123ABCD', start: new Date(2099, 0, 1, 10), end: new Date(2099, 0, 1, 11) };
  assert.deepEqual(run(), ['edit'], '編集で主催者が同じなら、確認のAPIを呼ばない');
  existing = { organizer: 'UOLD00000', start: new Date(2099, 0, 1, 10), end: new Date(2099, 0, 1, 11) };
  assert.deepEqual(run(), ['exists?U0123ABCD', 'channelNotice'], '編集で主催者を変えたら確認する');
  organizer = 'abc';
  existing = null;
  assert.deepEqual(run(), ['formError'], '形式が不正なIDは、従来の差し戻し');
});

// ---- 「参加する」: 運営として登録済みの人 ----

test('参加ボタン: 運営として登録済みの人には、キャンセル待ちではなく運営と表示する', () => {
  const { gas, ctx } = fresh();
  gas.stub({
    listParticipants_: () => [{ userId: 'U1', status: '運営' }, { userId: 'U2', status: 'キャンセル待ち' },
      { userId: 'U3', status: '参加' }]
  });
  const feedback = (userId) => ctx.handleJoin_({}, { eventId: 'E', title: 't', capacity: 5 }, userId, 'n').feedback;
  assert.match(feedback('U1'), /運営として登録済み/);
  assert.match(feedback('U2'), /キャンセル待ちに登録済み/);
  assert.match(feedback('U3'), /参加登録済み/);
});
