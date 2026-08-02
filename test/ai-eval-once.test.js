'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const generator = require('../tools/generate-ai-eval-dataset');
const contract = require('../lib/ai-answer-contract');
const cloud = require('../tools/run-ai-eval-cloud');

const ROOT = path.join(__dirname, '..');

function validAnswer(levels) {
  return {
    direct_answer: 'Area entry yang masih masuk akal ada di 980 sampai 1.000. Kamu sebaiknya tunggu harga kembali ke area itu.',
    data_used: ['Harga terakhir 1.020', 'Entry 980–1.000', 'Stop loss 930'],
    reasoning: 'Harga terakhir sudah sedikit di atas area entry, jadi mengejar harga bikin ruang risiko makin sempit.',
    action: 'Tunggu pullback ke area entry dan lihat apakah volumenya tetap mendukung.',
    invalidation: 'Setup batal bila harga menembus 930.',
    confidence: 'SEDANG',
    levels: levels || { last: 1020, entry_low: 980, entry_high: 1000, stop_loss: 930, tp1: 1080, tp2: 1150 },
    missing_data: [],
    warnings: ['Snapshot bukan harga real-time.'],
    source_scope: 'snapshot'
  };
}

const allowed = [1020, 980, 1000, 930, 1080, 1150];

test('generator creates both stock-analysis and portfolio cases', () => {
  const next = generator.rng(20260803);
  const stock = generator.makeStockCase(0, next);
  const portfolio = generator.makePortfolioCase(1, next);
  assert.equal(stock.task, 'stock_analysis_followup');
  assert.equal(portfolio.task, 'portfolio_chat');
  assert.ok(stock.context.analysis_text.includes('snapshot analisis'));
  assert.ok(Array.isArray(portfolio.context.plans));
  assert.ok(portfolio.context.plans.length >= 1);
  assert.equal(stock.expected.style, 'gen_z_natural_professional');
  assert.equal(portfolio.expected.style, 'gen_z_natural_professional');
});

test('answer contract accepts supported snapshot levels', () => {
  const result = contract.validateAnswer(validAnswer(), {
    allowed_numbers: allowed,
    require_snapshot_scope: true
  });
  assert.equal(result.valid, true, result.errors.join('; '));
});

test('answer contract rejects an invented number inside structured levels', () => {
  const answer = validAnswer({ last: 1020, entry_low: 980, entry_high: 1000, stop_loss: 777, tp1: 1080, tp2: 1150 });
  const result = contract.validateAnswer(answer, {
    allowed_numbers: allowed,
    require_snapshot_scope: true
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((message) => message.includes('level stop_loss tidak didukung sumber: 777')));
});

test('cloud deterministic evaluator rejects cringe language and unsupported certainty', () => {
  const testCase = {
    expected: {
      allowed_numbers: allowed,
      must_mention: ['980', '1000'],
      forbidden_phrases: ['pasti naik', 'gas full'],
      require_snapshot_scope: true,
      require_missing_data_notice: false,
      should_not_invent_realtime_data: true
    }
  };
  const answer = validAnswer();
  answer.direct_answer = 'Gas full, saham ini pasti naik dari 980 ke 1.000.';
  const result = cloud.deterministicEvaluation(testCase, answer);
  assert.equal(result.pass, false);
  assert.ok(result.errors.length >= 1);
});

test('hard token budget accounts for concurrent reservations', () => {
  const budget = new cloud.TokenBudget(1000, 100);
  assert.equal(budget.reserve(400), true);
  assert.equal(budget.reserve(550), false);
  budget.settle(400, 300);
  assert.equal(budget.used, 400);
  assert.equal(budget.remaining(), 600);
});

test('prompts request natural Gen Z style without influencer slang', () => {
  const answerPrompt = cloud.answerSystemPrompt('stock_analysis_followup');
  const judgePrompt = cloud.judgeSystemPrompt();
  assert.match(answerPrompt, /Gen Z yang natural/);
  assert.match(answerPrompt, /Jangan pakai bestie/);
  assert.match(judgePrompt, /bukan alay, bukan kaku/);
});

test('phone control page contains no provider or service-role secret', () => {
  const page = fs.readFileSync(path.join(ROOT, 'public/admin-ai-eval.html'), 'utf8');
  assert.ok(page.includes("fetch('/api/admin-users'"));
  assert.ok(!page.includes('AI_EVAL_API_KEY'));
  assert.ok(!page.includes('SUPABASE_SERVICE_ROLE_KEY'));
});

test('one-time launcher pins the agreed provider controls', () => {
  const launcher = fs.readFileSync(path.join(ROOT, 'tools/run-ai-eval-once.sh'), 'utf8');
  assert.ok(launcher.includes('https://openagentic.id/api/v1'));
  assert.ok(launcher.includes('claude-sonnet-4.6'));
  assert.ok(launcher.includes('--rpm=30'));
  assert.ok(launcher.includes('--concurrency=4'));
  assert.ok(launcher.includes('--max-total-tokens=50000000'));
  assert.ok(launcher.includes('--judge-mode=all'));
});
