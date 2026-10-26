const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./harness');

const gas = loadGas();
const T = gas.get('VIZ_FORM_TITLES');
const build = gas.ctx.buildVizPostText_;

test('ナイスチャレンジの投稿: 見出しと並びは固定で、フォームの並びに左右されない', () => {
  const text = build({
    [T.CONSULT]: '投稿するVizを改善したい',
    [T.ROOM]: 'ひづ部屋',
    [T.WANT]: 'ざっくり（方向性・イメージ）',
    [T.STATE]: 'アイデア出し中',
    [T.TARGET]: 'その他',
    [T.LINK]: 'https://example.com/a?b=1&c=2'
  }, 'U111AAAA', ['U111AAAA', 'U222BBBB', 'U333CCCC']);

  const headings = [...text.matchAll(/^\*(.+)\*$/gm)].map((m) => m[1]);
  assert.deepEqual(headings,
    ['所属部屋', '成果物のリンク', 'FBを受けたい対象', '成果物の状態', '欲しいFB', '相談内容']);
  assert.ok(text.startsWith('*所属部屋*'), '本文は設問から始まる（見出しと案内は親の投稿）');
  assert.ok(text.endsWith('<@U222BBBB> <@U333CCCC> レビューをお願いします :pray:'));
  assert.ok(text.includes('a?b=1&amp;c=2'), '特殊文字はエスケープされる');
});

test('ナイスチャレンジの投稿: 本人が師匠のときは自分へのメンションを付けない', () => {
  const text = build({ [T.ROOM]: 'A部屋' }, 'U111AAAA', ['U111AAAA', 'U222BBBB']);
  assert.ok(text.includes('<@U222BBBB> レビューをお願いします :pray:'));
  assert.ok(!text.includes('<@U111AAAA> <@U222BBBB>'));
});

test('ナイスチャレンジの投稿: 空の設問は載せず、師匠が0人なら師匠の行も出ない', () => {
  const text = build({ [T.ROOM]: 'A部屋', [T.LINK]: 'x', [T.CONSULT]: '' }, 'U111AAAA', []);
  assert.ok(!text.includes('相談内容'));
  assert.ok(!text.includes('レビューをお願いします'));
});

test('ナイスチャレンジの投稿: 固定の見出しに無い設問は、設問名のまま末尾に載る（消えない）', () => {
  const text = build({ [T.ROOM]: 'A部屋', '新しい設問': '回答です' }, '', ['U222BBBB']);
  assert.ok(text.indexOf('*新しい設問*') > 0);
  assert.ok(text.indexOf('*新しい設問*') < text.indexOf('レビューをお願いします'));
});

test('escapeSlackText_ は1つだけ定義され、null を空文字にする', () => {
  assert.equal(gas.ctx.escapeSlackText_(null), '');
  assert.equal(gas.ctx.escapeSlackText_('<!channel> & x'), '&lt;!channel&gt; &amp; x');
});

test('ナイスチャレンジの投稿: 親の投稿は、詳細はスレッドにある旨つきの見出しと、概要・対象', () => {
  assert.equal(gas.ctx.buildVizParentText_('U111AAAA', {
    [T.SUMMARY]: '新人向けの売上ダッシュボードを作りました', [T.TARGET]: '組織内 Viz共有', [T.CONSULT]: '相談です'
  }), '<@U111AAAA> さんがVizのレビューを募集しています :eyes:（詳細はスレッドにて :point_down:）\n' +
    '概要: 新人向けの売上ダッシュボードを作りました\n対象: 組織内 Viz共有');
  assert.ok(gas.ctx.buildVizParentText_('', {}).startsWith('メンバー さんが'), '投稿者を特定できないときは「メンバー」');
});

test('ナイスチャレンジの投稿: 親の投稿は、回答が無い行を出さず、特殊文字をエスケープする', () => {
  const text = gas.ctx.buildVizParentText_('U111AAAA', { [T.SUMMARY]: 'A & <B>', [T.TARGET]: '' });
  assert.ok(text.includes('概要: A &amp; &lt;B&gt;'));
  assert.ok(!text.includes('対象'));
  assert.equal(gas.ctx.buildVizParentText_('U111AAAA').split('\n').length, 1, '回答が無ければ見出しだけ');
});

