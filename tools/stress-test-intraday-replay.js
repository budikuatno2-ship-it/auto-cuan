'use strict';

/**
 * Mock Replay & Stress Test for Intraday Screener Engine
 *
 * Simulates high-frequency burst traffic (500 - 1,000 candidates/ticks)
 * evaluating:
 *   1. Technical indicator & volume surge extraction
 *   2. Pattern Personality matching & edge score bonus
 *   3. Canonical Trade Plan V2 generation (Entry, SL, TP1, TP2)
 *   4. Telegram Signal Card v2 presentation rendering
 *
 * Measures:
 *   - Heap & RSS memory delta (zero-leak threshold < 30MB)
 *   - Throughput (ops/second)
 *   - Latency (average ms/eval, min, max, p95; target < 5ms)
 *   - Error rate (0% error requirement)
 */

const { performance } = require('node:perf_hooks');
const daytradeEngine = require('../lib/daytrade-screener-engine');
const patternPersonality = require('../lib/pattern-personality');
const tradePlanV2Integration = require('../lib/trade-plan-v2-integration');
const telegramTemplates = require('../lib/telegram-templates');
const idxTick = require('../lib/idx-tick-normalization');

const DEFAULT_THRESHOLDS = Object.freeze({
  MAX_AVG_LATENCY_MS: 5.0,
  MAX_HEAP_DELTA_MB: 30.0,
  MAX_ERROR_RATE_PCT: 0.0,
  MIN_THROUGHPUT_OPS: 500
});

const PATTERN_KEYS = [
  'COMBO_FX_TECH_MA5',
  'TRAP_CHG5_VOL3_CLIMAX',
  'FX_STRONG_BUY',
  'COMBO_BROKER_FX',
  'COMBO_BROKER_TECH',
  'RSI_OVERBOUGHT_65P',
  'VOL_WARM_1P2_1P5',
  'BROKER_TOP3_CONCENTRATION',
  'TECH_ABOVE_MA20',
  'TECH_ABOVE_MA5'
];

/**
 * Generate a synthetic batch of candidates across three market conditions:
 *   A. Breakout + Volume Spike + Broker Accumulation (Valid Day Trade Setup)
 *   B. Sideways / False Breakout (Neutral / Watchlist)
 *   C. Downtrend / Bagholder Distribution (Invalid / Filtered out)
 *
 * @param {number} count Total number of payloads to generate (default 1000)
 * @returns {Array<object>} Array of synthetic candidate objects
 */
