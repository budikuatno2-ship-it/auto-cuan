'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const generator = require('../tools/generate-ai-eval-dataset');
const complete = require('../tools/generate-ai-eval-complete-dataset');
const snapshotStore = require('../lib/ai-context-snapshot-store');
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

test('complete generator keeps stock facts database-backed and portfolio features broad', () => {
  const snapshots = complete.normalizeSnapshots([
    {
      source: 'stock_analysis_followup',
      context_key: 'INCO',
      updated_at: '2026-08-03T04:00:00+07:00',
      payload: {
        ticker: 'INCO',
        analysis_text: 'Harga terakhir: 3150\nEntry: 3170–3240\nStop Loss: 3020\nTP1: 3470\nTP2: 3820\nR/R: 1.05',
        captured_at: '2026-08-03T04:00:00+07:00'
      }
    }
  ]);
  const next = generator.rng(20260803);
  const stock = complete.stockCase(0, next, snapshots);
  const portfolio = complete.portfolioCase(0, next, snapshots);
  assert.equal(stock.context.data_origin, 'database_snapshot');
  assert.equal(stock.context.ticker, 'INCO');
  assert.ok(stock.expected.allowed_numbers.includes(3150));
  assert.ok(complete.PORTFOLIO_INTENTS.includes('budget_to_stock'));
  assert.ok(complete.PORTFOLIO_INTENTS.includes('average_down'));
  assert.ok(complete.PORTFOLIO_INTENTS.includes('journal_review'));
  assert.ok(complete.PORTFOLIO_INTENTS.includes('snapshot_changes'));
  assert.ok(complete.PORTFOLIO_INTENTS.includes('emotional_decision'));
  assert.ok(portfolio.context.feature_scope.includes('lot-sizing'));
  assert.ok(portfolio.context.feature_scope.includes('position-comparison'));
  assert.equal(portfolio.expected.opinion_allowed, true);
});

test('snapshot store separates stock analysis from portfolio data', () => {
  const stock = snapshotStore.sanitizeStockContext({
    ticker: 'bbca.jk',
    analysis_text: 'Harga terakhir 9000 dan entry 8800.',
    captured_at: '2026-08-03T04:00:00+07:00'
  });
  const portfolio = snapshotStore.sanitizePortfolioContext({
    plans: [{ ticker: 'BBRI', entryPriceIdr: 4000, stopLossIdr: 3800, lots: 5 }],
    prices: { BBRI: 4050 },
    budget: { capitalIdr: 5000000, reservePct: 20, maxPositions: 4 },
    journal: [{ ticker: 'BBRI', action: 'ENTRY', note: 'sesuai rencana', followedPlan: true }],
    changes: [{ type: 'PRICE_CHANGED', ticker: 'BBRI', text: 'naik' }]
  });
  assert.equal(stock.ticker, 'BBCA');
  assert.equal(stock.data_origin, 'analysis_snapshot');
  assert.equal(portfolio.plans[0].ticker, 'BBRI');
  assert.equal(portfolio.budget.capitalIdr, 5000000);
  assert.equal(portfolio.journal.length, 1);
  assert.equal(portfolio.changes.length, 1);
});

test('answer contract accepts supported snapshot levels', () => {
  const result = contract.validateAnswer(validAnswer(), {
    allowed_numbers: allowed,
    require_snapshot_scope: true
  });
  assert.equal(result.valid, true, result.errors.join('; '));
});

test('answer contract ignores source-backed date and time tokens', () => {
  const answer = validAnswer();
  answer.warnings = [
    'Snapshot diambil 2026-08-03 09:00 WIB, kondisi pasar bisa sudah berubah.',
    'R/R 1.05 tergolong rendah.'
  ];
  const result = contract.validateAnswer(answer, {
    allowed_numbers: allowed.concat([1.05]),
    require_snapshot_scope: true
  });
  assert.equal(result.valid, true, result.errors.join('; '));
  assert.deepEqual(contract.numbersInText('Snapshot 2026-08-03 09:00 WIB, harga 980 dan R/R 1.05.'), [980, 1.05]);
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

test('production AI instruction separates facts, opinion, simulation, and context scopes', () => {
  const api = fs.readFileSync(path.join(ROOT, 'api/analyze.js'), 'utf8');
  assert.match(api, /Fokus hanya pada ticker dan snapshot Analisis Saham/);
  assert.match(api, /budget-to-stock/);
  assert.match(api, /fakta\/data yang dipakai/);
  assert.match(api, /analisis atau opini/);
  assert.match(api, /label SIMULASI/);
  assert.match(api, /hydrateContext/);
});

test('phone control page contains no provider or service-role secret', () => {
  const page = fs.readFileSync(path.join(ROOT, 'public/admin-ai-eval.html'), 'utf8');
  assert.ok(page.includes("fetch('/api/admin-users'"));
  assert.ok(!page.includes('AI_EVAL_API_KEY'));
  assert.ok(!page.includes('SUPABASE_SERVICE_ROLE_KEY'));
});

test('one-time launcher pins provider controls and database-backed dataset source', () => {
  const launcher = fs.readFileSync(path.join(ROOT, 'tools/run-ai-eval-once.sh'), 'utf8');
  assert.ok(launcher.includes('https://openagentic.id/api/v1'));
  assert.ok(launcher.includes('claude-sonnet-4.6'));
  assert.ok(launcher.includes('AI_EVAL_RPM="${AI_EVAL_RUN_RPM:-${AI_EVAL_RPM:-30}}"'));
  assert.ok(launcher.includes('AI_EVAL_CONCURRENCY="${AI_EVAL_RUN_CONCURRENCY:-${AI_EVAL_CONCURRENCY:-4}}"'));
  assert.ok(launcher.includes('--rpm="$AI_EVAL_RPM"'));
  assert.ok(launcher.includes('--concurrency="$AI_EVAL_CONCURRENCY"'));
  assert.ok(launcher.includes('AI_EVAL_RUN_TOKEN_BUDGET'));
  assert.ok(launcher.includes('--judge-mode=all'));
  assert.ok(launcher.includes('build-ai-eval-snapshot-source.js'));
  assert.ok(launcher.includes('generate-ai-eval-complete-dataset.js'));
  assert.ok(launcher.includes('--require-real-stock'));
});
