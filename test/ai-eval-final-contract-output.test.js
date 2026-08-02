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

test('one-time launcher uses high output caps and bounded retries', () => {
  const launcher = read('tools/run-ai-eval-once.sh');
  const bounded = read('tools/run-ai-eval-cloud-bounded.js');
  const diagnostic = read('tools/diagnose-ai-eval-pilot.js');

  assert.match(launcher, /--max-output-tokens=8192/);
  assert.match(launcher, /--judge-max-tokens=2048/);
  assert.match(launcher, /AI_EVAL_MAX_ATTEMPTS_PER_CASE="\$\{AI_EVAL_MAX_ATTEMPTS_PER_CASE:-3\}"/);
  assert.match(bounded, /max-attempts-per-case/);
  assert.match(bounded, /rejections\.jsonl/);
  assert.match(diagnostic, /ANSWER_MAX_TOKENS = 8192/);
  assert.match(diagnostic, /JUDGE_MAX_TOKENS = 2048/);
});
