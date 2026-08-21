'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const normalizer = require('../tools/openagentic-response-normalizer');
const quality = require('../tools/generate-ai-eval-quality-dataset');

const ROOT = path.join(__dirname, '..');

test('OpenAgentic JSON plus DONE trailer is normalized without changing payload', () => {
  const raw = '{"model":"auto","choices":[{"message":{"content":"OK"}}],"usage":{"total_tokens":4112}}data: [DONE]';
  const cleaned = normalizer.normalizeProviderBody(raw);
  const parsed = JSON.parse(cleaned);
  assert.equal(parsed.choices[0].message.content, 'OK');
  assert.equal(parsed.model, 'auto');
  assert.equal(parsed.usage.total_tokens, 4112);
});

test('normalizer accepts regular JSON and SSE data frames', () => {
  assert.equal(normalizer.normalizeProviderBody('{"ok":true}'), '{"ok":true}');
  // SSE reassembly requires a real OpenAI-style chat-completion chunk shape
  // (choices[0].delta.content) — parseSseBody() rejects a stream that carries
  // no assistant content as "Provider stream selesai tanpa isi jawaban."
  // (guards against silently passing through an empty/garbage stream).
  const sse = 'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n';
  const reassembled = JSON.parse(normalizer.normalizeProviderBody(sse));
  assert.equal(reassembled.choices[0].message.content, 'OK');
});

test('quality generator fingerprint ignores case id but keeps meaningful context', () => {
  const a = { id: 'a', task: 'stock_analysis_followup', intent: 'entry', question: 'Entry di mana?', context: { ticker: 'BBCA', captured_at: 'x', analysis_text: 'Harga 100' }, expected: { allowed_numbers: [100] } };
  const b = { ...a, id: 'b', context: { ...a.context, captured_at: 'y' } };
  const c = { ...a, id: 'c', context: { ...a.context, analysis_text: 'Harga 105' } };
  assert.equal(quality.fingerprint(a).toString('hex'), quality.fingerprint(b).toString('hex'));
  assert.notEqual(quality.fingerprint(a).toString('hex'), quality.fingerprint(c).toString('hex'));
});

test('Bloom filter rejects repeated semantic cases without storing one million hashes', () => {
  const bloom = new quality.BloomFilter(20, 7);
  const digest = quality.fingerprint({ task: 'portfolio_chat', intent: 'risk', question: 'Risikonya?', context: { plans: [{ ticker: 'BBRI' }] } });
  assert.equal(bloom.hasAndAdd(digest), false);
  assert.equal(bloom.hasAndAdd(digest), true);
  assert.equal(bloom.bits.length, 131072);
});

test('launcher treats one million as a quality-first upper bound and supports deliberate budget extension', () => {
  const launcher = fs.readFileSync(path.join(ROOT, 'tools/run-ai-eval-once.sh'), 'utf8');
  // The launcher was refactored into a sharded cloud pipeline: it invokes
  // generate-ai-eval-complete-dataset.js, which requires generate-ai-eval-quality-dataset.js
  // internally (Bloom-filter/fingerprint dedup logic), and run-ai-eval-cloud-bounded.js,
  // which requires openagentic-response-normalizer.js. Neither dependency's filename is
  // named directly in the shell script anymore, so verify the composition on disk instead.
  assert.match(launcher, /generate-ai-eval-complete-dataset\.js/);
  assert.match(launcher, /run-ai-eval-cloud-bounded\.js/);
  assert.match(launcher, /Generating up to/);
  assert.match(launcher, /AI_EVAL_CASE_TARGET:-1000000/);
  assert.match(launcher, /AI_EVAL_TOKEN_BUDGET:-50000000/);
  const completeDatasetSrc = fs.readFileSync(path.join(ROOT, 'tools/generate-ai-eval-complete-dataset.js'), 'utf8');
  assert.match(completeDatasetSrc, /require\(['"]\.\/generate-ai-eval-quality-dataset['"]\)/);
  const cloudBoundedSrc = fs.readFileSync(path.join(ROOT, 'tools/run-ai-eval-cloud-bounded.js'), 'utf8');
  assert.match(cloudBoundedSrc, /openagentic-response-normalizer/);
});