function generateSyntheticBatch(count = 1000) {
  const candidates = [];
  const validCount = Math.floor(count * 0.45); // ~45% valid breakout setups
  const sidewaysCount = Math.floor(count * 0.30); // ~30% sideways/neutral
  const downtrendCount = count - validCount - sidewaysCount; // ~25% downtrend/bagholder

  // A. Breakout + Volume Spike + Broker Accumulation
  for (let i = 0; i < validCount; i++) {
    const patternIndex = i % PATTERN_KEYS.length;
    const targetPattern = PATTERN_KEYS[patternIndex];
    
    // Choose realistic liquid price bands (1,000 to 4,500)
    const rawPrice = 1000 + ((i * 47) % 3500);
    const tick = idxTick.getIdxTickSize(rawPrice) || (rawPrice < 2000 ? 5 : 10);
    const lastPrice = Math.round(rawPrice / tick) * tick;
    
    // Structural levels compliant with Trade Plan V2 risk budget (< 4% stop distance, RR >= 1.0)
    const entryHigh = lastPrice;
    const entryLow = lastPrice - tick;
    const support = lastPrice - (tick * 3);
    const resistance = lastPrice + (tick * 7);
    const atr = Math.max(tick * 2, Math.round(lastPrice * 0.012));
    const stopLoss = support - (tick * 2);
    const tp1 = resistance - tick;
    const tp2 = lastPrice + (tick * 10);

    const candidate = {
      scenario: 'BREAKOUT_ACCUMULATION',
      ticker: `BO_${String(i + 1).padStart(4, '0')}`,
      last_price: lastPrice,
      open_price: lastPrice - (tick * 2),
      high_price: lastPrice,
      low_price: lastPrice - (tick * 2),
      change_pct: 3.5 + ((i % 15) / 10), // +3.5% to +5.0%
      volume_ratio_20d: 2.2 + ((i % 20) / 10), // 2.2x to 4.2x
      tx_value_1d: 20_000_000_000 + ((i % 30) * 500_000_000),
      avg_value_7d: 8_000_000_000,
      bandar_net_flow: 2_500_000_000 + ((i % 20) * 150_000_000),
      bandar_flow_label: 'Akumulasi Besar',
      cr3: 65,
      foreign_net: 1_200_000_000,
      foreign_grade: 'A',
      foreign_label: 'Foreign Strong Buy',
      above_ma5: true,
      above_ma20: true,
      ma5: lastPrice - tick,
      ma20: lastPrice - (tick * 3),
      rsi14: 64,
      entry_low: entryLow,
      entry_high: entryHigh,
      support: support,
      resistance: resistance,
      stop_loss: stopLoss,
      tp1: tp1,
      tp2: tp2,
      risk_reward: 1.5,
      atr14: atr,
      status: i % 2 === 0 ? 'A_PLUS_SETUP' : 'READY_BREAKOUT',
      candle_pattern: 'Bullish Engulfing',
      data_freshness: { is_stale: false, as_of: new Date().toISOString() },
      data_quality_valid: true,
      data_quality_needs_revalidation: false
    };

    // Fine-tune characteristics to trigger specific patterns
    switch (targetPattern) {
      case 'COMBO_FX_TECH_MA5':
        candidate.foreign_net = 1_500_000_000;
        candidate.above_ma5 = true;
        candidate.ma5 = lastPrice - tick;
        break;
      case 'TRAP_CHG5_VOL3_CLIMAX':
        candidate.change_pct = 5.6;
        candidate.volume_ratio_20d = 3.5;
        candidate.foreign_net = -50_000_000;
        candidate.foreign_grade = 'C';
        candidate.foreign_label = 'Neutral';
        candidate.above_ma5 = false;
        candidate.ma5 = lastPrice + tick;
        break;
      case 'FX_STRONG_BUY':
        candidate.foreign_grade = 'A';
        candidate.foreign_label = 'Strong Buy';
        candidate.foreign_net = 2_000_000_000;
        candidate.above_ma5 = false;
        candidate.ma5 = lastPrice + tick;
        break;
      case 'COMBO_BROKER_FX':
        candidate.bandar_flow_label = 'Akumulasi';
        candidate.bandar_net_flow = 1_500_000_000;
        candidate.foreign_net = 500_000_000;
        candidate.foreign_grade = 'B';
        candidate.above_ma5 = false;
        candidate.above_ma20 = false;
        candidate.ma5 = lastPrice + tick;
        candidate.ma20 = lastPrice + (tick * 2);
        break;
      case 'COMBO_BROKER_TECH':
        candidate.bandar_net_flow = 2_000_000_000;
        candidate.bandar_flow_label = 'Akumulasi';
        candidate.foreign_net = -200_000_000;
        candidate.foreign_grade = 'D';
        candidate.foreign_label = 'Sell';
        candidate.above_ma5 = true;
        candidate.ma5 = lastPrice - tick;
        break;
      case 'RSI_OVERBOUGHT_65P':
        candidate.rsi14 = 70;
        candidate.bandar_net_flow = 0;
        candidate.bandar_flow_label = 'Netral';
        candidate.foreign_net = 0;
        candidate.foreign_grade = 'C';
        candidate.foreign_label = 'Neutral';
        candidate.above_ma5 = false;
        candidate.ma5 = lastPrice + tick;
        candidate.cr3 = 30;
        break;
      case 'VOL_WARM_1P2_1P5':
        candidate.volume_ratio_20d = 1.35;
        candidate.bandar_net_flow = 0;
        candidate.bandar_flow_label = 'Netral';
        candidate.foreign_net = 0;
        candidate.foreign_grade = 'C';
        candidate.foreign_label = 'Neutral';
        candidate.above_ma5 = false;
        candidate.ma5 = lastPrice + tick;
        candidate.rsi14 = 55;
        candidate.cr3 = 30;
        break;
      case 'BROKER_TOP3_CONCENTRATION':
        candidate.cr3 = 58;
        candidate.bandar_net_flow = 0;
        candidate.bandar_flow_label = 'Netral';
        candidate.foreign_net = 0;
        candidate.foreign_grade = 'C';
        candidate.foreign_label = 'Neutral';
        candidate.above_ma5 = false;
        candidate.ma5 = lastPrice + tick;
        candidate.rsi14 = 55;
        candidate.volume_ratio_20d = 1.1;
        break;
      case 'TECH_ABOVE_MA20':
        candidate.above_ma20 = true;
        candidate.above_ma5 = false;
        candidate.ma20 = lastPrice - (tick * 2);
        candidate.ma5 = lastPrice + tick;
        candidate.bandar_net_flow = 0;
        candidate.bandar_flow_label = 'Netral';
        candidate.foreign_net = 0;
        candidate.foreign_grade = 'C';
        candidate.foreign_label = 'Neutral';
        candidate.rsi14 = 55;
        candidate.volume_ratio_20d = 1.1;
        candidate.cr3 = 30;
        break;
      case 'TECH_ABOVE_MA5':
        candidate.above_ma5 = true;
        candidate.above_ma20 = false;
        candidate.ma5 = lastPrice - tick;
        candidate.ma20 = lastPrice + (tick * 2);
        candidate.bandar_net_flow = 0;
        candidate.bandar_flow_label = 'Netral';
        candidate.foreign_net = 0;
        candidate.foreign_grade = 'C';
        candidate.foreign_label = 'Neutral';
        candidate.rsi14 = 55;
        candidate.volume_ratio_20d = 1.1;
        candidate.cr3 = 30;
        break;
      default:
        break;
    }

    candidates.push(candidate);
  }

  // B. Sideways / False Breakout (Neutral)
  for (let j = 0; j < sidewaysCount; j++) {
    const rawPrice = 600 + ((j * 23) % 2500);
    const tick = idxTick.getIdxTickSize(rawPrice) || (rawPrice < 2000 ? 5 : 10);
    const lastPrice = Math.round(rawPrice / tick) * tick;

    candidates.push({
      scenario: 'SIDEWAYS_NEUTRAL',
      ticker: `SW_${String(j + 1).padStart(4, '0')}`,
      last_price: lastPrice,
      open_price: lastPrice,
      high_price: lastPrice + tick,
      low_price: lastPrice - tick,
      change_pct: -0.5 + ((j % 15) / 10), // -0.5% to +1.0%
      volume_ratio_20d: 0.8 + ((j % 4) / 10), // 0.8x to 1.1x
      tx_value_1d: 2_500_000_000 + ((j % 10) * 200_000_000),
      avg_value_7d: 2_200_000_000,
      bandar_net_flow: 50_000_000 - ((j % 5) * 20_000_000),
      bandar_flow_label: 'Netral',
      cr3: 35,
      foreign_net: 10_000_000,
      foreign_grade: 'C',
      foreign_label: 'Neutral',
      above_ma5: false,
      above_ma20: false,
      ma5: lastPrice + tick,
      ma20: lastPrice + (tick * 2),
      rsi14: 48,
      entry_low: lastPrice - tick,
      entry_high: lastPrice,
      support: lastPrice - (tick * 3),
      resistance: lastPrice + (tick * 4),
      stop_loss: lastPrice - (tick * 4),
      tp1: lastPrice + (tick * 3),
      tp2: lastPrice + (tick * 5),
      risk_reward: 1.0,
      atr14: Math.max(tick * 2, Math.round(lastPrice * 0.015)),
      status: j % 2 === 0 ? 'WAIT_PULLBACK' : 'EARLY_RADAR',
      candle_pattern: 'Doji',
      data_freshness: { is_stale: false, as_of: new Date().toISOString() },
      data_quality_valid: true,
      data_quality_needs_revalidation: false
    });
  }

  // C. Downtrend / Bagholder Distribution (Invalid / Filtered out)
  for (let k = 0; k < downtrendCount; k++) {
    const rawPrice = 300 + ((k * 19) % 2000);
    const tick = idxTick.getIdxTickSize(rawPrice) || (rawPrice < 500 ? 2 : 5);
    const lastPrice = Math.round(rawPrice / tick) * tick;

    candidates.push({
      scenario: 'DOWNTREND_DISTRIBUTION',
      ticker: `DT_${String(k + 1).padStart(4, '0')}`,
      last_price: lastPrice,
      open_price: lastPrice + (tick * 3),
      high_price: lastPrice + (tick * 3),
      low_price: lastPrice,
      change_pct: -3.5 - ((k % 25) / 10), // -3.5% to -6.0%
      volume_ratio_20d: 0.4 + ((k % 15) / 10), // 0.4x to 1.8x
      tx_value_1d: 1_200_000_000,
      avg_value_7d: 3_000_000_000,
      bandar_net_flow: -3_000_000_000 - ((k % 20) * 250_000_000),
      bandar_flow_label: 'Distribusi Besar',
      cr3: 15,
      foreign_net: -1_500_000_000,
      foreign_grade: 'E',
      foreign_label: 'Strong Sell',
      above_ma5: false,
      above_ma20: false,
      ma5: lastPrice + (tick * 3),
      ma20: lastPrice + (tick * 6),
      rsi14: 28,
      entry_low: lastPrice - tick,
      entry_high: lastPrice,
      support: lastPrice - (tick * 3),
      resistance: lastPrice + (tick * 2),
      stop_loss: lastPrice - (tick * 4),
      tp1: lastPrice + (tick * 2),
      tp2: lastPrice + (tick * 4),
      risk_reward: 0.6,
      atr14: Math.max(tick * 2, Math.round(lastPrice * 0.025)),
      status: 'AVOID',
      candle_pattern: 'Distribution candle',
      data_freshness: { is_stale: false, as_of: new Date().toISOString() },
      data_quality_valid: true,
      data_quality_needs_revalidation: false
    });
  }

  return candidates;
}

