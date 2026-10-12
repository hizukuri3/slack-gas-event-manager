// ドキュメントがコードとずれていないかの点検。コードを足したのにドキュメントを直し忘れる、を
// PR の時点で見つける。内容の正しさまでは見ない（存在と一致だけ）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const list = (dir, ext) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith(ext)).sort();
const allSource = list('src', '.gs').map((f) => read('src/' + f)).join('\n');

test('README のリポジトリ構成に、src のすべてのファイルが載っている', () => {
  const readme = read('README.md');
  const missing = list('src', '.gs').filter((f) => !readme.includes(f));
  assert.deepEqual(missing, []);
});

test('README のリポジトリ構成に、ワークフローとテストが載っている', () => {
  const readme = read('README.md');
  const missing = list('.github/workflows', '.yml').filter((f) => !readme.includes(f));
  assert.deepEqual(missing, []);
  assert.ok(readme.includes('test/'), 'test/ が載っていない');
  assert.ok(readme.includes('package.json'), 'package.json が載っていない');
});

test('運用手順「実行ログの見方」のログが、コードに実在する', () => {
  const ops = read('docs/OPERATIONS.md');
  const section = ops.split('### 実行ログの見方')[1];
  assert.ok(section, '「実行ログの見方」の節が無い');
  const phrases = section.split('\n')
    .filter((line) => line.startsWith('|') && !line.startsWith('|---') && !line.startsWith('| ログ'))
    .map((line) => line.split('|')[1].trim().replace(/[:：]\s*…$/, '').replace(/…$/, '').trim())
    .filter(Boolean);
  assert.ok(phrases.length >= 5, 'ログの行が読み取れない');
  const missing = phrases.filter((p) => !allSource.includes(p));
  assert.deepEqual(missing, []);
});

test('運用手順の「次の出題」の表示（固定の文言）が、コードに実在する', () => {
  const ops = read('docs/OPERATIONS.md');
  const section = ops.split('**Q. クイズが出題されない**')[1].split('### 実行ログの見方')[0];
  const labels = section.split('\n')
    .filter((line) => line.startsWith('|') && !line.startsWith('|---') && !line.startsWith('| 「次の出題」'))
    .map((line) => line.split('|')[1].trim())
    .filter((text) => !text.startsWith('日付と時刻'));
  assert.ok(labels.length >= 5);
  const missing = labels.filter((p) => !allSource.includes(p));
  assert.deepEqual(missing, []);
});
