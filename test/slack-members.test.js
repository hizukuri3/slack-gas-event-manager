const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas, plain } = require('./harness');

const gas = loadGas();
const toMember = gas.ctx.toSlackMember_;
const merge = gas.ctx.mergeSlackMembers_;

test('メンバーの取り込み: 退会済み・Botは載せず、ゲストは載せる', () => {
  assert.equal(toMember({ id: 'U1', deleted: true, profile: {} }), null);
  assert.equal(toMember({ id: 'U2', is_bot: true, profile: {} }), null);
  assert.equal(toMember({ id: 'USLACKBOT', profile: {} }), null);
  assert.deepEqual(plain(toMember({ id: 'U3', is_restricted: true, profile: { display_name: 'ゲスト' } })),
    { id: 'U3', name: 'ゲスト' });
});

test('表示名が空なら実名、実名も空ならアカウント名で代替する', () => {
  assert.equal(toMember({ id: 'U1', name: 'acct', profile: { display_name: '', real_name: '山田' } }).name, '山田');
  assert.equal(toMember({ id: 'U1', name: 'acct', profile: {} }).name, 'acct');
});

test('重ね合わせ: 既存の人は表示名だけ更新、新しい人は末尾、退会者の行と並び順は保つ', () => {
  const existing = [['U2', '旧B'], ['U9', '退会した人'], ['U1', 'A']];
  const members = [{ id: 'U1', name: 'A' }, { id: 'U2', name: '新B' }, { id: 'U3', name: 'C' }];
  const result = plain(merge(existing, members));
  assert.deepEqual(result.rows, [['U2', '新B'], ['U9', '退会した人'], ['U1', 'A'], ['U3', 'C']]);
  assert.deepEqual(result.changedRows, [0, 3]);
  assert.equal(result.added, 1);
  assert.equal(result.renamed, 1);
});

test('重ね合わせ: 同じ内容でもう一度実行しても、何も書き込まない', () => {
  const members = [{ id: 'U1', name: 'A' }];
  const first = plain(merge([], members));
  const second = plain(merge(first.rows, members));
  assert.deepEqual(second.rows, first.rows);
  assert.deepEqual(second.changedRows, []);
});
