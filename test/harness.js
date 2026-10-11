// GASのファイル（src/*.gs）を、テストから呼べる形で読み込む。
//
// GASは全ファイルを1つの空間に、ファイル名の昇順で読み込む。ここでも同じ順に1つの
// vm 空間へ読み込むので、ファイル間の関数・定数はそのまま見える。
// SpreadsheetApp などのGASのサービスは渡さない（渡した物だけが使える）。
// 外部へ出る処理は、テストごとに関数を差し替えて確かめる。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src');

function loadGas(globals) {
  const sandbox = Object.assign({ console: { log() {}, warn() {}, error() {} } }, globals || {});
  const ctx = vm.createContext(sandbox);
  fs.readdirSync(SRC).filter((f) => f.endsWith('.gs')).sort().forEach((f) => {
    vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f });
  });
  return {
    ctx,
    // const で宣言された定数も取れる（function と違い、空間の変数にはならないため）
    get: (name) => vm.runInContext(name, ctx),
    // 関数を差し替える（外部サービスへ出る処理を偽物にする）
    stub: (fns) => Object.assign(ctx, fns)
  };
}

// vm の空間で作られた配列・オブジェクトは、assert.deepStrictEqual で別物扱いになる。
// 比べる前に、普通のオブジェクトにそろえる
const plain = (value) => JSON.parse(JSON.stringify(value));

module.exports = { loadGas, plain };
