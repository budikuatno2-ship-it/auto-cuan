'use strict';

/**
 * Test suite for Swing Non-Konglo High R:R Warning Flag.
 *
 * Product Decision:
 * Sinyal Swing Non-Konglo dengan target R:R > 2.5:1 diberi flag peringatan
 * informasional (high_rr_warning + high_rr_warning_note) karena temuan data
 * historis menunjukkan sinyal SL_HIT rata-rata punya R:R 3.3:1 vs TP1_HIT 2.1:1.
 * Flag ini TIDAK PERNAH memblokir, memfilter, atau mengubah scoring/level kandidat.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://stub.supabase.local';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'stub-service-key';
process.env.CRON_SECRET = process.env.CRON_SECRET || 'test-secret';

const sectorHot = require('../api/sector-hot');
const swingNkRrWarning = require('../lib/swing-nk-rr-warning');
const { SWING_NK_HIGH_RR_WARNING_THRESHOLD, INITIAL_CLASSIFICATION_THRESHOLDS } = require('../lib/daytrade-screener-constants');

function makeMockSupabase(nkRows) {
  return {
    from: function(table) {
      let data = [];
      if (table === 'swing_screener_non_konglo_latest') data = nkRows || [];
      const api = {
        select: function() { return api; },
        order: function() { return api; },
        eq: function() { return api; },
        neq: function() { return api; },
        in: function() { return api; },
        limit: function() { return api; },
        maybeSingle: function() {
          return Promise.resolve({
            data: { id: 'latest', status: 'published', run_date: '2026-08-28', calculated_at: new Date().toISOString() },
            error: null
          });
        },
        then: function(resolve, reject) {
          return Promise.resolve({ data: data, count: data.length, error: null }).then(resolve, reject);
        }
      };
      return api;
    }
  };
}

// --- 1. Constant Verification ---

test('SWING_NK_HIGH_RR_WARNING_THRESHOLD is exported and equals 2.5', () => {
  assert.equal(swingNkRrWarning.SWING_NK_HIGH_RR_WARNING_THRESHOLD, 2.5);
  assert.equal(SWING_NK_HIGH_RR_WARNING_THRESHOLD, 2.5);
  assert.equal(sectorHot.__test.SWING_NK_HIGH_RR_WARNING_THRESHOLD, 2.5);
  assert.ok(INITIAL_CLASSIFICATION_THRESHOLDS, 'Initial classification thresholds preserved');
});

// --- 2. Pure Unit Tests for R:R calculation & Annotation ---

test('calculateCandidateRiskReward computes accurate R:R from levels', () => {
  // entry=100 (mid of 99 and 101), sl=95 (risk=5), tp1=116.5 (reward=16.5) => R:R = 3.3
  const highRrCandidate = { entry_low: 99, entry_high: 101, sl: 95, tp1: 116.5 };
  const rrHigh = swingNkRrWarning.calculateCandidateRiskReward(highRrCandidate);
  assert.equal(Number(rrHigh.toFixed(2)), 3.3);

  // entry=100, sl=95 (risk=5), tp1=110.5 (reward=10.5) => R:R = 2.1
  const normalRrCandidate = { entry_low: 100, entry_high: 100, stop_loss: 95, tp1n: 110.5 };
  const rrNormal = swingNkRrWarning.calculateCandidateRiskReward(normalRrCandidate);
  assert.equal(Number(rrNormal.toFixed(2)), 2.1);
});

test('annotateSwingNkHighRrWarning flags candidate when R:R > 2.5', () => {
  // Case A: R:R = 3.3:1 (historical SL average setup)
  const candidate = {
    ticker: 'TEST',
    entry_low: 100,
    entry_high: 100,
    stop_loss: 95,
    tp1: 116.5,
    score: 85,
    status: 'Swing Ready'
  };

  swingNkRrWarning.annotateSwingNkHighRrWarning(candidate);

  assert.equal(candidate.high_rr_warning, true);
  assert.match(candidate.high_rr_warning_note, /Target R:R 3\.3:1 lebih tinggi dari rata-rata sinyal yang berhasil \(2\.1:1\)/);
  assert.match(candidate.high_rr_warning_note, /lebih sering kena SL sebelum TP pada window pantau swing 3-7 hari/);
});

test('annotateSwingNkHighRrWarning does NOT flag candidate when R:R <= 2.5', () => {
  // Case B: R:R = 2.1:1 (historical TP average setup)
  const candidateNormal = {
    ticker: 'CUAN',
    entry_low: 100,
    entry_high: 100,
    stop_loss: 95,
    tp1: 110.5,
    score: 80,
    status: 'Swing Ready'
  };

  swingNkRrWarning.annotateSwingNkHighRrWarning(candidateNormal);

  assert.equal(candidateNormal.high_rr_warning, false);
  assert.equal(candidateNormal.high_rr_warning_note, null);

  // Case C: Exact boundary R:R = 2.5:1 (entry=100, sl=90, tp1=125 => risk=10, reward=25 => 2.5)
  const candidateBoundary = {
    ticker: 'BOND',
    entry_low: 100,
    entry_high: 100,
    stop_loss: 90,
    tp1: 125
  };

  swingNkRrWarning.annotateSwingNkHighRrWarning(candidateBoundary);
  assert.equal(candidateBoundary.high_rr_warning, false, 'Boundary 2.5 must not be flagged (strictly > 2.5)');
});

// --- 3. Category Scoping Tests ---

test('High R:R warning applies ONLY to Swing Non-Konglo (NOT Swing Konglo or Day Trade)', () => {
  const kongloRow = {
    ticker: 'BBCA',
    category: 'Swing Konglo',
    entry_low: 100,
    entry_high: 100,
    stop_loss: 95,
    tp1: 116.5, // R:R = 3.3
    risk_reward: 3.3
  };

  const daytradeRow = {
    ticker: 'BUMI',
    category: 'Day Trade',
    entry_low: 100,
    entry_high: 100,
    stop_loss: 95,
    tp1: 116.5, // R:R = 3.3
    risk_reward: 3.3
  };

  const nkRow = {
    ticker: 'MEDC',
    category: 'Swing Non-Konglo',
    entry_low: 100,
    entry_high: 100,
    stop_loss: 95,
    tp1: 116.5, // R:R = 3.3
    risk_reward: 3.3
  };

  // Test via enrichSignalQuality
  const enrichedKonglo = sectorHot.__test.enrichSignalQuality ? sectorHot.__test.enrichSignalQuality(kongloRow, 'Swing Konglo') : null;
  const enrichedDayTrade = sectorHot.__test.enrichSignalQuality ? sectorHot.__test.enrichSignalQuality(daytradeRow, 'Day Trade') : null;

  // Konglo & Day Trade must NOT have high_rr_warning
  if (enrichedKonglo) {
    assert.equal(enrichedKonglo.high_rr_warning, undefined);
  }
  if (enrichedDayTrade) {
    assert.equal(enrichedDayTrade.high_rr_warning, undefined);
  }

  // Non-Konglo MUST have high_rr_warning: true
  sectorHot.__test.annotateSwingNkHighRrWarning(nkRow);
  assert.equal(nkRow.high_rr_warning, true);
  assert.ok(nkRow.high_rr_warning_note);
});

// --- 4. Non-Mutation & Publish Stability Tests ---

test('High R:R warning never removes, filters, or mutates scoring/entry fields', () => {
  const candidates = [
    {
      ticker: 'HIGH1',
      entry_low: 100,
      entry_high: 102,
      stop_loss: 95,
      tp1: 125, // R:R ~ 4.0
      score: 88,
      grade: 'A',
      status: 'Swing Ready',
      risk_reward: 4.0,
      rank: 1
    },
    {
      ticker: 'NORM2',
      entry_low: 500,
      entry_high: 510,
      stop_loss: 480,
      tp1: 560, // R:R ~ 2.2
      score: 75,
      grade: 'B',
      status: 'Swing Ready',
      risk_reward: 2.2,
      rank: 2
    }
  ];

  const initialCount = candidates.length;
  const initialTickers = candidates.map(c => c.ticker);

  swingNkRrWarning.annotateSwingNkHighRrWarnings(candidates);

  // Assert count & order untouched
  assert.equal(candidates.length, initialCount, 'Candidate count must remain identical');
  assert.deepEqual(candidates.map(c => c.ticker), initialTickers, 'Candidate order must remain identical');

  // Candidate 1 (High R:R)
  assert.equal(candidates[0].score, 88, 'Score must not be mutated');
  assert.equal(candidates[0].grade, 'A', 'Grade must not be mutated');
  assert.equal(candidates[0].status, 'Swing Ready', 'Status must not be mutated');
  assert.equal(candidates[0].entry_low, 100, 'entry_low must not be mutated');
  assert.equal(candidates[0].stop_loss, 95, 'stop_loss must not be mutated');
  assert.equal(candidates[0].tp1, 125, 'tp1 must not be mutated');
  assert.equal(candidates[0].high_rr_warning, true, 'high_rr_warning must be true');
  assert.ok(candidates[0].high_rr_warning_note);

  // Candidate 2 (Normal R:R)
  assert.equal(candidates[1].score, 75, 'Score must not be mutated');
  assert.equal(candidates[1].high_rr_warning, false, 'high_rr_warning must be false');
  assert.equal(candidates[1].high_rr_warning_note, null);
});

// --- 5. Full Read API Integration Test ---

test('handleNkScreenerResults delivers high_rr_warning and note in results payload', async () => {
  const mockRows = [
    {
      rank: 1,
      ticker: 'HIGH',
      entry_low: 100,
      entry_high: 100,
      stop_loss: 95,
      tp1: 120, // R:R = 4.0
      risk_reward: 4.0,
      score: 85,
      status: 'Swing Ready',
      grade: 'A',
      last_price: 100,
      price_date: '2026-08-28',
      price_source: 'swing_screener_non_konglo_latest'
    },
    {
      rank: 2,
      ticker: 'NORM',
      entry_low: 200,
      entry_high: 200,
      stop_loss: 190,
      tp1: 220, // R:R = 2.0
      risk_reward: 2.0,
      score: 80,
      status: 'Swing Ready',
      grade: 'A',
      last_price: 200,
      price_date: '2026-08-28',
      price_source: 'swing_screener_non_konglo_latest'
    }
  ];

  let jsonResult = null;
  const res = {
    status: function(code) {
      assert.equal(code, 200);
      return {
        json: function(payload) {
          jsonResult = payload;
          return payload;
        }
      };
    }
  };

  const req = {
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
    _premiumAccessGranted: true,
    query: { action: 'nk-screener-results' }
  };

  const supabase = makeMockSupabase(mockRows);

  await sectorHot.__test.handleNkScreenerResults(req, res, supabase);

  assert.ok(jsonResult, 'Must return JSON response');
  assert.equal(jsonResult.success, true);
  assert.equal(jsonResult.results.length, 2, 'Published candidate count must be 2');

  const highCandidate = jsonResult.results.find(r => r.ticker === 'HIGH');
  const normCandidate = jsonResult.results.find(r => r.ticker === 'NORM');

  assert.ok(highCandidate, 'HIGH candidate must be present');
  assert.equal(highCandidate.high_rr_warning, true);
  assert.match(highCandidate.high_rr_warning_note, /Target R:R (4|4\.0):1 lebih tinggi/);

  assert.ok(normCandidate, 'NORM candidate must be present');
  assert.equal(normCandidate.high_rr_warning, false);
  assert.equal(normCandidate.high_rr_warning_note, null);
});

// --- 6. Normalization & Pipeline Verification ---

test('normalizeCombinedCandidate annotates high_rr_warning for Swing Non-Konglo but never for Konglo or Day Trade', () => {
  const rawHighRr = {
    ticker: 'MEDC',
    entry_low: 100,
    entry_high: 100,
    stop_loss: 95,
    tp1: 116.5, // R:R = 3.3
    risk_reward: 3.3,
    score: 85,
    status: 'Swing Ready'
  };

  // Swing Non-Konglo
  const nkNormalized = sectorHot.__test.normalizeCombinedCandidate(rawHighRr, 'Swing Non-Konglo');
  assert.equal(nkNormalized.high_rr_warning, true);
  assert.match(nkNormalized.high_rr_warning_note, /Target R:R 3\.[34]:1 lebih tinggi/);

  // Swing Konglo
  const kongloNormalized = sectorHot.__test.normalizeCombinedCandidate(rawHighRr, 'Swing Konglo');
  assert.equal(kongloNormalized.high_rr_warning, undefined, 'Swing Konglo must not receive high_rr_warning');

  // Day Trade
  const dtNormalized = sectorHot.__test.normalizeCombinedCandidate(rawHighRr, 'Day Trade');
  assert.equal(dtNormalized.high_rr_warning, undefined, 'Day Trade must not receive high_rr_warning');
});

test('Threshold override in opts.threshold is respected while default remains 2.5', () => {
  const candidate = {
    ticker: 'TEST',
    entry_low: 100,
    entry_high: 100,
    stop_loss: 90,
    tp1: 124, // R:R = 2.4
    risk_reward: 2.4
  };

  // Default threshold (2.5) -> not flagged
  swingNkRrWarning.annotateSwingNkHighRrWarning(candidate);
  assert.equal(candidate.high_rr_warning, false);

  // Custom threshold (2.0) -> flagged
  swingNkRrWarning.annotateSwingNkHighRrWarning(candidate, { threshold: 2.0 });
  assert.equal(candidate.high_rr_warning, true);
  assert.match(candidate.high_rr_warning_note, /Target R:R 2\.4:1 lebih tinggi/);
});
