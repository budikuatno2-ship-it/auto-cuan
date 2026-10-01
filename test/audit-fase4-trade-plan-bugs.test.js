'use strict';

/**
 * BATCH 3 / FASE 4 — Trade Plan V2: IDX price fraction, SL/TP distance integrity.
 *
 * Zero-trust: every assertion below was reproduced against the REAL
 * implementation before it was touched.
 *
 * Root cause of the four defects: the internal `tick(price, mode)` helper was
 * made board-aware (F11-01) for the MAIN derivation paths, but four call sites
 * were left board-blind. On an FCA / Papan Akselerasi ticker — where the price
 * fraction is a flat Rp1 — the stop-loss anchor, the trailing activation price
 * and the emergency anchor were snapped with the REGULAR board table (Rp2/5/10/
 * 25) on exactly the paths a caller sees when a plan is degraded or rejected.
 *
 * Network: none. Pure computation, no wall-clock reads.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tp = require('../lib/trade-plan-v2');
const idx = require('../lib/idx-tick-normalization');

const TP_SOURCE = path.join(__dirname, '..', 'lib', 'trade-plan-v2.js');

// FCA reference values. 803 and 998 are off-tick on the regular board (tick 5
// for 500–2000: 803 % 5 = 3, 998 % 5 = 3) but perfectly valid Rp1-tick prices
// on Papan Akselerasi / FCA.
const FCA_BOARD = 'AKSELERASI';
const FCA_TICKER = 'LUCK'; // listed in KNOWN_FCA_TICKERS

// ---------------------------------------------------------------------------
// F4-B3-01 — trailing activation price on the ACTIVE branch ignored the board
// `computeTrailingStop` builds the activation price once (board-aware) but the
// `active: true` return object recomputed it with `tick(activationPrice,
// 'nearest')`, dropping the board context.
// ---------------------------------------------------------------------------
test('F4-B3-01: trailing activation price must honour the FCA Rp1 tick on the active branch', () => {
  const res = tp.computeTrailingStop({
    entry: 251,
    riskAmount: 10,
    tp1: 300,
    currentPrice: 262,
    highestClose: 265,
    atr: 2,
    atrMultiplier: 1,
    board: FCA_BOARD,
    is_fca: true,
    ticker: FCA_TICKER
  });

  assert.equal(res.active, true, 'trailing must be active: +1R (261) has been reached at 262');
  // Activation = min(+1R, TP1) = min(261, 300) = 261.
  // FCA tick 1  -> 261 stays 261.
  // Board-blind -> regular tick 2 snaps 261 to 262 (the defect).
  assert.equal(res.activation_price, 261, 'FCA activation price must stay 261, not snap to the regular-board 262');
  assert.equal(idx.roundToIdxTick(261, 'nearest', FCA_BOARD, true, FCA_TICKER), 261, 'fixture sanity: 261 is a valid FCA tick');
  assert.equal(idx.roundToIdxTick(261, 'nearest', null, null, null), 262, 'fixture sanity: 261 is off-tick on the regular board (tick 2)');
  // The ratcheted stop itself already threads the board context; keep it pinned.
  assert.equal(res.trailing_stop, 263, 'highest_close 265 minus 1xATR(2) floored on the FCA tick stays 263');
  assert.ok(idx.isValidIdxPriceLevel(res.activation_price, FCA_BOARD, true, FCA_TICKER),
    'an emitted activation price must be a valid price on the ticker own board');
});

// ---------------------------------------------------------------------------
// F4-B3-02 — REJECTED / NO_STRUCTURAL_LEVEL emergency anchor ignored the board
// ---------------------------------------------------------------------------
test('F4-B3-02: the emergency anchor of a rejected plan must honour the FCA Rp1 tick', () => {
  const plan = tp.buildTradePlanV2({
    ticker: FCA_TICKER,
    board: FCA_BOARD,
    is_fca: true,
    entry_low: 1000,
    entry_high: 1000,
    current_price: 1000,
    // 803 is 19.7% below entry: too distant for the DAY_TRADE normal budget
    // (12%), so the plan rejects on NO_STRUCTURAL_LEVEL and 803 survives only
    // as the emergency diagnostic anchor.
    major_support: 803,
    resistance: 1100,
    atr14: 5
  }, { screener_type: 'DAY_TRADE' });

  assert.equal(plan.status, tp.STATUS.REJECTED);
  assert.equal(plan.reject_reason, tp.WARN.NO_STRUCTURAL_LEVEL);
  assert.equal(plan.emergency_anchor_price, 803,
    'the FCA anchor must be reported as 803, not snapped to the regular-board 800');
  assert.ok(idx.isValidIdxPriceLevel(plan.emergency_anchor_price, FCA_BOARD, true, FCA_TICKER),
    'a diagnostic anchor must still be a valid price on its own board');
});

// ---------------------------------------------------------------------------
// F4-B3-03 — STOP_NOT_BELOW_ENTRY anchors ignored the board
// ---------------------------------------------------------------------------
test('F4-B3-03: anchors emitted on the STOP_NOT_BELOW_ENTRY path must honour the FCA Rp1 tick', () => {
  const plan = tp.buildTradePlanV2({
    ticker: FCA_TICKER,
    board: FCA_BOARD,
    is_fca: true,
    entry_low: 1000,
    entry_high: 1000,
    current_price: 1000,
    support: 998,
    swing_low: 998,
    resistance: 1300,
    // ATR 4000 makes the volatility buffer (2000) exceed the support itself,
    // so the stop cannot be placed below entry and the plan is rejected with
    // its anchors still exposed for the operator.
    atr14: 4000
  }, { screener_type: 'DAY_TRADE' });

  assert.equal(plan.status, tp.STATUS.REJECTED);
  assert.equal(plan.reject_reason, 'STOP_NOT_BELOW_ENTRY');
  assert.equal(plan.stop_anchor_price, 998,
    'the FCA stop anchor must be 998, not the regular-board 995');
  assert.equal(plan.emergency_anchor_price, 998,
    'the FCA emergency anchor must be 998, not the regular-board 995');
  assert.equal(plan.structural_invalidation, 998, 'structural invalidation was already board-aware and must stay 998');
});

// ---------------------------------------------------------------------------
// F4-B3-04 — source-level lock: no `tick()` call may omit the board context
// The three defects above are instances of ONE omission. This guard fails if
// any future call site forgets the board context again, which is how the four
// sites survived the F11-01 fix in the first place.
// ---------------------------------------------------------------------------
function boardBlindTickSites(source) {
  const offenders = [];
  let inspected = 0;
  const lines = String(source).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    // Comments legitimately mention tick() while explaining the contract.
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    if (!/(^|[^A-Za-z0-9_])tick\(/.test(line)) continue;
    if (/function\s+tick\s*\(/.test(line)) continue; // the definition itself
    inspected++;
    if (line.indexOf('board') < 0) offenders.push((i + 1) + ': ' + trimmed);
  }
  return { offenders, inspected };
}

test('F4-B3-04: every tick() call site in the V2 engine must pass the board context', () => {
  const source = fs.readFileSync(TP_SOURCE, 'utf8');
  const { offenders, inspected } = boardBlindTickSites(source);

  assert.ok(inspected >= 20, `the scan must actually see the engine call sites (saw ${inspected})`);
  assert.deepEqual(offenders, [],
    'these tick() calls omit board/isFca/ticker, so FCA and Akselerasi tickers get regular-board prices:\n' + offenders.join('\n'));
});

// ---------------------------------------------------------------------------
// F4-B3-05 — SL/TP distance integrity (regression lock)
// The canonical engine is the ONE source of Entry/SL/TP for all three screeners,
// so a level that violates its own geometry is a money-management defect no
// matter which screener produced the candidate.
// ---------------------------------------------------------------------------
test('F4-B3-05: emitted plans must keep SL/TP geometry and per-share risk arithmetic', () => {
  const cases = [
    { entry: 1000, support: 950, resistance: 1100, atr: 5 },
    { entry: 200, support: 190, resistance: 215, atr: 2 },
    { entry: 5000, support: 4800, resistance: 5400, atr: 40 },
    { entry: 251, support: 240, resistance: 275, atr: 2, board: FCA_BOARD, is_fca: true, ticker: FCA_TICKER }
  ];

  for (const screener of ['DAY_TRADE', 'SWING_NON_KONGLO', 'SWING_KONGLO']) {
    for (const c of cases) {
      const plan = tp.buildTradePlanV2(Object.assign({
        ticker: 'BBCA',
        entry_low: c.entry,
        entry_high: c.entry,
        current_price: c.entry,
        support: c.support,
        swing_low: c.support,
        resistance: c.resistance,
        atr14: c.atr
      }, c.board ? { board: c.board, is_fca: c.is_fca, ticker: c.ticker } : {}), { screener_type: screener });

      const label = screener + ' entry=' + c.entry;
      for (const [k, v] of Object.entries(plan)) {
        if (typeof v === 'number') assert.ok(Number.isFinite(v), `${label}: field ${k} must never be non-finite (got ${v})`);
      }
      if (plan.status === tp.STATUS.REJECTED) continue;

      assert.ok(plan.stop_loss > 0, `${label}: an emitted SL must be a positive price (got ${plan.stop_loss})`);
      assert.ok(plan.stop_loss < plan.entry_zone_low, `${label}: SL must sit below entry_low`);
      assert.ok(plan.risk_amount > 0, `${label}: risk per share must be positive`);
      assert.equal(plan.risk_amount, Math.round((plan.entry_zone_high - plan.stop_loss + Number.EPSILON) * 100) / 100,
        `${label}: risk_amount must be the per-share distance entry_high - SL (a x100 lot conflation would break this)`);
      if (plan.tp1 !== null) {
        assert.ok(plan.tp1 > plan.entry_zone_high, `${label}: TP1 must sit above the entry zone`);
        assert.ok(plan.tp1 > plan.stop_loss, `${label}: TP1 must sit above SL`);
        assert.equal(plan.reward_to_tp1, Math.round((plan.tp1 - plan.entry_zone_high + Number.EPSILON) * 100) / 100,
          `${label}: reward_to_tp1 must be the per-share distance TP1 - entry_high`);
        const rr = Math.round((plan.reward_to_tp1 / plan.risk_amount + Number.EPSILON) * 10000) / 10000;
        assert.equal(plan.rr_to_tp1, rr, `${label}: rr_to_tp1 must equal reward/risk on the same per-share basis`);
      }
      if (plan.tp2 !== null && plan.tp1 !== null) {
        assert.ok(plan.tp2 >= plan.tp1, `${label}: TP2 must not sit below TP1`);
      }
      assert.ok(plan.stop_distance_pct <= plan.profile.reject_stop_pct,
        `${label}: an emitted plan must stay inside the profile reject_stop_pct`);
    }
  }
});

test('F4-B3-05b: the engine never fabricates a lot count (1 lot = 100 shares is a sizing concern)', () => {
  const plan = tp.buildTradePlanV2({
    ticker: 'BBCA', entry_low: 1000, entry_high: 1000, current_price: 1000,
    support: 950, swing_low: 950, resistance: 1100, atr14: 5
  }, { screener_type: 'DAY_TRADE' });

  // The V2 engine is per-share by contract: it must not expose a lot/shares
  // field, because a x100 lot conversion inside the plan would silently
  // inflate every displayed risk figure by two orders of magnitude.
  const lotFields = Object.keys(plan).filter((k) => /lots?$|shares/i.test(k));
  assert.deepEqual(lotFields, [], 'trade-plan-v2 must not invent lot/share fields (sizing lives in the sizing calculator)');
  assert.equal(plan.risk_amount, plan.entry_zone_high - plan.stop_loss, 'risk_amount stays a per-share figure');
});
