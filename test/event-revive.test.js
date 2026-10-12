// 中止から開催に戻すときの動きと、フォーム送信・登録の途中で失敗したときの動きを確かめる。
// 実際のカレンダー・Slack・シートは使わず、呼び出しの順番と内容を記録して確かめる。
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas, plain } = require('./harness');
const { fakeCalendar, rateLimit } = require('./calendar-fake');

// ---- 中止から開催に戻す ----

function reviveHarness(options) {
  options = options || {};
  const cal = fakeCalendar(options.calendar);
  const gas = loadGas({ Calendar: cal.Calendar, Utilities: cal.Utilities });
  const F = gas.get('EVENT_FORMATS');
  const events = [];   // 呼び出しの順番
  const dms = [];
  const errors = [];
  const posts = [];   // 告知スレッドへの投稿
  gas.stub({
    listParticipants_: () => [
      { userId: 'UJOIN1', status: '参加' }, { userId: 'USTAFF1', status: '運営' }, { userId: 'UWAIT1', status: 'キャンセル待ち' }],
    postMessage_: (c, channel, text, threadTs) => { events.push('threadPost'); posts.push({ text, threadTs }); },
    buildParticipantsPageUrl_: () => 'participants',
    getPermalink_: () => 'permalink',
    buildCalendarViewUrl_: () => 'calendarView',
    assignVcRoom_: () => {
      events.push('assignVcRoom');
      return options.vcFails
        ? { room: null, errors: ['空いている部屋がありません'] }
        : { room: { name: '部屋A', url: 'https://discord.com/channels/1/2' }, errors: [] };
    },
    updateEvent_: () => events.push('updateEvent'),
    promoteWaitlistedUpToCapacity_: () => events.push('promote'),
    refreshAnnouncement_: () => events.push('refresh'),
    notifyScheduleChange_: () => events.push('notifySchedule'),
    sendDirectMessage_: (c, user, text) => { events.push('dm'); dms.push(text); },
    notifyFormError_: (c, r, errs) => { events.push('formError'); errors.push(errs); }
  });
  return { gas, cal, F, events, dms, errors, posts };
}

function revivedCase(h, format, extra) {
  const start = new Date(2099, 0, 5, 10);
  const end = new Date(2099, 0, 5, 11);
  const existing = Object.assign({
    eventId: 'E1', title: '【テスト】', organizer: 'U0123ABCD', start, end, capacity: 5, status: '中止',
    format, location: '', description: 'd', preparation: '', calendarEventId: 'old1', slackTs: '1.1',
    slackChannel: 'C1', vcRoom: ''
  }, (extra && extra.existing) || {});
  const answers = Object.assign({
    title: '【テスト】', organizer: 'U0123ABCD', start, end, capacity: 5, status: '開催',
    format, location: 'https://example.com/room', description: 'd', preparation: '', vcRoom: 'おまかせ'
  }, (extra && extra.answers) || {});
  return { existing, answers };
}

