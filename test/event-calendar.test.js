// カレンダー操作の失敗（回数制限・予定が無い）への強さを確かめる。
// 実際のカレンダーは使わず、呼び出しの順番と内容を記録して確かめる。
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas, plain } = require('./harness');
const { fakeCalendar, rateLimit, deleted } = require('./calendar-fake');

// ---- 再試行 ----

test('カレンダー: 回数制限のエラーは、待って再試行して通る', () => {
  let calls = 0;
  const cal = fakeCalendar({ insert: () => { calls += 1; if (calls <= 2) throw rateLimit(); } });
  const gas = loadGas({ Calendar: cal.Calendar, Utilities: cal.Utilities });
  const result = gas.ctx.createCalendarEvents_({ calendarId: 'c' }, {
    eventId: 'E1', title: 't', start: new Date(2099, 0, 5, 10), end: new Date(2099, 0, 5, 11),
    format: gas.get('EVENT_FORMATS').OFFLINE, location: '会議室'
  });
  assert.deepEqual(plain(result.calendarEventIds), ['new1']);
  assert.deepEqual(plain(cal.sleeps), [1000, 2000], '1回目・2回目の再試行の前に待つ');
});

test('カレンダー: 回数制限が続くときは、3回の再試行のあとで諦めて、エラーを投げる', () => {
  const cal = fakeCalendar({ patch: () => { throw rateLimit(); } });
  const gas = loadGas({ Calendar: cal.Calendar, Utilities: cal.Utilities });
  assert.throws(() => gas.ctx.patchCalendarDescriptions_({ calendarId: 'c' }, { calendarEventId: 'a' }, 'd'), /Rate Limit/);
  assert.deepEqual(plain(cal.sleeps), [1000, 2000, 4000]);
});

test('カレンダー: 回数制限以外のエラーは、再試行せずにすぐ投げる', () => {
  const cal = fakeCalendar({ patch: () => { throw new Error('Invalid value for: start'); } });
  const gas = loadGas({ Calendar: cal.Calendar, Utilities: cal.Utilities });
  assert.throws(() => gas.ctx.patchCalendarDescriptions_({ calendarId: 'c' }, { calendarEventId: 'a' }, 'd'), /Invalid value/);
  assert.deepEqual(plain(cal.sleeps), []);
});

test('カレンダー: 説明欄の更新が失敗しても、補助版は止まらずに false を返す', () => {
  const cal = fakeCalendar({ patch: () => { throw new Error('boom'); } });
  const gas = loadGas({ Calendar: cal.Calendar, Utilities: cal.Utilities });
  assert.equal(gas.ctx.tryPatchCalendarDescriptions_({ calendarId: 'c' }, { calendarEventId: 'a' }, 'd'), false);
});

test('カレンダー: 更新しようとした予定が無ければ（削除済み）、作り直す', () => {
  const cal = fakeCalendar({ patch: (kind) => { if (kind === 'summary') throw deleted(); } });
  const gas = loadGas({ Calendar: cal.Calendar, Utilities: cal.Utilities });
  const ev = { eventId: 'E1', title: 't', start: new Date(2099, 0, 5, 10), end: new Date(2099, 0, 5, 11),
    format: gas.get('EVENT_FORMATS').OFFLINE, location: '会議室', calendarEventId: 'gone' };
  gas.ctx.updateCalendarEvents_({ calendarId: 'c' }, ev, false);
  assert.equal(ev.calendarEventId, 'new1');
  assert.ok(cal.log.includes('insert'));
});
