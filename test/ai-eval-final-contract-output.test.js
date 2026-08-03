'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const contract = require('../lib/ai-answer-contract');

const ROOT = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('null portfolio levels remain null instead of becoming zero', () => {
  const answer = contract.normalizeAnswer({
    direct_answer: 'Data belum cukup.',
    levels: {
      last: null,
      entry_low: 109,
      entry_high: null,
      stop_loss: 100,
      tp1: 185,
      tp2: 210
    },
    source_scope: 'snapshot'
  });
  assert.equal(answer.levels.last, null);
  assert.equal(answer.levels.entry_high, null);
  assert.equal(answer.levels.entry_low, 109);
});

test('database snapshot descriptions normalize to snapshot scope', () => {
  const answer = contract.normalizeAnswer({
    direct_answer: 'Jawaban berbasis snapshot.',
    levels: {},
    source_scope: 'snapshot database 2026-08-02T21:48:51Z'
  });
  assert.equal(answer.source_scope, 'snapshot');
});

test('plain small counters do not fail financial grounding', () => {
  const result = contract.validateAnswer({
    direct_answer: 'Ada 6 hal yang perlu dicek. Entry tetap di 112 dan target di 120.',
    reasoning: 'Dua skenario utama tetap memakai level dari snapshot.',
    action: 'Tunggu entry 112.',
    invalidation: 'Batal jika level 109 ditembus.',
    levels: { last: 114, entry_low: 112, entry_high: null, stop_loss: 109, tp1: 120, tp2: null },
    source_scope: 'snapshot'
  }, {
    allowed_numbers: [109, 112, 114, 120],
    require_snapshot_scope: true
  });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('unsupported price percentage and lot numbers still fail grounding', () => {
  const result = contract.validateAnswer({
    direct_answer: 'Entry di 6, risikonya 7%, lalu tambah 8 lot.',
    action: 'Tunggu.',
    invalidation: 'Ikuti stop.',
    levels: {},
    source_scope: 'snapshot'
  }, {
    allowed_numbers: [109, 112, 114, 120],
    require_snapshot_scope: true
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' | '), /6/);
  assert.match(result.errors.join(' | '), /7/);
  assert.match(result.errors.join(' | '), /8/);
});

test('Indonesian rupiah groups keep their leading digits', () => {
  const values = contract.financialNumbersInText(
    'Profit Rp2.280.000, risiko Rp1.800, sisa Rp9.978.200, batas Rp16.667, dan dana Rp2,5 juta.'
  );
  assert.deepEqual(values, [2280000, 1800, 9978200, 16667, 2500000]);
});

test('valid Indonesian currency values pass exact grounding', () => {
  const result = contract.validateAnswer({
    direct_answer: 'Profit kotor Rp2.280.000 dengan tambahan risiko Rp1.800.',
    reasoning: 'Dana Rp2,5 juta menyisakan Rp2.478.200.',
    action: 'Tetap gunakan stop 100.',
    invalidation: 'Batal jika stop 100 ditembus.',
    levels: { last: null, entry_low: 109, entry_high: 109, stop_loss: 100, tp1: 185, tp2: 210 },
    source_scope: 'snapshot'
  }, {
    allowed_numbers: [100, 109, 185, 210, 1800, 2280000, 2478200, 2500000],
    require_snapshot_scope: true
  });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('technical lookback periods and parenthesized list counters are ignored', () => {
  const result = contract.validateAnswer({
    direct_answer: 'Volume 0,51x rata-rata 20 hari dan 0,73x rata-rata 7 hari.',
    reasoning: 'Harga 114 berada di bawah MA20 114,6, sedangkan RSI14 tetap netral.',
    action: 'Lengkapi (1) harga terkini, (2) budget, dan (3) journal.',
    invalidation: 'Batal jika 112 ditembus.',
    levels: { last: 114, entry_low: 112, entry_high: 114.6, stop_loss: 112, tp1: null, tp2: null },
    source_scope: 'snapshot'
  }, {
    allowed_numbers: [0.51, 0.73, 112, 114, 114.6],
    require_snapshot_scope: true
  });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('unsupported Indonesian currency still fails grounding', () => {
  const result = contract.validateAnswer({
    direct_answer: 'Profit kotor Rp2.999.000.',
    action: 'Tunggu.',
    invalidation: 'Ikuti stop 100.',
    levels: { stop_loss: 100 },
    source_scope: 'snapshot'
  }, {
    allowed_numbers: [100, 2280000],
    require_snapshot_scope: true
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' | '), /2999000/);
});

test('one-time launcher uses high output caps and bounded retries', () => {
  const launcher = read('tools/run-ai-eval-once.sh');
  const bounded = read('tools/run-ai-eval-cloud-bounded.js');
  const diagnostic = read('tools/diagnose-ai-eval-pilot.js');

  assert.match(launcher, /--max-output-tokens=8192/);
  assert.match(launcher, /--judge-max-tokens=2048/);
  assert.match(launcher, /AI_EVAL_MAX_ATTEMPTS_PER_CASE="\$\{AI_EVAL_RUN_MAX_ATTEMPTS_PER_CASE:-\$\{AI_EVAL_MAX_ATTEMPTS_PER_CASE:-3\}\}"/);
  assert.match(launcher, /--max-attempts-per-case="\$AI_EVAL_MAX_ATTEMPTS_PER_CASE"/);
  assert.match(bounded, /max-attempts-per-case/);
  assert.match(bounded, /rejections\.jsonl/);
  assert.match(diagnostic, /ANSWER_MAX_TOKENS = 8192/);
  assert.match(diagnostic, /JUDGE_MAX_TOKENS = 2048/);
});