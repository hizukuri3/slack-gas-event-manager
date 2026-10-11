const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadGas } = require('./harness');

const gas = loadGas();
const normalize = gas.ctx.normalizeSlackUserId_;
const isValid = gas.ctx.isValidSlackUserId_;

test('SlackユーザーIDの正規化: コピーして貼った形をそろえる', () => {
  assert.equal(normalize('U0123ABCD'), 'U0123ABCD');
  assert.equal(normalize(' U0123ABCD '), 'U0123ABCD');
  assert.equal(normalize('<@U0123ABCD>'), 'U0123ABCD');
  assert.equal(normalize('<@U0123ABCD|ひづ>'), 'U0123ABCD');
  assert.equal(normalize('@U0123ABCD'), 'U0123ABCD');
  assert.equal(normalize('u0123abcd'), 'U0123ABCD');
  assert.equal(normalize(null), '');
});

test('SlackユーザーIDの形式: U/W始まりの英数字', () => {
  assert.equal(isValid('U0123ABCD'), true);
  assert.equal(isValid('W012ABCDE'), true);
  assert.equal(isValid('abc'), false);
  assert.equal(isValid('U12'), false);
  assert.equal(isValid(''), false);
  assert.equal(isValid('U0123 ABCD'), false);
});

test('主催者IDのフォーム側の形式チェックは、サーバー側の判定と食い違わない', () => {
  // applyFormHints_ に書いた正規表現を取り出して、サーバー側（正規化→形式）と同じ結論になるか
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'FormHandler.gs'), 'utf8');
  const literal = src.match(/requireTextMatchesPattern\('([^']+)'\)/);
  assert.ok(literal, '形式チェックの正規表現が見つからない');
  const re = new RegExp(literal[1].replace(/\\\\/g, '\\'));
  const cases = ['U0123ABCD', ' U0123ABCD ', '<@U0123ABCD>', '<@U0123ABCD|ひづ>', '@U0123ABCD',
    'u0123abcd', 'W012ABCDE', 'abc', '', 'U12', 'メンバー', 'U0123 ABCD'];
  cases.forEach((input) => {
    assert.equal(re.test(input), isValid(normalize(input)), JSON.stringify(input));
  });
});
