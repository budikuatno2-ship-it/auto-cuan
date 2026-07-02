'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Extract pure CSV helpers via vm (no supabase dependency needed).
function loadForeignHelpers() {
  const src = fs.readFileSync('api/sector-hot.js', 'utf8');
  function extract(name) {
    const marker = 'function ' + name + '(';
    const start = src.indexOf(marker);
    assert.ok(start >= 0, 'could not find ' + name);
    let i = src.indexOf('{', start);
    let depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return src.slice(start, i);
  }
  const sandbox = { isFinite, Number, String, Array, Object, Math, Date, Buffer };
  vm.createContext(sandbox);
  vm.runInContext(
    extract('parseForeignCsvLine') + '\n' +
    extract('parseForeignNumber') + '\n' +
    extract('normalizeForeignDate') + '\n' +
    extract('normalizeForeignTicker') + '\n' +
    extract('parseForeignImportCsv'),
    sandbox
  );
  return sandbox;
}

const helpers = loadForeignHelpers();

function buildCsv(rowCount) {
  const lines = ['date,ticker,open,high,low,close,volume,freq,valuasi,nbsa'];
  for (let i = 0; i < rowCount; i++) {
    const d = String(1 + (i % 28)).padStart(2, '0');
    lines.push('2026-06-' + d + ',TICK' + i + ',100,110,90,105,1000,50,105000,200');
  }
  return lines.join('\n');
}

test('parseForeignImportCsv parses a large CSV (foreign upload can be chunked by caller)', () => {
  const csv = buildCsv(959);
  const rows = helpers.parseForeignImportCsv(csv);
  assert.equal(rows.length, 959);
  // foreign_net computed from nbsa * close
  assert.equal(rows[0].foreign_net, 200 * 105);
  assert.equal(rows[0].source, 'csv');
});

test('helper to split rows into batches yields small chunks (<=200)', () => {
  const csv = buildCsv(959);
  const rows = helpers.parseForeignImportCsv(csv);
  const CHUNK = 200;
  const batches = [];
  for (let i = 0; i < rows.length; i += CHUNK) batches.push(rows.slice(i, i + CHUNK));
  assert.equal(batches.length, 5); // 959 -> 200*4 + 159
  batches.forEach((b) => assert.ok(b.length <= 200));
  const total = batches.reduce((a, b) => a + b.length, 0);
  assert.equal(total, 959);
});

test('parseForeignImportCsv rejects duplicate trade_date+ticker rows', () => {
  const csv = [
    'date,ticker,open,high,low,close,volume,freq,valuasi,nbsa',
    '2026-06-01,BINA,100,110,90,105,1000,50,105000,200',
    '2026-06-01,BINA,100,110,90,105,1000,50,105000,200'
  ].join('\n');
  assert.throws(() => helpers.parseForeignImportCsv(csv), /Duplicate/);
});
