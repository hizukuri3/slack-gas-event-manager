const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas, plain } = require('./harness');

const gas = loadGas();
const schedule = gas.ctx.computeQuizSchedule_;

// 2026-10-12 は月曜
const base = {
  channel: '#quiz', run: true, startDate: null, startDateInvalid: false, postHour: 9, skipWeekends: true,
  now: { year: 2026, month: 10, day: 12, hour: 8 }, postedToday: false, hasQuestion: true, nextNumber: 'Ord2-Q5'
};
const at = (over, nowOver) => schedule(Object.assign({}, base, over,
  nowOver ? { now: Object.assign({}, base.now, nowOver) } : {}));
const expectPlan = (result, shouldPostNow, label) => {
  assert.equal(result.shouldPostNow, shouldPostNow, JSON.stringify(result));
  assert.equal(result.label, label);
};

test('クイズの予定: 平日は、投稿時刻の前は今日の予定、時刻を過ぎていれば「まもなく」', () => {
  expectPlan(at({}), false, '本日 9時ごろ(Ord2-Q5)');
  expectPlan(at({}, { hour: 9 }), true, 'まもなく出題します(Ord2-Q5)');
  expectPlan(at({}, { hour: 15 }), true, 'まもなく出題します(Ord2-Q5)');
});

test('クイズの予定: 今日出していれば明日、土日は休むなら月曜', () => {
  expectPlan(at({ postedToday: true }, { hour: 15 }), false, '明日 10/13(火) 9時ごろ(Ord2-Q5)');
  expectPlan(at({ postedToday: true }, { day: 16, hour: 12 }), false, '10/19(月) 9時ごろ(Ord2-Q5)');
  expectPlan(at({ postedToday: true, skipWeekends: false }, { day: 16, hour: 12 }), false,
    '明日 10/17(土) 9時ごろ(Ord2-Q5)');
  expectPlan(at({}, { day: 17, hour: 12 }), false, '10/19(月) 9時ごろ(Ord2-Q5)');
  expectPlan(at({ skipWeekends: false }, { day: 17, hour: 12 }), true, 'まもなく出題します(Ord2-Q5)');
});

test('クイズの予定: お休み・チャンネル空・問題なしは出さない', () => {
  expectPlan(at({ run: false }), false, 'お休み中です');
  expectPlan(at({ channel: '' }), false, '投稿先チャンネルが空のため、出題しません');
  expectPlan(at({ hasQuestion: false }), false, '未出題の問題がありません');
  // お休みなら、日付が先でも「お休み中」
  expectPlan(at({ run: false, startDate: { year: 2026, month: 10, day: 20 } }), false, 'お休み中です');
});

test('クイズの予定: 読めない値（投稿時刻・始める日）は、出さずに警告する', () => {
  const badHour = at({ postHour: null });
  assert.equal(badHour.shouldPostNow, false);
  assert.ok(badHour.warning);
  const badDate = at({ startDateInvalid: true });
  assert.equal(badDate.shouldPostNow, false);
  assert.ok(badDate.warning);
});

test('クイズの予定: 「出題を始める日」より前は出さず、その日の投稿時刻から出す', () => {
  const day = (d) => ({ year: 2026, month: 10, day: d });
  expectPlan(at({ startDate: day(14) }, { hour: 15 }), false, '10/14(水) 9時ごろ(Ord2-Q5)');
  expectPlan(at({ startDate: day(13) }, { hour: 15 }), false, '明日 10/13(火) 9時ごろ(Ord2-Q5)');
  expectPlan(at({ startDate: day(12) }, { hour: 15 }), true, 'まもなく出題します(Ord2-Q5)');
  expectPlan(at({ startDate: { year: 2026, month: 1, day: 1 } }, { hour: 15 }), true, 'まもなく出題します(Ord2-Q5)');
  expectPlan(at({ startDate: day(17) }), false, '10/19(月) 9時ごろ(Ord2-Q5)');   // 土曜なら月曜
});

test('クイズの予定: 月・年をまたいでも日付が正しい', () => {
  expectPlan(at({ postedToday: true }, { year: 2026, month: 12, day: 31, hour: 12 }), false,
    '明日 1/1(金) 9時ごろ(Ord2-Q5)');
});

test('「出題を始める日」のセルの読み取り', () => {
  const parse = gas.ctx.parseQuizStartDate_;
  assert.deepEqual(plain(parse('')), { date: null, invalid: false });
  assert.deepEqual(plain(parse(null)), { date: null, invalid: false });
  assert.deepEqual(plain(parse('2026/10/13')), { date: { year: 2026, month: 10, day: 13 }, invalid: false });
  assert.deepEqual(plain(parse('2026-1-5')), { date: { year: 2026, month: 1, day: 5 }, invalid: false });
  assert.deepEqual(plain(parse(new Date(2026, 9, 13))), { date: { year: 2026, month: 10, day: 13 }, invalid: false });
  assert.equal(parse('あした').invalid, true);
  assert.equal(parse('2026/02/30').invalid, true);
  assert.equal(parse(46000).invalid, true, '日付の書式でない数値は読まない');
  assert.equal(parse(new Date('x')).invalid, true);
});

