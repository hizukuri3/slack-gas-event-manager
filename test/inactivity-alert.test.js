const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas, plain } = require('./harness');

const gas = loadGas();
const parse = gas.ctx.parseInactivityRules_;
const collect = gas.ctx.collectActiveUserIds_;
const findInactive = gas.ctx.findInactiveMembers_;
const due = gas.ctx.isInactivityRuleDue_;

// 列: 師匠ID, 表示名, チャンネル, 日数, 頻度, 除外, 有効, メモ
const row = (o) => [o.id ?? 'U11111', '', o.ch ?? 'room', o.days ?? 14, o.freq ?? '', o.ex ?? '', o.en ?? '', ''];

test('設定の読み取り: 必須3項目だけで読め、頻度は日数で決まり、除外は空になる', () => {
  const r = plain(parse([row({})]));
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.rules, [{ masterId: 'U11111', channel: 'room', days: 14, frequency: '毎週月曜', excludeTokens: [] }]);
});

test('設定の読み取り: #付きチャンネル・<@U>形式を整え、除外はカンマ/改行で区切る（表示名の空白は残す）', () => {
  const r = plain(parse([row({ id: '<@u11111>', ch: '#room', ex: 'UAAA11, はやし\nlucia sai , ' })]));
  assert.equal(r.rules[0].masterId, 'U11111');
  assert.equal(r.rules[0].channel, 'room');
  assert.deepEqual(r.rules[0].excludeTokens, ['UAAA11', 'はやし', 'lucia sai']);
});

test('設定の読み取り: 無効の行・空行は黙って飛ばす', () => {
  const r = plain(parse([row({ en: '無効' }), ['', '', '', '', '', '', '', '']]));
  assert.deepEqual(r.rules, []);
  assert.deepEqual(r.problems, []);
});

test('設定の読み取り: 不正な行は理由つきで飛ばす（何行目かが分かる）', () => {
  const r = plain(parse([
    row({ id: 'abc' }), row({ ch: '' }), row({ days: 0 }), row({ days: 'あ' }), row({ freq: '毎月' })
  ]));
  assert.deepEqual(r.rules, []);
  assert.equal(r.problems.length, 5);
  assert.match(r.problems[0], /^2行目/);
  assert.match(r.problems[4], /^6行目/);
});

test('活動の集計: 投稿・スタンプ・返信を数え、入退室メッセージは数えない', () => {
  const messages = [
    { user: 'U1', text: 'hi' },
    { user: 'U2', reactions: [{ name: 'x', users: ['U3', 'U4'] }] },
    { user: 'U5', subtype: 'channel_join' }
  ];
  assert.deepEqual(plain(collect(messages)).sort(), ['U1', 'U2', 'U3', 'U4']);
});

test('対象者: 活動なし・除外・Bot/退会者・師匠本人を外し、参加者の並び順で返す', () => {
  const members = ['UM', 'U1', 'U2', 'UBOT', 'U3', 'U4'];
  const humans = ['UM', 'U1', 'U2', 'U3', 'U4'];
  const result = findInactive(members, humans, ['U1'], ['U3', 'UM']);
  assert.deepEqual(plain(result), ['U2', 'U4']);
});

test('通知頻度: 毎日は常に、毎週月曜は月曜だけ', () => {
  const monday = new Date(2026, 10, 2);   // 2026-11-02 月曜
  const tuesday = new Date(2026, 10, 3);
  assert.equal(due('毎日', tuesday), true);
  assert.equal(due('毎週月曜', monday), true);
  assert.equal(due('毎週月曜', tuesday), false);
});

test('通知文: 名前だけを並べ（メンションにしない）、記号は無害化し、除外の案内を含む', () => {
  const text = gas.ctx.buildInactivityMessage_('C1', 14, ['はやし', 'a<b>&c'], new Date(2026, 10, 18));
  assert.match(text, /<#C1>/);
  assert.match(text, /11\/18〜今日の14日間/);
  assert.match(text, /2名/);
  assert.match(text, /• はやし/);
  assert.match(text, /• a&lt;b&gt;&amp;c/);
  assert.doesNotMatch(text, /<@/);
  assert.match(text, /除外する人/);
});

const members = [
  { id: 'U1AAAA', name: 'はやし' }, { id: 'U2BBBB', name: 'Saya' },
  { id: 'U3CCCC', name: 'Dup' }, { id: 'U4DDDD', name: 'dup' }
];

test('人の特定: IDはそのまま、表示名はメンバー一覧から引く（@・空白・大文字小文字は無視）', () => {
  const resolve = (t) => plain(gas.ctx.resolveSlackPerson_(t, members)).id;
  assert.equal(resolve('<@U9ZZZZ>'), 'U9ZZZZ');
  assert.equal(resolve('はやし'), 'U1AAAA');
  assert.equal(resolve('@ saya '), 'U2BBBB');
});

test('人の特定: 見つからない・同名が複数のときは特定せず、理由を返す', () => {
  const none = plain(gas.ctx.resolveSlackPerson_('いない人', members));
  assert.equal(none.id, '');
  assert.match(none.reason, /いません/);
  const dup = plain(gas.ctx.resolveSlackPerson_('Dup', members));
  assert.equal(dup.id, '');
  assert.match(dup.reason, /複数/);
});

test('実行: 履歴が読めなかったら、誰にも通知せず師匠へ理由だけ送る', () => {
  const sent = [];
  gas.stub({
    resolveChannelId_: () => 'C1',
    listChannelMemberIds_: () => ['U1'],
    listRecentChannelMessages_: () => null,
    sendDirectMessage_: (_c, id, text) => sent.push([id, text])
  });
  gas.ctx.runInactivityRule_({}, { masterId: 'UM', channel: 'room', days: 7, excludeTokens: [] }, [{ id: 'U1', name: 'A' }], new Date());
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'UM');
  assert.match(sent[0][1], /実行できませんでした/);
});

