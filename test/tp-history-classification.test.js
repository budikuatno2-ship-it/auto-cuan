'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Extract pure functions (toNum + classifyWebTop5History) via vm so the test does not
// require '@supabase/supabase-js' (unavailable in this sandbox). These functions are
// self-contained and have no external dependencies.
function loadClassifier() {
  const src = fs.readFileSync('api/sector-hot.js', 'utf8');
  function extract(name) {
    const marker = 'function ' + name + '(';
    const start = src.indexOf(marker);
    assert.ok(start >= 0, 'could not find ' + name);
    // Find the matching closing brace by brace counting from first '{'
    let i = src.indexOf('{', start);
    let depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return src.slice(start, i);
  }
  const sandbox = { isFinite, Number, String, Array, Object, Math };
  vm.createContext(sandbox);
  vm.runInContext(extract('toNum') + '\n' + extract('classifyWebTop5History'), sandbox);
  return sandbox.classifyWebTop5History;
}

const classifyWebTop5History = loadClassifier();

function plan(overrides) {
  return Object.assign({
    ticker: 'TEST', entry1: 100, entry2: 98, sl: 90, tp1: 110, tp2: 120,
    status: 'WAITING', hit_tp1_at: null, hit_tp2_at: null, hit_sl_at: null
  }, overrides || {});
}

test('row with hit_tp1_at appears in TP History (tp bucket)', () => {
  const cls = classifyWebTop5History(plan({ hit_tp1_at: '2026-06-01T02:00:00Z' }), { last: 105, high: 105, low: 104, at: null });
  assert.equal(cls.bucket, 'tp');
  assert.equal(cls.tp1_hit, true);
});

test('row with hit_tp2_at appears in TP History (tp bucket)', () => {
  const cls = classifyWebTop5History(plan({ hit_tp2_at: '2026-06-01T02:00:00Z' }), { last: 108, high: 108, low: 107, at: null });
  assert.equal(cls.bucket, 'tp');
  assert.equal(cls.tp2_hit, true);
});

test('persisted TP1 hit takes precedence over current price below SL (stays in TP History)', () => {
  const cls = classifyWebTop5History(plan({ hit_tp1_at: '2026-06-01T02:00:00Z' }), { last: 85, high: 88, low: 84, at: null });
  assert.equal(cls.bucket, 'tp', 'past TP1 winner must not be reclassified as SL failed');
  assert.equal(cls.sl_hit, false);
});

test('price-based TP1 hit (high >= tp1) with no timestamp is classified as TP hit', () => {
  const cls = classifyWebTop5History(plan({}), { last: 112, high: 112, low: 111, at: null });
  assert.equal(cls.bucket, 'tp');
  assert.equal(cls.tp1_hit, true);
});

test('active row (no TP, no SL) stays in active bucket', () => {
  const cls = classifyWebTop5History(plan({}), { last: 102, high: 103, low: 101, at: null });
  assert.equal(cls.bucket, 'active');
});

test('SL hit with no prior TP goes to failed bucket', () => {
  const cls = classifyWebTop5History(plan({}), { last: 89, high: 91, low: 88, at: null });
  assert.equal(cls.bucket, 'failed');
  assert.equal(cls.sl_hit, true);
});

test('explicit status TP1_HIT classifies as tp even without timestamp or price', () => {
  const cls = classifyWebTop5History(plan({ status: 'TP1_HIT' }), { last: null, high: null, low: null, at: null });
  assert.equal(cls.bucket, 'tp');
  assert.equal(cls.tp1_hit, true);
});