[
  ['Google Meet', 'MEET'],
  ['その他のオンライン', 'OTHER_ONLINE'],
  ['対面', 'OFFLINE'],
  ['Discord VC', 'DISCORD']
].forEach(([label, key]) => {
  test('中止から開催に戻す（' + label + '・日時も形式も同じ）: 予定を作り直し、記録・告知・DMまで進む', () => {
    const h = reviveHarness();
    const { existing, answers } = revivedCase(h, h.F[key]);
    h.gas.ctx.handleEventEdit_({ calendarId: 'c', slackChannelId: 'C1' }, existing, answers, {});

    // 古い予定を消し、新しく作り、すぐ記録し、そのあとで説明欄を更新する
    const log = h.cal.log;
    assert.ok(log.indexOf('remove:old1') < log.indexOf('insert'), '消してから作る');
    const descriptionIndex = log.findIndex((e) => e.startsWith('patch:description:'));
    assert.ok(descriptionIndex > log.indexOf('insert'), '作ってから説明欄を更新する');
    assert.deepEqual(plain(log.filter((e) => e.startsWith('patch:summary'))), [], '削除済みの予定を「更新」しない');
    assert.equal(existing.calendarEventId, 'new1', '新しい予定のIDを持つ');

    const e = h.events;
    assert.ok(e.indexOf('updateEvent') !== -1 && e.indexOf('refresh') !== -1 && e.indexOf('dm') !== -1);
    assert.ok(e.indexOf('updateEvent') < e.indexOf('refresh') && e.indexOf('refresh') < e.indexOf('dm'));
    assert.equal(existing.status, '開催');
    assert.match(h.dms[0], /中止から開催に戻しました/);

    // 告知スレッドへ、参加登録中・キャンセル待ちの全員（運営を含む）をメンションして知らせる
    assert.equal(h.posts.length, 1);
    assert.equal(h.posts[0].threadTs, '1.1', '告知のスレッドへ');
    assert.match(h.posts[0].text, /中止から開催に戻りました/);
    assert.match(h.posts[0].text, /参加登録: <@UJOIN1> <@USTAFF1>/);
    assert.match(h.posts[0].text, /キャンセル待ち: <@UWAIT1>/);
    assert.ok(!h.events.includes('notifySchedule'), '変更前後の日時の通知は、再開の通知にまとめる');
    if (key === 'MEET') {
      assert.match(existing.location, /^https:\/\/meet\.google\.com\//, 'Meet のURLが入る');
      assert.match(h.dms[0], /Meet URLが再発行/);
    } else if (key === 'DISCORD') {
      assert.equal(existing.vcRoom, '部屋A');
      assert.equal(existing.location, 'https://discord.com/channels/1/2');
      assert.ok(e.includes('assignVcRoom'), '中止の間に取られているかもしれないので、部屋を取り直す');
    } else {
      assert.equal(existing.location, 'https://example.com/room');
    }
  });
});

test('中止から開催に戻す（Discord VC）: 部屋が取れなければ、何も変えずに差し戻す', () => {
  const h = reviveHarness({ vcFails: true });
  const { existing, answers } = revivedCase(h, h.F.DISCORD);
  h.gas.ctx.handleEventEdit_({ calendarId: 'c', slackChannelId: 'C1' }, existing, answers, {});
  assert.deepEqual(plain(h.cal.log), [], 'カレンダーには触らない');
  assert.ok(!h.events.includes('updateEvent'), 'シートも更新しない');
  assert.ok(h.events.includes('formError'));
});

test('中止から開催に戻す: 説明欄の更新だけが失敗しても、記録・告知の再描画・DMまで進む', () => {
  const h = reviveHarness({ calendar: { patch: (kind) => { if (kind === 'description') throw new Error('boom'); } } });
  const { existing, answers } = revivedCase(h, h.F.OFFLINE);
  h.gas.ctx.handleEventEdit_({ calendarId: 'c', slackChannelId: 'C1' }, existing, answers, {});
  assert.ok(h.events.includes('updateEvent') && h.events.includes('refresh') && h.events.includes('dm'));
  assert.match(h.dms[0], /説明欄だけ更新できませんでした/);
});

test('中止から開催に戻す: 回数制限に当たっても、再試行して最後まで進む（今回の不具合）', () => {
  let patchCalls = 0;
  const h = reviveHarness({ calendar: {
    patch: (kind) => { if (kind === 'description') { patchCalls += 1; if (patchCalls === 1) throw rateLimit(); } }
  } });
  const { existing, answers } = revivedCase(h, h.F.MEET);
  h.gas.ctx.handleEventEdit_({ calendarId: 'c', slackChannelId: 'C1' }, existing, answers, {});
  assert.equal(patchCalls, 2, '1回失敗して、2回目で通る');
  assert.ok(h.events.includes('dm'));
  assert.deepEqual(plain(h.cal.sleeps), [1000]);
});

test('中止から開催に戻す（日時も変える）: 再開の通知は1回だけ。変更前後の日時の通知とは重ねない', () => {
  const h = reviveHarness();
  const { existing, answers } = revivedCase(h, h.F.OFFLINE, {
    answers: { start: new Date(2099, 0, 6, 10), end: new Date(2099, 0, 6, 11) } });
  h.gas.ctx.handleEventEdit_({ calendarId: 'c', slackChannelId: 'C1' }, existing, answers, {});
  assert.equal(h.posts.length, 1);
  assert.match(h.posts[0].text, /日時: /, 'いまの日時を伝える（変更前後ではなく）');
  assert.ok(!/変更前/.test(h.posts[0].text));
  assert.ok(!h.events.includes('notifySchedule'));
});

test('通常の編集で日時を変えたときは、従来どおり変更前後の通知をする（再開の通知は出さない）', () => {
  const h = reviveHarness();
  const { existing, answers } = revivedCase(h, h.F.OFFLINE, {
    existing: { status: '開催' },
    answers: { start: new Date(2099, 0, 6, 10), end: new Date(2099, 0, 6, 11) } });
  h.gas.ctx.handleEventEdit_({ calendarId: 'c', slackChannelId: 'C1' }, existing, answers, {});
  assert.ok(h.events.includes('notifySchedule'));
  assert.equal(h.posts.length, 0);
});

test('通常の編集（中止からの復活ではない・日時も形式も同じ）: 予定は作り直さず、更新だけする', () => {
  const h = reviveHarness();
  const { existing, answers } = revivedCase(h, h.F.OFFLINE, {
    existing: { status: '開催' }, answers: { title: '新しい名前' } });
  h.gas.ctx.handleEventEdit_({ calendarId: 'c', slackChannelId: 'C1' }, existing, answers, {});
  assert.ok(!h.cal.log.includes('insert') && !h.cal.log.some((e) => e.startsWith('remove')));
  assert.ok(h.cal.log.includes('patch:summary:old1'));
  assert.match(h.dms[0], /内容を更新しました/);
});

test('中止から開催に戻す: 終了した日時のままなら、差し戻す。これからの日時なら通る', () => {
  const gas = loadGas();
  const F = gas.get('EVENT_FORMATS');
  const past = { start: new Date(2000, 0, 5, 10), end: new Date(2000, 0, 5, 11) };
  const future = { start: new Date(2099, 0, 5, 10), end: new Date(2099, 0, 5, 11) };
  const base = { title: 't', organizer: 'U0123ABCD', capacity: 5, format: F.OFFLINE, location: '会議室' };
  const cancelled = (t) => Object.assign({ status: '中止' }, t);
  const open = (t) => Object.assign({}, base, t, { status: '開催' });

  assert.equal(gas.ctx.validateAnswers_(open(past), cancelled(past)).length, 1, '終了済みを戻す');
  assert.equal(gas.ctx.validateAnswers_(open(future), cancelled(future)).length, 0, 'これからなら戻せる');
  // 戻すのではない通常の編集は、従来どおり（開催後の修正を許容）
  assert.equal(gas.ctx.validateAnswers_(open(past), Object.assign({ status: '開催' }, past)).length, 0);
  // 中止のまま再送信する（中止のまま）も、従来どおり
  assert.equal(gas.ctx.validateAnswers_(Object.assign({}, base, past, { status: '中止' }), cancelled(past)).length, 0);
});

// ---- 登録・送信の失敗 ----

test('新規登録: 記録に失敗したら、作ったカレンダー予定と告知を消して、エラーを投げる', () => {
  const cal = fakeCalendar();
  const gas = loadGas({ Calendar: cal.Calendar, Utilities: Object.assign(cal.Utilities,
    { formatDate: () => '20990105100000' }) });
  const calls = [];
  gas.stub({
    isDiscordVc_: () => false,
    createCalendarEvents_: () => ({ calendarEventIds: ['c1'], meetUrls: [], htmlLink: '' }),
    buildParticipantsPageUrl_: () => 'p', buildAnnouncementBlocks_: () => ({ text: 't', blocks: [] }),
    buildCalendarViewUrl_: () => 'v',
    postMessage_: () => '1.1',
    insertEvent_: () => { throw new Error('シートに書けない'); },
    deleteCalendarEvents_: () => calls.push('deleteCalendar'),
    deleteMessage_: (c, channel, ts) => calls.push('deleteMessage:' + ts)
  });
  const answers = { title: 't', organizer: 'U0123ABCD', start: new Date(2099, 0, 5, 10), end: new Date(2099, 0, 5, 11),
    capacity: 5, status: '開催', format: 'x', location: '', description: '', preparation: '', vcRoom: '' };
  assert.throws(() => gas.ctx.handleNewEvent_({ slackChannelId: 'C1' },
    { getId: () => 'R', getEditResponseUrl: () => 'e' }, answers, false), /シートに書けない/);
  assert.deepEqual(plain(calls), ['deleteCalendar', 'deleteMessage:1.1']);
});

test('フォーム送信: 処理の途中で失敗したら、主催者へ知らせて、実行は失敗のまま残す', () => {
  const gas = loadGas();
  const calls = [];
  gas.stub({
    getConfig_: () => ({ slackChannelId: 'C1', masterFormId: '' }),
    handleVizFormSubmit_: () => false,
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() { calls.push('unlock'); } }) },
    extractAnswers_: () => ({ organizer: 'U0123ABCD', title: 't', start: new Date(2099, 0, 1, 10),
      end: new Date(2099, 0, 1, 11), capacity: 5, format: gas.get('EVENT_FORMATS').OFFLINE, location: 'x', status: '開催' }),
    findEventByResponseId_: () => ({ organizer: 'U0123ABCD', start: new Date(2099, 0, 1, 10), end: new Date(2099, 0, 1, 11) }),
    slackUserExists_: () => true,
    handleEventEdit_: () => { throw new Error('カレンダーが落ちた'); },
    notifyFormError_: (c, r, errs) => calls.push('notify:' + errs.length)
  });
  const e = { response: { getId: () => 'R1' }, source: { getId: () => 'F1' } };
  assert.throws(() => gas.ctx.onFormSubmit(e), /カレンダーが落ちた/);
  assert.deepEqual(plain(calls), ['notify:1', 'unlock'], '知らせて、ロックも解放する');
});