test('実行: 該当者がいなければ何も送らない', () => {
  const sent = [];
  gas.stub({
    resolveChannelId_: () => 'C1',
    listChannelMemberIds_: () => ['U1'],
    listRecentChannelMessages_: () => [{ user: 'U1' }],
    sendDirectMessage_: (_c, id, text) => sent.push([id, text])
  });
  gas.ctx.runInactivityRule_({}, { masterId: 'UM', channel: 'room', days: 7, excludeTokens: [] }, [{ id: 'U1', name: 'A' }], new Date());
  assert.deepEqual(sent, []);
});

test('実行: 通知は表示名で出て、表示名で書かれた除外は外れる', () => {
  const sent = [];
  gas.stub({
    resolveChannelId_: () => 'C1',
    listChannelMemberIds_: () => ['UM', 'U1', 'U2', 'U3'],
    listRecentChannelMessages_: () => [],
    sendDirectMessage_: (_c, id, text) => sent.push([id, text])
  });
  const people = [{ id: 'UM', name: '師匠' }, { id: 'U1', name: 'はやし' },
    { id: 'U2', name: 'のびー' }, { id: 'U3', name: 'しげる' }];
  gas.ctx.runInactivityRule_({}, { masterId: 'UM', channel: 'room', days: 7, excludeTokens: ['のびー'] }, people, new Date());
  assert.equal(sent.length, 1);
  assert.match(sent[0][1], /• はやし/);
  assert.match(sent[0][1], /• しげる/);
  assert.doesNotMatch(sent[0][1], /のびー/);
  assert.doesNotMatch(sent[0][1], /師匠/);
});

test('実行: 手動実行のときだけ、該当者がいなくても「いません」と返す', () => {
  const sent = [];
  gas.stub({
    resolveChannelId_: () => 'C1',
    listChannelMemberIds_: () => ['U1'],
    listRecentChannelMessages_: () => [{ user: 'U1' }],
    sendDirectMessage_: (_c, id, text) => sent.push([id, text])
  });
  const rule = { masterId: 'UM', channel: 'room', days: 7, excludeTokens: [] };
  gas.ctx.runInactivityRule_({}, rule, [{ id: 'U1', name: 'A' }], new Date(2026, 10, 25), true);
  assert.equal(sent.length, 1);
  assert.match(sent[0][1], /11\/18〜今日の7日間/);
  assert.match(sent[0][1], /いません/);
});

test('通知文: 設定シートのURLがあればリンクにし、無ければ名前だけにする', () => {
  const since = new Date(2026, 10, 18);
  const url = 'https://docs.google.com/spreadsheets/d/XYZ/edit#gid=123';
  const withLink = gas.ctx.buildInactivityMessage_('C1', 14, ['A'], since, url);
  assert.ok(withLink.includes('<' + url + '|離脱アラート設定>シートの「除外する人」'));
  const without = gas.ctx.buildInactivityMessage_('C1', 14, ['A'], since);
  assert.ok(without.includes('「離脱アラート設定」シートの「除外する人」'));
  assert.doesNotMatch(without, /docs\.google/);
});

test('通知の絵文字: 該当者あり=:warning:、実行できなかった=:x:', () => {
  assert.match(gas.ctx.buildInactivityMessage_('C1', 7, ['A'], new Date(2026, 10, 18)), /^:warning:/);
  const sent = [];
  gas.stub({ sendDirectMessage_: (_c, id, text) => sent.push(text) });
  gas.ctx.notifyInactivityProblem_({}, { channel: 'room' }, 'UM', '理由');
  assert.match(sent[0], /^:x:/);
});

test('通知頻度が空欄のとき: 7日以上は毎週月曜、7日未満は毎日。選んであればそれを優先する', () => {
  const freq = (days, f) => plain(parse([row({ days, freq: f })])).rules[0].frequency;
  assert.equal(freq(7, ''), '毎週月曜');
  assert.equal(freq(6, ''), '毎日');
  assert.equal(freq(30, '毎日'), '毎日');
  assert.equal(freq(3, '毎週月曜'), '毎週月曜');
});