test('ナイスチャレンジの投稿: 概要は本文の「概要」にも載り、フォームの概要の設問は必須で成果物のリンクの前にある', () => {
  assert.ok(build({ [T.SUMMARY]: 'ひとこと' }, '', []).startsWith('*概要*\nひとこと'));
  const spec = gas.ctx.vizFormSpec_();
  const i = spec.findIndex((x) => x.title === T.SUMMARY);
  assert.ok(i > 0 && spec[i].required);
  assert.equal(spec[i + 1].title, T.LINK);
});

test('ナイスチャレンジの投稿: 回答が全部空で師匠もいなくても、本文は空にならない', () => {
  assert.notEqual(build({}, '', []), '');
});

test('ナイスチャレンジの投稿: 本文を親に載せていた頃の形は、見出し・本文・末尾の文のまま', () => {
  const body = build({ [T.ROOM]: 'A部屋' }, 'U111AAAA', ['U222BBBB']);
  const legacy = gas.ctx.buildVizLegacyPostText_(body, 'U111AAAA');
  assert.ok(legacy.startsWith('<@U111AAAA> さんがVizのレビューを募集しています :eyes:\n\n*所属部屋*'));
  assert.ok(legacy.endsWith('\n\nこのスレッドでレビューをお待ちしています :bar_chart:'));
});

// ---- 投稿の流れ（親 → 本文の返信 → ログ）----
function flow(postResults) {
  const g = loadGas();
  const calls = { posts: [], api: [], dms: [], recorded: [] };
  const sheet = { getDataRange: () => ({ getValues: () => [[]] }) };
  g.stub({
    resolveChannelId_: () => 'C1',
    getOrCreateSheet_: () => sheet,
    slackUserExists_: () => true,
    postVizMessage_: (config, ch, settings, text, threadTs) => {
      calls.posts.push({ text, threadTs });
      return postResults.shift();
    },
    callSlackApi_: (config, method, payload) => { calls.api.push({ method, payload }); return { ok: true }; },
    sendDirectMessage_: (config, user, text) => calls.dms.push(user),
    recordVizPost_: (...args) => { calls.recorded.push(args); return 2; },
    notifyVizAuthor_: () => {},
    deleteVizResponse_: () => true
  });
  const e = { source: {}, response: {
    getId: () => 'R1',
    getItemResponses: () => [
      { getItem: () => ({ getTitle: () => g.get('VIZ_FORM_TITLES').ROOM }), getResponse: () => 'A部屋' },
      { getItem: () => ({ getTitle: () => g.get('VIZ_FORM_TITLES').SUMMARY }), getResponse: () => 'ひとこと' },
      { getItem: () => ({ getTitle: () => 'author' }), getResponse: () => 'U111AAAA' }
    ]
  } };
  const settings = { channel: '#c', authorQuestion: 'author', retentionDays: 7 };
  g.ctx.postVizReviewRequest_({ masterUserIds: ['U222BBBB'] }, {}, settings, e);
  return calls;
}

test('ナイスチャレンジの投稿の流れ: 親を出し、その返信に本文を載せ、両方のtsをログに残す', () => {
  const calls = flow(['111.1', '222.2']);
  assert.equal(calls.posts.length, 2);
  assert.equal(calls.posts[0].threadTs, undefined);
  assert.ok(calls.posts[0].text.includes('（詳細はスレッドにて :point_down:）'));
  assert.ok(calls.posts[0].text.includes('概要: ひとこと'), '親に概要が載る');
  assert.equal(calls.posts[1].threadTs, '111.1', '本文は親のスレッドへ');
  assert.ok(calls.posts[1].text.includes('*所属部屋*'));
  const [, authorId, text, channelId, messageTs, responseId, bodyTs] = calls.recorded[0];
  assert.deepEqual([authorId, channelId, messageTs, responseId, bodyTs], ['U111AAAA', 'C1', '111.1', 'R1', '222.2']);
  assert.equal(text, calls.posts[1].text, '投稿内容には本文を残す');
});