/**
 * Evaluates a single candidate payload through the full intraday screener pipeline:
 * 1. Volume & technical indicators extraction
 * 2. 10 Pattern Personality matching and edge scoring
 * 3. Canonical Trade Plan V2 generation
 * 4. Signal card message preview formatting
 *
 * @param {object} candidate
 * @param {number} index
 * @returns {object} Evaluation output
 */
function evaluateCandidate(candidate, index = 1) {
  // 1. Technical indicators & base scoring
  const baseScore = daytradeEngine.calculateDayTradeScore(candidate);
  const volumeSurgeScore = daytradeEngine.scoreVolumeSurge(candidate);
  const orderFlowScore = daytradeEngine.scoreOrderFlowVelocity(candidate);

  // 2. Pattern Personality matching & bonus calculation
  const patternKey = patternPersonality.matchTickerPattern(candidate);
  const patternBonus = patternPersonality.calculatePatternScoreBonus(patternKey);
  const patternEdgeLine = patternPersonality.formatPatternPersonalityLine(patternKey);
  const finalScore = Math.min(100, baseScore + patternBonus);

  // Attach enriched pattern data to candidate
  const enriched = Object.assign({}, candidate, {
    daytrade_score: finalScore,
    pattern_personality: patternKey,
    pattern_edge_line: patternEdgeLine,
    volume_surge_score: volumeSurgeScore,
    orderflow_score: orderFlowScore
  });

  // 3. Trade Plan V2 generation
  const tradePlan = tradePlanV2Integration.buildCandidatePlanV2(enriched, {
    screener_type: 'DAY_TRADE'
  });

  // 4. Dry-run Telegram signal formatting / preview
  const signalCard = telegramTemplates.formatSignalCard(enriched, index, 'daytrade');

  return {
    ticker: candidate.ticker,
    scenario: candidate.scenario,
    baseScore,
    patternBonus,
    finalScore,
    patternKey,
    patternEdgeLine,
    tradePlanStatus: tradePlan ? tradePlan.status : 'NO_PLAN',
    hasValidTradePlan: Boolean(
      tradePlan &&
      (tradePlan.status === 'OK' || tradePlan.status === 'WARNING' || tradePlan.status === 'REDUCE_POSITION_SIZE') &&
      tradePlan.entry_trigger > 0 &&
      tradePlan.stop_loss > 0 &&
      tradePlan.tp1 > 0
    ),
    tradePlan,
    signalCardGenerated: typeof signalCard === 'string' && signalCard.length > 50,
    signalCardLength: signalCard ? signalCard.length : 0
  };
}

