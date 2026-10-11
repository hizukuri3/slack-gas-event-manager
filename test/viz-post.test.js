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
  assert.ok(text.startsWith('<@U111AAAA> さんがVizのレビューを募集しています :eyes:'));
  assert.ok(text.endsWith('このスレッドでレビューをお待ちしています :bar_chart:'));
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
  assert.ok(text.startsWith('メンバー さんが'), '投稿者を特定できないときは「メンバー」');
  assert.ok(text.indexOf('*新しい設問*') > 0);
  assert.ok(text.indexOf('*新しい設問*') < text.indexOf('レビューをお願いします'));
});

test('escapeSlackText_ は1つだけ定義され、null を空文字にする', () => {
  assert.equal(gas.ctx.escapeSlackText_(null), '');
  assert.equal(gas.ctx.escapeSlackText_('<!channel> & x'), '&lt;!channel&gt; &amp; x');
});