test('ナイスチャレンジの投稿の流れ: 本文の投稿に失敗したら、親を消して本人へ知らせ、ログには残さない', () => {
  const calls = flow(['111.1', null]);
  assert.deepEqual(calls.api.map((c) => c.method), ['chat.delete']);
  assert.equal(calls.api[0].payload.ts, '111.1');
  assert.deepEqual(calls.dms, ['U111AAAA']);
  assert.equal(calls.recorded.length, 0);
});

test('ナイスチャレンジの投稿の流れ: 親の投稿に失敗したら、本文は投稿しない', () => {
  const calls = flow([null]);
  assert.equal(calls.posts.length, 1);
  assert.equal(calls.recorded.length, 0);
});

// ---- 投稿の検索と回答の編集 ----
function logSheet(rows) {
  const g = loadGas();
  const C = g.get('VIZ_LOG_COL');
  const values = [[]].concat(rows.map((r) => {
    const row = [];
    row[C.AUTHOR] = 'U111AAAA'; row[C.CHANNEL] = 'C1'; row[C.MESSAGE_TS] = r.parent;
    row[C.RESPONSE_ID] = r.response; row[C.BODY_TS] = r.body;
    return row;
  }));
  return { g, sheet: { getDataRange: () => ({ getValues: () => values }) }, spreadsheet: { getSheetByName: () => ({ getDataRange: () => ({ getValues: () => values }) }) } };
}

test('投稿の検索: 親のtsでも本文の返信のtsでも見つかり、どちらも親のtsを返す。旧形式の行（本文の返信IDなし）も探せる', () => {
  const { g, spreadsheet } = logSheet([{ parent: '1.1', body: '1.2', response: 'R1' }, { parent: '2.1', body: undefined, response: 'R2' }]);
  assert.equal(g.ctx.findVizPostByTs_(spreadsheet, '1.1').messageTs, '1.1');
  assert.equal(g.ctx.findVizPostByTs_(spreadsheet, '1.2').messageTs, '1.1');
  assert.equal(g.ctx.findVizPostByTs_(spreadsheet, '2.1').messageTs, '2.1');
  assert.equal(g.ctx.findVizPostByTs_(spreadsheet, ''), null, '空のtsで旧形式の行に当たらない');
  assert.equal(g.ctx.findVizPostByTs_(spreadsheet, '9.9'), null);
});

test('回答の編集: 本文の返信があれば返信と親の見出しを、旧形式の投稿なら親の投稿だけを書き換える', () => {
  const g = loadGas();
  const updates = [];
  g.stub({ callSlackApi_: (c, m, p) => { updates.push(p); return { ok: true }; } });
  const log = { getRange: () => ({ setValue() {} }) };
  const T2 = g.get('VIZ_FORM_TITLES');
  const answers = { [T2.ROOM]: 'B部屋', [T2.SUMMARY]: '直した概要' };
  const base = { rowNumber: 2, author: 'U111AAAA', channel: 'C1', messageTs: '1.1' };
  g.ctx.updateVizPost_({ masterUserIds: [] }, log, answers, Object.assign({ bodyTs: '1.2' }, base));
  assert.equal(updates.length, 2);
  assert.equal(updates[0].ts, '1.2');
  assert.ok(updates[0].text.startsWith('*所属部屋*'));
  assert.equal(updates[1].ts, '1.1', '親の見出しも直す');
  assert.ok(updates[1].text.includes('概要: 直した概要'));

  updates.length = 0;
  g.ctx.updateVizPost_({ masterUserIds: [] }, log, answers, Object.assign({ bodyTs: '' }, base));
  assert.equal(updates.length, 1);
  assert.equal(updates[0].ts, '1.1');
  assert.ok(updates[0].text.startsWith('<@U111AAAA> さんが'));
  assert.ok(updates[0].text.endsWith('このスレッドでレビューをお待ちしています :bar_chart:'));
});