/**
 * Execute replay stress test across a batch of candidates.
 *
 * @param {Array<object>|number} input Batch array or count of synthetic candidates
 * @param {object} options Configuration options
 * @returns {object} Benchmark and stress test metrics
 */
function runReplayStressTest(input = 1000, options = {}) {
  const candidates = Array.isArray(input) ? input : generateSyntheticBatch(input);
  const count = candidates.length;

  // Garbage collect if available before measuring initial memory
  if (typeof global.gc === 'function') {
    global.gc();
  }

  const initialMem = process.memoryUsage();
  const startTime = performance.now();

  const latencies = new Float64Array(count);
  const patternDistribution = {};
  const scenarioCounts = {
    BREAKOUT_ACCUMULATION: 0,
    SIDEWAYS_NEUTRAL: 0,
    DOWNTREND_DISTRIBUTION: 0
  };
  let errorCount = 0;
  let validTradePlansCount = 0;
  let signalCardsCount = 0;
  const errors = [];

  for (let i = 0; i < count; i++) {
    const candidate = candidates[i];
    if (candidate.scenario && scenarioCounts[candidate.scenario] !== undefined) {
      scenarioCounts[candidate.scenario]++;
    }

    const itemStart = performance.now();
    try {
      const result = evaluateCandidate(candidate, i + 1);
      const itemDuration = performance.now() - itemStart;
      latencies[i] = itemDuration;

      if (result.patternKey) {
        patternDistribution[result.patternKey] = (patternDistribution[result.patternKey] || 0) + 1;
      }
      if (result.hasValidTradePlan) {
        validTradePlansCount++;
      }
      if (result.signalCardGenerated) {
        signalCardsCount++;
      }
    } catch (err) {
      errorCount++;
      errors.push({ ticker: candidate.ticker, error: err.message });
      latencies[i] = performance.now() - itemStart;
    }
  }

  const endTime = performance.now();
  const totalDurationMs = endTime - startTime;

  if (typeof global.gc === 'function') {
    global.gc();
  }

  const finalMem = process.memoryUsage();

  // Metrics computation
  const sortedLatencies = Array.from(latencies).sort((a, b) => a - b);
  const minLatencyMs = sortedLatencies[0] || 0;
  const maxLatencyMs = sortedLatencies[sortedLatencies.length - 1] || 0;
  const avgLatencyMs = totalDurationMs / count;
  const p50Index = Math.floor(count * 0.50);
  const p95Index = Math.floor(count * 0.95);
  const p99Index = Math.floor(count * 0.99);
  const p50LatencyMs = sortedLatencies[p50Index] || 0;
  const p95LatencyMs = sortedLatencies[p95Index] || 0;
  const p99LatencyMs = sortedLatencies[p99Index] || 0;

  const opsPerSec = Math.round(count / (totalDurationMs / 1000));
  const errorRatePct = (errorCount / count) * 100;

  const heapUsedDeltaMb = (finalMem.heapUsed - initialMem.heapUsed) / (1024 * 1024);
  const rssDeltaMb = (finalMem.rss - initialMem.rss) / (1024 * 1024);

  const thresholds = Object.assign({}, DEFAULT_THRESHOLDS, options.thresholds || {});
  const checks = {
    latencyPassed: avgLatencyMs <= thresholds.MAX_AVG_LATENCY_MS,
    memoryPassed: heapUsedDeltaMb <= thresholds.MAX_HEAP_DELTA_MB,
    errorRatePassed: errorRatePct <= thresholds.MAX_ERROR_RATE_PCT,
    throughputPassed: opsPerSec >= thresholds.MIN_THROUGHPUT_OPS
  };
  const allPassed = checks.latencyPassed && checks.memoryPassed && checks.errorRatePassed && checks.throughputPassed;

  return {
    totalPayloads: count,
    durationMs: Number(totalDurationMs.toFixed(2)),
    throughputOpsSec: opsPerSec,
    latency: {
      avgMs: Number(avgLatencyMs.toFixed(4)),
      minMs: Number(minLatencyMs.toFixed(4)),
      maxMs: Number(maxLatencyMs.toFixed(4)),
      p50Ms: Number(p50LatencyMs.toFixed(4)),
      p95Ms: Number(p95LatencyMs.toFixed(4)),
      p99Ms: Number(p99LatencyMs.toFixed(4))
    },
    memory: {
      initialHeapMb: Number((initialMem.heapUsed / (1024 * 1024)).toFixed(2)),
      finalHeapMb: Number((finalMem.heapUsed / (1024 * 1024)).toFixed(2)),
      heapDeltaMb: Number(heapUsedDeltaMb.toFixed(2)),
      initialRssMb: Number((initialMem.rss / (1024 * 1024)).toFixed(2)),
      finalRssMb: Number((finalMem.rss / (1024 * 1024)).toFixed(2)),
      rssDeltaMb: Number(rssDeltaMb.toFixed(2))
    },
    resultsBreakdown: {
      scenarios: scenarioCounts,
      validTradePlansCount,
      signalCardsCount,
      patternsMatchedCount: Object.values(patternDistribution).reduce((a, b) => a + b, 0),
      patternDistribution
    },
    errorRatePct,
    errorCount,
    errors,
    thresholds,
    checks,
    passed: allPassed
  };
}

