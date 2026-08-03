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