test('次の問題: 出題済み・空行・問題文が空の行は飛ばして拾う', () => {
  const { ctx } = gas;
  const COL = gas.get('QUIZ_COL');
  const row = (number, text, status) => {
    const r = ['', '', '', '', '', ''];
    r[COL.NUMBER] = number; r[COL.TEXT] = text; r[COL.STATUS] = status || '';
    return r;
  };
  gas.stub({ hasPostedOn_: () => false });
  const settings = { channel: '#q', run: true, startDate: null, startDateInvalid: false, postHour: 9, skipWeekends: false };
  const values = [['見出し'], row('Q1', '問1', '出題済み'), row('', '', ''), row('Q2', '', ''),
    row('Q3', '問3', '⚠ 飛ばしました'), row('Q4', '問4', '')];
  assert.equal(ctx.planQuiz_(settings, values, new Date(2026, 9, 12, 8)).label, '本日 9時ごろ(Q4)');
  assert.equal(
    ctx.planQuiz_(settings, [['見出し'], row('Q1', '問1', '出題済み')], new Date(2026, 9, 12, 8)).label,
    '未出題の問題がありません');
});

// ---- 毎時の出題と「次の出題」の表示（シートは偽物）----

function fakeSheet(values) {
  return {
    values,
    getDataRange: () => ({ getValues: () => values }),
    getRange: (r, c) => ({
      getValue: () => values[r - 1][c - 1],
      setValue: (v) => { values[r - 1][c - 1] = v; },
      setValues: (vs) => vs[0].forEach((v, i) => { values[r - 1][c - 1 + i] = v; })
    })
  };
}

test('毎時の出題: お休み・始める日の前は出さず、条件が整えば1日1問だけ出して表示を更新する', () => {
  const warnings = [];
  const g = loadGas({ console: { log() {}, warn: (m) => warnings.push(m), error() {} } });
  const { ctx } = g;
  const COL = g.get('QUIZ_COL');
  const label = (key) => ctx.quizSettingItem_(key).label;

  const blank = () => ['', '', '', '', '', ''];
  const q = (number, text) => { const r = blank(); r[COL.NUMBER] = number; r[COL.TEXT] = text; return r; };
  const questions = fakeSheet([['問題番号', '問題文', '画像', '出題日時', '状態', 'TS'], q('Q1', '問1'), q('Q2', '問2')]);
  const settings = fakeSheet([
    ['項目', '値', '説明'],
    ['投稿先チャンネル', '#quiz', ''], [label('RUN'), '出題する', ''], [label('START_DATE'), '', ''],
    [label('NEXT'), '', ''], ['投稿時刻', '9', ''], ['土日は休む', 'いいえ', ''],
    ['見出し', '*Q({number})*', ''], ['記録する絵文字', 'tabutta', ''], ['Botの表示名', '', ''], ['Botのアイコン', '', '']
  ]);
  const spreadsheet = { getSpreadsheetTimeZone: () => 'Asia/Tokyo', getSheetByName: (n) => ({ 'クイズ問題': questions, 'クイズ設定': settings })[n] || null };
  const set = (name, value) => { settings.values.find((r) => r[0] === name)[1] = value; };
  const nextLabel = () => settings.values.find((r) => r[0] === label('NEXT'))[1];

  // 時計: new Date() だけ差し替える
  const RealDate = Date;
  let current = null;
  const ClockDate = class extends RealDate { constructor(...a) { a.length ? super(...a) : super(current); } };
  const posts = [];
  g.stub({
    Date: ClockDate,
    // 日付をそのまま文字にするだけの偽物。書式（区切り）は、出題日の比較と日付セルの読み取りの両方で使われる
    Utilities: {
      formatDate: (d, tz, format) => {
        const sep = format.includes('/') ? '/' : '-';
        return d.getFullYear() + sep + (d.getMonth() + 1) + sep + d.getDate();
      }
    },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    getConfig_: () => ({ managementSpreadsheetId: 'x' }),
    SpreadsheetApp: { openById: () => spreadsheet },
    resolveChannelId_: () => 'C1',
    postQuizMessage_: (config, channel, s, text) => { posts.push(text); return '111.222'; }
  });
  const runAt = (date) => { current = date; warnings.length = 0; ctx.postDailyQuiz(); };

  set(label('RUN'), 'お休み');
  runAt(new RealDate(2026, 9, 12, 10));
  assert.equal(posts.length, 0);
  assert.equal(nextLabel(), 'お休み中です');

  set(label('RUN'), '出題する');
  set(label('START_DATE'), new RealDate(2026, 9, 13));            // 明日から
  runAt(new RealDate(2026, 9, 12, 15));
  assert.equal(posts.length, 0, '始める日の前は、時刻を過ぎていても出さない');
  assert.equal(nextLabel(), '明日 10/13(火) 9時ごろ(Q1)');

  set(label('START_DATE'), 'あした');
  runAt(new RealDate(2026, 9, 12, 15));
  assert.equal(posts.length, 0, '日付が読めなければ出さない');
  assert.ok(warnings.some((m) => m.includes('出題を始める日')));

  set(label('START_DATE'), new RealDate(2026, 9, 12));            // 今日から
  runAt(new RealDate(2026, 9, 12, 15));
  assert.equal(posts.length, 1);
  assert.equal(questions.values[1][COL.STATUS], '出題済み');
  assert.equal(nextLabel(), '明日 10/13(火) 9時ごろ(Q2)');

  runAt(new RealDate(2026, 9, 12, 16));                            // 同じ日の次の毎時
  assert.equal(posts.length, 1, '1日1問');
});