/**
 * Print formatted summary report to console
 */
function printReport(metrics) {
  console.log('\n================================================================');
  console.log('⚡ INTRADAY SCREENER ENGINE — MOCK REPLAY & STRESS TEST REPORT');
  console.log('================================================================');
  console.log(`Total Payloads Processed : ${metrics.totalPayloads.toLocaleString('id-ID')} candidates`);
  console.log(`Total Wall-Clock Time   : ${metrics.durationMs} ms`);
  console.log(`Throughput              : ${metrics.throughputOpsSec.toLocaleString('id-ID')} ops/sec (Target: >= ${metrics.thresholds.MIN_THROUGHPUT_OPS})`);
  console.log(`Average Latency         : ${metrics.latency.avgMs} ms/eval (Target: < ${metrics.thresholds.MAX_AVG_LATENCY_MS} ms)`);
  console.log(`Latency Percentiles     : p50: ${metrics.latency.p50Ms}ms | p95: ${metrics.latency.p95Ms}ms | p99: ${metrics.latency.p99Ms}ms | max: ${metrics.latency.maxMs}ms`);
  console.log(`Error Rate              : ${metrics.errorRatePct.toFixed(2)}% (${metrics.errorCount} errors)`);
  console.log('----------------------------------------------------------------');
  console.log('MEMORY USAGE & ZERO-LEAK AUDIT:');
  console.log(`  Initial Heap : ${metrics.memory.initialHeapMb} MB`);
  console.log(`  Final Heap   : ${metrics.memory.finalHeapMb} MB`);
  console.log(`  Heap Delta   : ${metrics.memory.heapDeltaMb > 0 ? '+' : ''}${metrics.memory.heapDeltaMb} MB (Threshold: < ${metrics.thresholds.MAX_HEAP_DELTA_MB} MB)`);
  console.log(`  RSS Delta    : ${metrics.memory.rssDeltaMb > 0 ? '+' : ''}${metrics.memory.rssDeltaMb} MB`);
  console.log('----------------------------------------------------------------');
  console.log('SCENARIO & PATTERN BREAKDOWN:');
  console.log(`  Valid Breakout Setups   : ${metrics.resultsBreakdown.scenarios.BREAKOUT_ACCUMULATION}`);
  console.log(`  Sideways / Neutral      : ${metrics.resultsBreakdown.scenarios.SIDEWAYS_NEUTRAL}`);
  console.log(`  Downtrend / Dist        : ${metrics.resultsBreakdown.scenarios.DOWNTREND_DISTRIBUTION}`);
  console.log(`  Valid Trade Plans (V2)  : ${metrics.resultsBreakdown.validTradePlansCount}`);
  console.log(`  Signal Cards Rendered   : ${metrics.resultsBreakdown.signalCardsCount}`);
  console.log(`  Patterns Matched Total  : ${metrics.resultsBreakdown.patternsMatchedCount}`);
  console.log('  Pattern Distribution:');
  for (const [key, count] of Object.entries(metrics.resultsBreakdown.patternDistribution)) {
    console.log(`    - ${key.padEnd(28, ' ')} : ${count} setups`);
  }
  console.log('----------------------------------------------------------------');
  console.log('GATE CHECK VERDICT:');
  console.log(`  [${metrics.checks.latencyPassed ? 'PASS' : 'FAIL'}] Latency Check (< 5.0ms)     : ${metrics.latency.avgMs} ms`);
  console.log(`  [${metrics.checks.memoryPassed ? 'PASS' : 'FAIL'}] Memory Leak Check (< 30MB) : ${metrics.memory.heapDeltaMb} MB`);
  console.log(`  [${metrics.checks.errorRatePassed ? 'PASS' : 'FAIL'}] Error Rate Check (0%)       : ${metrics.errorRatePct}%`);
  console.log(`  [${metrics.checks.throughputPassed ? 'PASS' : 'FAIL'}] Throughput Check (>= 500)   : ${metrics.throughputOpsSec} ops/sec`);
  console.log('================================================================');
  console.log(metrics.passed ? ' OVERALL VERDICT: ALL STRESS & LEAK TESTS PASSED! ' : ' OVERALL VERDICT: STRESS TEST FAILED! ');
  console.log('================================================================\n');
}

// CLI Execution
if (require.main === module) {
  const countArg = process.argv.find(arg => arg.startsWith('--count='));
  const count = countArg ? parseInt(countArg.split('=')[1], 10) : 1000;
  const metrics = runReplayStressTest(count);
  printReport(metrics);
  if (!metrics.passed) {
    process.exit(1);
  }
}

module.exports = {
  DEFAULT_THRESHOLDS,
  PATTERN_KEYS,
  generateSyntheticBatch,
  evaluateCandidate,
  runReplayStressTest,
  printReport
};
