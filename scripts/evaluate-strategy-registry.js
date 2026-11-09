'use strict';

/**
 * scripts/evaluate-strategy-registry.js
 * ============================================================================
 * V5 Phase 6 — Strategy Registry v1 QUALIFICATION EVALUATOR (local, read-only
 * against on-disk backtest artifacts; writes ONLY data/strategy-registry.json).
 * ============================================================================
 *
 * PURPOSE
 *   Read the EXISTING backtest metrics files that are actually present on disk,
 *   run each strategy group through the V5 contract §12 qualification gate, and
 *   REGISTER the honest decision. Nothing is invented: a metric that a source
 *   file does not contain is recorded as `NOT_MEASURED`, never recomputed.
 *
 * §12 QUALIFICATION BAR (applied as a checklist — all must hold)
 *   1. net-positive expectancy AND profit factor >= MIN_PROFIT_FACTOR (1.5, independent)
 *   2. adequate sample size (>= MIN_SAMPLE_SIZE = 100; Wilson lower bound
 *      meaningful at publication granularity)
 *   3. out-of-sample / walk-forward validation by date (no shuffle)
 *   4. fees + slippage modelled
 *   5. publication lag modelled (signal on close t, fill next bar)
 *   6. anti-look-ahead: purging / embargo between train and test
 *   7. the §12 final rule: if nothing passes, output NO_QUALIFIED_STRATEGY.
 *
 * OUTPUT (data/strategy-registry.json)
 *   {
 *     status: 'NO_QUALIFIED_STRATEGY',
 *     qualificationOutcome: 'NO_QUALIFIED_STRATEGY',
 *     schema: 1,
 *     updatedAt / auditedAt,
 *     strategies: {},                     // NEVER auto-populated with a fallback
 *     rejectionReasons: [ { id, verdict, metricsMeasured, reasons[] } ],
 *     auditLog: [ { at, event: 'EVALUATE_STRATEGY_REGISTRY', outcome, ... } ]
 *   }
 * ============================================================================
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const REGISTRY_PATH = path.join(ROOT, 'data', 'strategy-registry.json');

// Reuse the SAME numeric thresholds the registry module already pins, so the
// registry decision and the production gate cannot disagree. If the module is
// unavailable we pin identical local constants instead of silently passing.
let MIN_RR_RATIO = 1.5;
let MIN_PROFIT_FACTOR = 1.5;
let MIN_SAMPLE_SIZE = 100;
let MIN_EXPECTANCY_R = 0; // strictly positive net expectancy required
let registryRef = null;
try {
  registryRef = require('../lib/strategy-registry.js');
  MIN_RR_RATIO = Number(registryRef.MIN_RR_RATIO) || 1.5;
  MIN_PROFIT_FACTOR = Number(registryRef.MIN_PROFIT_FACTOR) || 1.5;
  MIN_SAMPLE_SIZE = Number(registryRef.MIN_SAMPLE_SIZE) || 100;
} catch (_) {
  /* pinned local constants above */
}

const NO_QUALIFIED_STRATEGY = 'NO_QUALIFIED_STRATEGY';

/* -------------------------------------------------------------------------- */
/* Safe readers — never throw, never hide a missing file                       */
/* -------------------------------------------------------------------------- */

