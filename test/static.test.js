// GASは全ファイルを1つの空間に読み込むので、同名の関数・定数が別のファイルにあっても
// エラーにならず、後から読まれた方が黙って勝つ。それを検出する。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src');
const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.gs')).sort();
const sources = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(SRC, f), 'utf8')]));

function duplicates(pattern) {
  const seen = {};
  files.forEach((f) => {
    for (const m of sources[f].matchAll(pattern)) (seen[m[1]] = seen[m[1]] || []).push(f);
  });
  return Object.entries(seen).filter(([, where]) => where.length > 1)
    .map(([name, where]) => name + ' (' + where.join(', ') + ')');
}

test('どのファイルも構文として読める', () => {
  files.forEach((f) => assert.doesNotThrow(() => new vm.Script(sources[f], { filename: f }), f));
});

test('同名の関数が複数のファイルに定義されていない', () => {
  assert.deepEqual(duplicates(/^function\s+([A-Za-z0-9_$]+)\s*\(/gm), []);
});

test('同名のトップレベル定数が複数のファイルに定義されていない', () => {
  assert.deepEqual(duplicates(/^const\s+([A-Za-z0-9_$]+)\s*=/gm), []);
});

test('内部関数（末尾が _）の呼び出し先が、すべて定義されている', () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''").replace(/"(?:\\.|[^"\\\n])*"/g, '""');
  const defined = new Set();
  files.forEach((f) => {
    for (const m of sources[f].matchAll(/^function\s+([A-Za-z0-9_$]+_)\s*\(/gm)) defined.add(m[1]);
  });
  const missing = new Set();
  files.forEach((f) => {
    for (const m of strip(sources[f]).matchAll(/\b([A-Za-z0-9]+_)\s*\(/g)) {
      if (!defined.has(m[1])) missing.add(m[1] + ' (' + f + ')');
    }
  });
  assert.deepEqual([...missing], []);
});
