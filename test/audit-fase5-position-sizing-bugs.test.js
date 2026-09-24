'use strict';

/**
 * BATCH 3 / FASE 5 — Position Sizing Calculator: capital bounds, risk-percent
 * bounds and NaN/Infinity containment.
 *
 * Zero-trust: every assertion was reproduced against the REAL implementation
 * before it was touched (see scratch/batch3-probe*.js).
 *
 * The calculator is the LAST line of defence between a signal card and a real
 * order, so an input that silently parses to the wrong magnitude (a minus sign
 * swallowing a thousand separator), a risk percentage outside the supported
 * band, or an output field that becomes Infinity is a money-management defect.
 *
 * Network: none. Pure computation. No DOM required.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const PositionSizing = require('../public/position-sizing-calculator');

// ---------------------------------------------------------------------------
// F5-B3-01 — a leading minus sign must not destroy the thousand separator
// `numericPrefixStripped` only stripped non-numeric characters that are NOT a
// minus, so "-Rp 10.000" kept its "Rp" prefix, the thousand-group heuristic saw
// groups ["-Rp 10","000"] and failed, and the value collapsed to -10 instead of
// -10000 — a 1000x magnitude error on any negative figure.
// ---------------------------------------------------------------------------
test('F5-B3-01: a negative amount with a currency prefix keeps its magnitude', () => {
  assert.equal(PositionSizing.sanitizeNumber('-Rp 10.000', -1), -10000,
    '-Rp 10.000 must be minus ten thousand, not minus ten');
  assert.equal(PositionSizing.sanitizeNumber('-Rp 1.000.000', -1), -1000000,
    '-Rp 1.000.000 must be minus one million');
  assert.equal(PositionSizing.sanitizeNumber('-10.000', -1), -10000,
    'a bare negative thousand-separated figure must keep its magnitude');
  assert.equal(PositionSizing.sanitizeNumber('-0.500', -1), -0.5,
    'a small negative decimal must still be -0.5');
  // Positive forms must not regress.
  assert.equal(PositionSizing.sanitizeNumber('Rp 10.000', -1), 10000);
  assert.equal(PositionSizing.sanitizeNumber('Rp 10.000.000', -1), 10000000);
});

// ---------------------------------------------------------------------------
// F5-B3-02 — scientific notation must not be re-read as a bigger integer
// Stripping non-numeric characters turned "1e400" into "1400": the "e" was
// deleted instead of rejected, so a garbage/overflow input became a plausible
// number. "1e400" overflows to Infinity, and any exponential form is outside
// the calculator's contract.
// ---------------------------------------------------------------------------
test('F5-B3-02: exponential/garbage input must fall back, never be re-read as a digit string', () => {
  assert.equal(PositionSizing.sanitizeNumber('1e400', -1), -1,
    '1e400 overflows IEEE-754 and must fall back, not become 1400');
  assert.equal(PositionSizing.sanitizeNumber('1e3', -1), -1,
    'exponential notation is not part of the input contract and must fall back');
  assert.equal(PositionSizing.sanitizeNumber('abc', -1), -1, 'non-numeric text must fall back');
  assert.equal(PositionSizing.sanitizeNumber('', -1), -1, 'empty string must fall back');
  assert.equal(PositionSizing.sanitizeNumber(null, -1), -1, 'null must fall back');
  assert.equal(PositionSizing.sanitizeNumber(undefined, -1), -1, 'undefined must fall back');
  assert.equal(PositionSizing.sanitizeNumber(NaN, -1), -1, 'NaN must fall back');
  assert.equal(PositionSizing.sanitizeNumber(Infinity, -1), -1, 'Infinity must fall back');
  // Supported forms keep working.
  assert.equal(PositionSizing.sanitizeNumber('10000', -1), 10000);
  assert.equal(PositionSizing.sanitizeNumber('1,5', -1, { decimal: true }), 1.5);
});

// ---------------------------------------------------------------------------
// F5-B3-03 — the risk percentage must be clamped to the supported band
// `saveSettings` clamps to 0.1–10%, but `calculate` passed the raw value
// through, so a caller could size a position at 500% risk while the UI that
// stores the same setting would never allow it. One rule, one implementation.
// ---------------------------------------------------------------------------
test('F5-B3-03: riskPct must be clamped to the supported 0.1-10% band', () => {
  const high = PositionSizing.calculate({ capital: 10000000, riskPct: 500, entry: 1000, sl: 950 });
  assert.equal(high.isValid, true);
  assert.equal(high.riskPct, 10, 'a 500% risk request must be clamped to the 10% ceiling');

  const low = PositionSizing.calculate({ capital: 10000000, riskPct: 0.001, entry: 1000, sl: 950 });
  assert.equal(low.riskPct, 0.1, 'a 0.001% risk request must be raised to the 0.1% floor');

  const negative = PositionSizing.calculate({ capital: 10000000, riskPct: -3, entry: 1000, sl: 950 });
  assert.ok(negative.riskPct >= 0.1 && negative.riskPct <= 10,
    'a negative risk percentage must be sanitised into the supported band, never used as-is');

  const normal = PositionSizing.calculate({ capital: 10000000, riskPct: 1.5, entry: 1000, sl: 950 });
  assert.equal(normal.riskPct, 1.5, 'a value inside the band must pass through untouched');
});

// ---------------------------------------------------------------------------
// F5-B3-04 — the trading capital must be bounded and never overflow the maths
// capital 1e308 produced lots = 2e302 and profitTp1Idr = Infinity while still
// reporting isValid: true. An "Rp Infinity" position suggestion is worse than
// a refusal.
// ---------------------------------------------------------------------------
test('F5-B3-04: an absurd capital must be clamped so every output stays finite', () => {
  const huge = PositionSizing.calculate({ capital: 1e308, riskPct: 1, entry: 1000, sl: 950, tp1: 9e15, tp2: 9e15 });
  assert.equal(huge.isValid, true, 'a clamped capital is still a usable calculation');
  assert.ok(Number.isFinite(huge.capital), 'capital must be finite');
  assert.ok(huge.capital <= PositionSizing.MAX_CAPITAL_IDR, 'capital must respect the ceiling');
  assert.ok(Number.isFinite(huge.lots), 'lots must stay finite');
  assert.ok(Number.isFinite(huge.profitTp1Idr), 'TP1 profit must stay finite (was Infinity)');
  assert.ok(Number.isFinite(huge.profitTp1Pct), 'TP1 profit percent must stay finite');
  assert.ok(Number.isFinite(huge.positionValue), 'position value must stay finite');
  assert.ok(Number.isFinite(huge.actualRiskIdr), 'actual risk must stay finite');
  assert.ok(Number.isFinite(huge.cashRemaining), 'cash remaining must stay finite');
});

test('F5-B3-04b: every numeric field of a valid result is finite (hostile-input sweep)', () => {
  const NUMERIC_FIELDS = ['capital', 'riskPct', 'entry', 'sl', 'deltaP', 'riskPerLot', 'costPerLot',
    'lots', 'shares', 'positionValue', 'actualRiskIdr', 'actualRiskPct', 'cashRemaining',
    'allocationPct', 'profitTp1Idr', 'profitTp1Pct', 'profitTp2Idr', 'profitTp2Pct',
    'minCapitalFor1Lot', 'minCapitalFor1LotRisk'];

  const hostile = [
    { capital: 1e308, riskPct: 1e308, entry: 1000, sl: 950 },
    { capital: Infinity, riskPct: Infinity, entry: 1000, sl: 950 },
    { capital: NaN, riskPct: NaN, entry: 1000, sl: 950 },
    { capital: -1e9, riskPct: -50, entry: 1000, sl: 950 },
    { capital: 1e21, riskPct: 1, entry: 1e15, sl: 1 },
    { capital: 10000000, riskPct: 1, entry: 9e15, sl: 1 },
    { capital: 10000000, riskPct: 1, entry: 1000, sl: 950, tp1: 9e15, tp2: 9e15 },
    { capital: 'Rp 10.000.000', riskPct: '1,5', entry: '1.000', sl: '950' }
  ];

  for (const params of hostile) {
    const res = PositionSizing.calculate(params);
    assert.equal(typeof res.isValid, 'boolean');
    if (!res.isValid) continue;
    for (const f of NUMERIC_FIELDS) {
      assert.ok(Number.isFinite(res[f]),
        `field ${f} must be finite for params ${JSON.stringify(params)} (got ${res[f]})`);
    }
    assert.ok(res.lots >= 0 && Number.isInteger(res.lots), 'lots must be a non-negative integer');
    assert.ok(res.actualRiskIdr <= res.capital * (res.riskPct / 100) + 1e-6,
      'actual risk must never exceed the risk budget');
    assert.ok(res.positionValue <= res.capital, 'position value must never exceed the capital');
  }
});

// ---------------------------------------------------------------------------
// F5-B3-05 — sizing semantics must not regress (1 lot = 100 shares, floor)
// ---------------------------------------------------------------------------
test('F5-B3-05: 1 lot = 100 shares and lots are floored, never rounded up', () => {
  const res = PositionSizing.calculate({ capital: 10000000, riskPct: 1, entry: 1000, sl: 955, tp1: 1100, tp2: 1200 });
  // budget 100000 / riskPerLot 4500 -> floor 22 (ceil 23 would risk 103500 > budget)
  assert.equal(res.lots, 22, 'lots must be floored');
  assert.equal(res.shares, 2200, 'shares must be lots x 100');
  assert.equal(res.riskPerLot, 100 * (1000 - 955), 'risk per lot must use the 100-share lot');
  assert.equal(res.costPerLot, 100 * 1000, 'cost per lot must use the 100-share lot');
  assert.ok(res.actualRiskIdr <= 100000, 'floored lots must never breach the risk budget');
});