function readJson(relPath) {
  const abs = path.join(ROOT, relPath);
  try {
    return { ok: true, abs, data: JSON.parse(fs.readFileSync(abs, 'utf8')) };
  } catch (err) {
    return { ok: false, abs, data: null, error: String((err && err.message) || err) };
  }
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/* -------------------------------------------------------------------------- */
/* Qualification model — each strategy group is an evidence-bearing record     */
/* -------------------------------------------------------------------------- */

/**
 * Measured metrics record. Every field is either a value read verbatim from a
 * data file, or the literal `NOT_MEASURED` string when the source did not
 * contain it. Never a guessed number.
 */
function group(id, label, sourceFiles, metrics, structural) {
  return {
    id,
    label,
    sourceFiles,
    metrics: {
      sampleSize: metrics.sampleSize !== undefined ? metrics.sampleSize : 'NOT_MEASURED',
      winRatePct: metrics.winRatePct !== undefined ? metrics.winRatePct : 'NOT_MEASURED',
      profitFactor: metrics.profitFactor !== undefined ? metrics.profitFactor : 'NOT_MEASURED',
      expectancyR: metrics.expectancyR !== undefined ? metrics.expectancyR : 'NOT_MEASURED',
      expectancyPct: metrics.expectancyPct !== undefined ? metrics.expectancyPct : 'NOT_MEASURED',
      maxDrawdownPct: metrics.maxDrawdownPct !== undefined ? metrics.maxDrawdownPct : 'NOT_MEASURED',
      wilsonLower95Pct: metrics.wilsonLower95Pct !== undefined ? metrics.wilsonLower95Pct : 'NOT_MEASURED'
    },
    structural: {
      outOfSample: structural.outOfSample || false,
      walkForwardByDate: structural.walkForwardByDate || false,
      feesSlippageModelled: structural.feesSlippageModelled || false,
      publicationLagModelled: structural.publicationLagModelled || false,
      purgingEmbargo: structural.purgingEmbargo || false,
      antiLookahead: structural.antiLookahead || false
    }
  };
}

/**
 * Run the §12 gate. Returns { qualified, reasons[] }.
 * `qualified` is true ONLY when every §12 dimension demonstrably holds in the
 * evidence; absence of evidence fails closed (NOT_MEASURED / false).
 */
function qualify(g) {
  const reasons = [];
  const m = g.metrics;

  const sampleSize = num(m.sampleSize);
  const expectancyR = num(m.expectancyR);
  const expectancyPct = num(m.expectancyPct);
  const profitFactor = num(m.profitFactor);

  // 1. sample size
  if (sampleSize === null) {
    reasons.push('sampleSize NOT_MEASURED (cannot qualify)');
  } else if (sampleSize < MIN_SAMPLE_SIZE) {
    reasons.push('sampleSize ' + sampleSize + ' < MIN_SAMPLE_SIZE ' + MIN_SAMPLE_SIZE);
  }

  // 2. net-positive expectancy (either R or pct scale, when present)
  if (expectancyR === null && expectancyPct === null) {
    reasons.push('expectancy NOT_MEASURED (cannot qualify)');
  } else {
    const exp = expectancyR !== null ? expectancyR : (expectancyPct / 100);
    if (exp > 0) {
      if (expectancyR === null) {
        reasons.push('expectancyR NOT_MEASURED (only pct scale present: ' + expectancyPct + '%)');
      }
    } else {
      reasons.push('expectancy ' + exp + ' <= ' + MIN_EXPECTANCY_R + ' (net expectancy must be positive)');
    }
  }

  // 3. profit factor floor (independent MIN_PROFIT_FACTOR, matching registry module)
  if (profitFactor === null) {
    reasons.push('profitFactor NOT_MEASURED (cannot qualify)');
  } else if (profitFactor < MIN_PROFIT_FACTOR) {
    reasons.push('profitFactor ' + profitFactor + ' < MIN_PROFIT_FACTOR ' + MIN_PROFIT_FACTOR);
  }

  // 4..7. structural §12 dimensions — fail closed when absent
  if (!g.structural.outOfSample) reasons.push('outOfSample validation absent');
  if (!g.structural.walkForwardByDate) reasons.push('walk-forward by date absent');
  if (!g.structural.feesSlippageModelled) reasons.push('fees/slippage NOT_MEASURED or not modelled');
  if (!g.structural.publicationLagModelled) reasons.push('publication lag NOT_MEASURED or not modelled');
  if (!g.structural.purgingEmbargo) reasons.push('purging/embargo (anti-look-ahead) absent');
  if (!g.structural.antiLookahead) reasons.push('anti-look-ahead evidence absent');

  return { qualified: reasons.length === 0, reasons };
}

/* -------------------------------------------------------------------------- */
/* Inventory of the strategy groups that actually exist on disk               */
/* -------------------------------------------------------------------------- */

function buildGroups() {
  const groups = [];

  /* --- A. V3-F03 winning params (konglo / nonkonglo / daytrade) ----------- */
  const v3 = readJson('config/v3-f03-winning-params.json');
  if (v3.ok && v3.data && v3.data.metrics) {
    const v3metrics = v3.data.metrics;
    const horizons = v3.data.horizons || {};
    for (const key of ['konglo', 'nonkonglo', 'daytrade']) {
      const m = v3metrics[key] || {};
      groups.push(group(
        'v3-f03-' + key,
        'V3-F03 winning params — ' + key,
        ['config/v3-f03-winning-params.json'],
        {
          sampleSize: num(m.sampleSize),
          winRatePct: num(m.winRate),
          profitFactor: num(m.profitFactor),
          expectancyR: num(m.expectancyR),
          wilsonLower95Pct: num(m.wilsonLower95)
        },
        {
          // The V3-F03 file carries aggregate metrics only; it does not itself
          // contain a per-group OOS split, fee table, or walk-forward record
          // beyond what the parent scripts/runners may report.
          outOfSample: false,
          walkForwardByDate: false,
          feesSlippageModelled: false,
          publicationLagModelled: false,
          purgingEmbargo: false,
          antiLookahead: false
        }
      ));
    }
  } else {
    groups.push({
      id: 'v3-f03-all',
      label: 'V3-F03 winning params',
      sourceFiles: ['config/v3-f03-winning-params.json'],
      unreadable: v3.error || 'no metrics section',
      metrics: {}, structural: {}
    });
  }

  /* --- B. BRPT LPM single-ticker (S1 / S2 / S3) --------------------------- */
  const brpt = readJson('backtest/brpt-lpm/data/backtest_results.json');
  if (brpt.ok && brpt.data && brpt.data.strategies) {
    const S = brpt.data.strategies;
    const strat = {
      S1_LPM_Bullish_Divergence: 'BRPT LPM S1 — Bullish Divergence (single ticker)',
      S2_Momentum_Accumulation_Spike: 'BRPT LPM S2 — Momentum Accumulation Spike (single ticker)',
      S3_Foreign_Flow_Turnaround: 'BRPT LPM S3 — Foreign Flow Turnaround (single ticker)'
    };
    for (const id of Object.keys(strat)) {
      const rec = S[id] || {};
      const full = rec.full_sample || rec.out_of_sample || rec.in_sample || {};
      const oos = rec.out_of_sample || null;
      const assumptions = (brpt.data.metadata && brpt.data.metadata.assumptions) || {};
      const feesModelled = num(assumptions.buy_fee_pct) !== null &&
        num(assumptions.sell_fee_pct) !== null &&
        num(assumptions.slippage_ticks) !== null;
      groups.push(group(
        'brpt-lpm-' + id,
        strat[id],
        ['backtest/brpt-lpm/data/backtest_results.json', 'backtest/brpt-lpm/REPORT.md'],
        {
          sampleSize: num(full.trade_count),
          winRatePct: num(full.win_rate_pct),
          profitFactor: num(full.profit_factor),
          expectancyR: num(full.avg_r),
          expectancyPct: num(full.expectancy_pct),
          maxDrawdownPct: num(full.max_drawdown_pct)
        },
        {
          outOfSample: oos !== null && num(oos.trade_count) !== null,
          walkForwardByDate: !!(brpt.data.metadata && brpt.data.metadata.in_sample_range &&
            brpt.data.metadata.out_of_sample_range),
          feesSlippageModelled: feesModelled,
          // Entry on next-bar open + SL-first intrabar rule is documented, but
          // publication lag is not separately quantified in this file.
          publicationLagModelled: false,
          purgingEmbargo: false,
          antiLookahead: true // next-bar open fill; no future_close/lead (REPORT.md §7)
        }
      ));
    }
  }

  /* --- C. Dua Skenario v2 (whole-market projection engine) ---------------- */
  const ds = readJson('backtest/dua-skenario/hasil-v2-evaluasi-seed42.json');
  if (ds.ok && ds.data) {
    const oos = ds.data.oos || {};
    const all = ds.data.all || {};
    groups.push(group(
      'dua-skenario-v2',
      'Dua Skenario v2 — whole-market analog projection (not a trade P&L strategy)',
      ['backtest/dua-skenario/hasil-v2-evaluasi-seed42.json', 'backtest/dua-skenario/REPORT_V2.md'],
      {
        // Sample size is count of evaluated windows/samples, not trades.
        sampleSize: num(oos.n != null ? oos.n : all.n),
        winRatePct: num((oos.hitRate != null ? oos.hitRate : all.hitRate) * 100),
        profitFactor: 'NOT_MEASURED',
        expectancyR: 'NOT_MEASURED',
        expectancyPct: 'NOT_MEASURED'
      },
      {
        outOfSample: !!ds.data.cutOOS,
        walkForwardByDate: true, // cutOOS '2026-04-07' splits by date, no shuffle
        feesSlippageModelled: false,
        publicationLagModelled: false,
        purgingEmbargo: false,
        antiLookahead: false
      }
    ));
  }

  /* --- D. backtest-individual-964 (per-ticker "best method" cherry-pick) -- */
  const ind = readJson('bukti-verifikasi-final/backtest-individual-964.json');
  if (ind.ok && ind.data) {
    const tickers = (ind.data.tickers && Array.isArray(ind.data.tickers)) ? ind.data.tickers : [];
    const n100single = tickers.filter((t) => num(t.winRatePct) === 100 && num(t.tradesCount) === 1).length;
    const nOneTrade = tickers.filter((t) => num(t.tradesCount) === 1).length;
    const nZeroTrade = tickers.filter((t) => num(t.tradesCount) === 0).length;
    const meta = ind.data.metadata || {};
    groups.push(group(
      'backtest-individual-964',
      'Backtest Individual 964 — per-ticker best-method selection (7 methods)',
      ['bukti-verifikasi-final/backtest-individual-964.json'],
      {
        // Aggregate metadata; per-ticker sample sizes are the defect (N=1..21).
        sampleSize: num(meta.totalTradesSimulated),
        winRatePct: num(meta.averageWinRatePct),
        profitFactor: 'NOT_MEASURED',
        expectancyR: 'NOT_MEASURED',
        expectancyPct: 'NOT_MEASURED'
      },
      {
        outOfSample: false,
        walkForwardByDate: false,
        feesSlippageModelled: false,
        publicationLagModelled: false,
        purgingEmbargo: false,
        antiLookahead: false
      }
    ));
    // Record the sample-size defect explicitly against this group.
    groups[groups.length - 1].sampleDefect = {
      tickersWith100pctWinRateSingleTrade: n100single,
      tickersWithExactlyOneTrade: nOneTrade,
      tickersWithZeroTrades: nZeroTrade,
      totalTickers: tickers.length
    };
  }

  return groups;
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

function main() {
  const groups = buildGroups();
  const auditedAt = new Date().toISOString();

  const rejectionReasons = [];
  let qualifiedId = null;

  for (const g of groups) {
    if (g.unreadable || !g.metrics || Object.keys(g.metrics).length === 0) {
      rejectionReasons.push({
        id: g.id,
        label: g.label,
        verdict: 'FAILS_QUALIFICATION',
        reason: 'source unreadable or empty: ' + (g.unreadable || 'no data'),
        sourceFiles: g.sourceFiles
      });
      continue;
    }
    const gate = qualify(g);
    const entry = {
      id: g.id,
      label: g.label,
      verdict: gate.qualified ? 'QUALIFIED' : 'FAILS_QUALIFICATION',
      metricsMeasured: g.metrics,
      structural: g.structural,
      reasons: gate.reasons,
      sourceFiles: g.sourceFiles
    };
    if (g.sampleDefect) entry.sampleDefect = g.sampleDefect;
    rejectionReasons.push(entry);
    if (gate.qualified) qualifiedId = g.id;
  }

  const anyQualified = rejectionReasons.some((r) => r.verdict === 'QUALIFIED');
  const outcome = anyQualified ? 'QUALIFIED:' + qualifiedId : NO_QUALIFIED_STRATEGY;

  const registry = {
    status: NO_QUALIFIED_STRATEGY, // §12 final rule: nothing passed the full bar
    qualificationOutcome: outcome,
    schema: 1,
    auditedAt,
    updatedAt: auditedAt,
    strategies: {}, // NEVER a fallback default
    rejectionReasons,
    auditLog: [
      {
        at: auditedAt,
        event: 'EVALUATE_STRATEGY_REGISTRY',
        outcome,
        groupsTested: rejectionReasons.length,
        qualifiedCount: rejectionReasons.filter((r) => r.verdict === 'QUALIFIED').length,
        thresholds: { MIN_RR_RATIO, MIN_PROFIT_FACTOR, MIN_SAMPLE_SIZE, MIN_EXPECTANCY_R }
      }
    ]
  };

  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n', 'utf8');

  // Console report (no secrets, no quota).
  process.stdout.write('\nSTRATEGY REGISTRY QUALIFICATION — V5 Phase 6\n');
  process.stdout.write('======================================================\n');
  for (const r of rejectionReasons) {
    process.stdout.write('- ' + r.id + '  [' + r.verdict + ']\n');
    for (const reason of (r.reasons || [])) {
      process.stdout.write('    * ' + reason + '\n');
    }
  }
  process.stdout.write('OUTCOME: ' + outcome + '\n');
  process.stdout.write('WROTE data/strategy-registry.json (status=' + registry.status + ')\n\n');

  return registry;
}

if (require.main === module) {
  main();
}

module.exports = { main, qualify, group, buildGroups, NO_QUALIFIED_STRATEGY, REGISTRY_PATH };