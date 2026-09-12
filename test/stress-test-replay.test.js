'use strict';

/**
 * Intraday Screener Engine — Mock Replay & Stress Test Suite
 *
 * Verifies engine performance under burst traffic:
 *   1. Execution finishes under 1,000ms for 100+ candidates with average latency < 5ms
 *   2. Trade Plan V2 is generated with valid entry, SL, and TP levels
 *   3. Signal card previews format properly with Pattern Edge annotations
 *   4. Downtrend/distribution setups are safely filtered (AVOID / Hindari)
 *   5. Memory heap growth remains strictly below 30MB leak threshold
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  runReplayStressTest,
  generateSyntheticBatch,
  evaluateCandidate,
  DEFAULT_THRESHOLDS,
  PATTERN_KEYS
} = require('../tools/stress-test-intraday-replay');
const telegramTemplates = require('../lib/telegram-templates');

test('intraday replay processes 100 candidates in < 1,000ms with latency < 5ms and 0 errors', () => {
  const metrics = runReplayStressTest(100);

  assert.equal(metrics.totalPayloads, 100, 'must process exactly 100 payloads');
  assert.ok(metrics.durationMs < 1000, `duration ${metrics.durationMs}ms must be under 1,000ms`);
  assert.ok(
    metrics.latency.avgMs < DEFAULT_THRESHOLDS.MAX_AVG_LATENCY_MS,
    `average latency ${metrics.latency.avgMs}ms must be under ${DEFAULT_THRESHOLDS.MAX_AVG_LATENCY_MS}ms`
  );
  assert.equal(metrics.errorCount, 0, 'error count must be 0');
  assert.equal(metrics.errorRatePct, 0, 'error rate must be 0%');
  assert.ok(metrics.throughputOpsSec >= 500, `throughput ${metrics.throughputOpsSec} ops/sec must be >= 500`);
  assert.ok(metrics.passed, 'all stress thresholds must pass');
});

test('breakout candidates generate valid Canonical Trade Plan V2 with entry, SL, and TP', () => {
  const batch = generateSyntheticBatch(50);
  const breakoutCandidates = batch.filter(c => c.scenario === 'BREAKOUT_ACCUMULATION');

  assert.ok(breakoutCandidates.length >= 20, 'must have at least 20 breakout candidates');

  for (let i = 0; i < breakoutCandidates.length; i++) {
    const candidate = breakoutCandidates[i];
    const evaluated = evaluateCandidate(candidate, i + 1);

    assert.ok(
      evaluated.hasValidTradePlan,
      `candidate ${candidate.ticker} must produce a valid trade plan (status: ${evaluated.tradePlanStatus})`
    );

    const plan = evaluated.tradePlan;
    assert.ok(plan.entry_trigger > 0, `${candidate.ticker} entry_trigger must be > 0`);
    assert.ok(plan.stop_loss > 0, `${candidate.ticker} stop_loss must be > 0`);
    assert.ok(plan.tp1 > 0, `${candidate.ticker} tp1 must be > 0`);

    // Price ordering sanity: Stop Loss < Entry Trigger < TP1
    assert.ok(
      plan.stop_loss < plan.entry_trigger,
      `${candidate.ticker} stop_loss (${plan.stop_loss}) must be below entry_trigger (${plan.entry_trigger})`
    );
    assert.ok(
      plan.tp1 > plan.entry_trigger,
      `${candidate.ticker} tp1 (${plan.tp1}) must be above entry_trigger (${plan.entry_trigger})`
    );
    assert.ok(plan.rr_to_tp1 >= 1.0, `${candidate.ticker} RR to TP1 (${plan.rr_to_tp1}) must be >= 1.0`);
  }
});

test('signal card previews render without exception and include Pattern Edge lines', () => {
  const batch = generateSyntheticBatch(20);
  const breakoutCandidates = batch.filter(c => c.scenario === 'BREAKOUT_ACCUMULATION');

  for (let i = 0; i < breakoutCandidates.length; i++) {
    const candidate = breakoutCandidates[i];
    const evaluated = evaluateCandidate(candidate, i + 1);

    assert.ok(evaluated.signalCardGenerated, `signal card must be generated for ${candidate.ticker}`);
    assert.ok(evaluated.signalCardLength > 100, `signal card length must be substantive for ${candidate.ticker}`);

    const card = telegramTemplates.formatSignalCard(
      Object.assign({}, candidate, {
        pattern_personality: evaluated.patternKey,
        pattern_edge_line: evaluated.patternEdgeLine
      }),
      i + 1,
      'daytrade'
    );

    assert.ok(card.includes(candidate.ticker), `card must include ticker ${candidate.ticker}`);
    assert.ok(card.includes('🎯 Trading Plan'), `card must include Trading Plan header`);
    assert.ok(card.includes('Area Beli:'), `card must include Area Beli`);
    assert.ok(card.includes('Take Profit:'), `card must include Take Profit`);
    assert.ok(card.includes('Stop Loss:'), `card must include Stop Loss`);
    assert.ok(card.includes('Risk/Reward:'), `card must include Risk/Reward`);
    assert.ok(card.includes('👁 Pattern / Setup'), `card must include Pattern section`);

    if (evaluated.patternEdgeLine) {
      assert.ok(card.includes('Edge:'), `card must include Edge row when pattern matches`);
      assert.ok(card.includes(evaluated.patternKey), `card must include matched pattern key`);
    }
  }
});

test('downtrend/distribution setups are safely filtered and marked AVOID without false buy signals', () => {
  const batch = generateSyntheticBatch(50);
  const downtrendCandidates = batch.filter(c => c.scenario === 'DOWNTREND_DISTRIBUTION');

  assert.ok(downtrendCandidates.length >= 10, 'must have downtrend candidates');

  for (let i = 0; i < downtrendCandidates.length; i++) {
    const candidate = downtrendCandidates[i];
    const evaluated = evaluateCandidate(candidate, i + 1);

    // Candidates in downtrend scenario should not have high scores
    assert.ok(
      evaluated.finalScore < 60,
      `downtrend candidate ${candidate.ticker} score (${evaluated.finalScore}) must remain below 60`
    );
    assert.equal(candidate.status, 'AVOID', `downtrend candidate status must be AVOID`);

    const card = telegramTemplates.formatSignalCard(candidate, i + 1, 'daytrade');
    assert.ok(
      card.includes('Hindari'),
      `downtrend signal card for ${candidate.ticker} must convey Hindari / Avoid`
    );
  }
});

test('high-volume burst (500 candidates) maintains zero memory leak (< 30MB delta)', () => {
  const metrics = runReplayStressTest(500);

  assert.equal(metrics.totalPayloads, 500, 'must process 500 payloads');
  assert.ok(
    metrics.memory.heapDeltaMb < DEFAULT_THRESHOLDS.MAX_HEAP_DELTA_MB,
    `heap delta ${metrics.memory.heapDeltaMb}MB must be < ${DEFAULT_THRESHOLDS.MAX_HEAP_DELTA_MB}MB`
  );
  assert.ok(metrics.checks.memoryPassed, 'memory check must pass');
  assert.ok(
    metrics.latency.avgMs < DEFAULT_THRESHOLDS.MAX_AVG_LATENCY_MS,
    `latency ${metrics.latency.avgMs}ms must be < ${DEFAULT_THRESHOLDS.MAX_AVG_LATENCY_MS}ms`
  );
  assert.equal(metrics.errorCount, 0, 'error count must be 0');
  assert.ok(metrics.passed, 'overall stress test must pass');
});
