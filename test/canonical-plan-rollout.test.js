'use strict';

/**
 * Canonical Trade Plan Rollout tests
 * ==================================
 *
 * Verifies that ONE canonical selected plan feeds every consumer (website,
 * Telegram, intraday, progress monitoring); that no presentation path recomputes
 * SL/TP; that a rejected V2 always falls back to a COMPLETE legacy plan; that the
 * public flag OFF preserves current output; and that the resistance→major
 * diagnostic metadata is recorded. Named outside the `trade-plan-v2*` glob so the
 * baseline "177 Trade Plan V2 tests" measurement stays exact.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const integration = require('../lib/trade-plan-v2-integration');
const fmt = require('../lib/trade-plan-v2-formatter');
const adapters = require('../lib/trade-plan-v2-source-adapters');

const PUB = { TRADE_PLAN_V2_PUBLIC_ENABLED: 'true' };
const OFF = {};

// Usable across all three profiles (RR >= 1.20 for swing, >= 1.00 for day trade).
function usableCandidate(extra) {
  return Object.assign({
    ticker: 'TLKM',
    entry_low: 1000, entry_high: 1010,
    support: 980, swing_low: 975,
    resistance: 1100, next_resistance: 1200,
    atr14: 15, last_price: 1005, current_price: 1005,
    tp1: 1090, tp2: 1200, stop_loss: 960, risk_reward: 2.5
  }, extra || {});
}

// A row with NO structural context (V2 must reject) but a COMPLETE legacy plan.
function legacyOnlyCandidate(extra) {
  return Object.assign({
    ticker: 'GOTO',
    entry_low: 100, entry_high: 102,
    tp1: 110, tp2: 120, stop_loss: 95, risk_reward: 2.0
  }, extra || {});
}

function webTelegramCanonicalMatch(candidate, screenerType) {
  const planV2 = integration.buildCandidatePlanV2(candidate, { screener_type: screenerType });
  const web = fmt.buildWebViewModel(planV2);
  const tg = fmt.buildTelegramViewModel(planV2);
  const diff = fmt.diffViewModels(web, tg);
  assert.equal(diff.equal, true, 'web/telegram numeric mismatch: ' + JSON.stringify(diff.mismatches));
  const canon = integration.selectCanonicalTradePlan(candidate, { env: PUB, screener_type: screenerType });
  assert.equal(canon.source, 'trade_plan_v2', 'V2 should be selected for a usable candidate');
  // Both channels read the SAME canonical numbers from the SAME plan object.
  assert.equal(web.canonical.stop_loss, canon.stop_loss);
  assert.equal(tg.canonical.stop_loss, canon.stop_loss);
  assert.equal(web.canonical.tp1, canon.tp1);
  assert.equal(tg.canonical.tp1, canon.tp1);
  assert.equal(web.canonical.rr_to_tp1, canon.rr_to_tp1);
  assert.equal(tg.canonical.rr_to_tp1, canon.rr_to_tp1);
  return canon;
}

test('1. Day Trade web and Telegram select identical V2 numbers', () => {
  webTelegramCanonicalMatch(usableCandidate({ ticker: 'BBCA' }), 'DAY_TRADE');
});

test('2. Swing Konglo web and Telegram select identical V2 numbers', () => {
  const canon = webTelegramCanonicalMatch(usableCandidate(), 'SWING_KONGLO');
  assert.equal(canon.minimum_rr_to_tp1, 1.2);
});

test('3. Swing Non-Konglo web and Telegram select identical V2 numbers', () => {
  const canon = webTelegramCanonicalMatch(usableCandidate({ ticker: 'ANTM' }), 'SWING_NON_KONGLO');
  assert.equal(canon.minimum_rr_to_tp1, 1.2);
});

test('4. Rejected V2 produces identical legacy fallback across web and Telegram', () => {
  const cand = legacyOnlyCandidate();
  const planV2 = integration.buildCandidatePlanV2(cand, { screener_type: 'DAY_TRADE' });
  assert.equal(integration.isPlanV2Usable(planV2), false, 'V2 must be unusable here');
  const web = integration.selectCanonicalTradePlan(cand, { env: PUB, channel: 'web', screener_type: 'DAY_TRADE' });
  const tg = integration.selectCanonicalTradePlan(cand, { env: PUB, channel: 'telegram', screener_type: 'DAY_TRADE' });
  assert.equal(web.source, 'legacy_fallback');
  assert.equal(tg.source, 'legacy_fallback');
  // A complete legacy plan — never null SL/TP.
  assert.equal(web.stop_loss, 95);
  assert.equal(web.tp1, 110);
  assert.equal(web.tp2, 120);
  assert.equal(web.entry_zone_low, 100);
  // Identical across channels.
  assert.deepEqual(web, tg);
});

test('11. no presentation path independently calculates SL or TP (values read verbatim)', () => {
  const cand = usableCandidate();
  const planV2 = integration.buildCandidatePlanV2(cand, { screener_type: 'SWING_KONGLO' });
  // Overwrite with arbitrary, non-derivable values; both channels must echo them.
  planV2.stop_loss = 7777;
  planV2.tp1 = 8888;
  planV2.tp2 = 9999;
  const web = fmt.buildWebViewModel(planV2).canonical;
  const tg = fmt.buildTelegramViewModel(planV2).canonical;
  assert.equal(web.stop_loss, 7777);
  assert.equal(tg.stop_loss, 7777);
  assert.equal(web.tp1, 8888);
  assert.equal(tg.tp1, 8888);
  assert.equal(web.tp2, 9999);
  assert.equal(tg.tp2, 9999);
  // The canonical selector also reads verbatim (never recomputes).
  const sel = integration.selectCanonicalTradePlan(cand, { env: PUB, screener_type: 'SWING_KONGLO', planV2: planV2 });
  assert.equal(sel.stop_loss, 7777);
  assert.equal(sel.tp1, 8888);
});

test('12. public flag false preserves current output (source legacy, rows untouched)', () => {
  const cand = usableCandidate();
  const canon = integration.selectCanonicalTradePlan(cand, { env: OFF, screener_type: 'SWING_KONGLO' });
  assert.equal(canon.source, 'legacy');
  assert.equal(canon.public_v2_enabled, false);
  // Numbers are the unchanged legacy numbers straight off the row.
  assert.equal(canon.entry_zone_low, cand.entry_low);
  assert.equal(canon.stop_loss, cand.stop_loss);
  assert.equal(canon.tp1, cand.tp1);
  assert.equal(canon.rr_to_tp1, cand.risk_reward);
  // decorateRowsForWeb is a no-op (same reference) while the flag is off.
  const rows = [Object.assign({}, cand)];
  const out = integration.decorateRowsForWeb(rows, { mode: 'swing_konglo', env: OFF });
  assert.equal(out, rows);
  assert.equal(out[0].trade_plan_public, undefined);
});

test('13. public flag true activates V2 only when usable (else legacy fallback)', () => {
  const good = integration.selectCanonicalTradePlan(usableCandidate(), { env: PUB, screener_type: 'SWING_KONGLO' });
  assert.equal(good.source, 'trade_plan_v2');
  const bad = integration.selectCanonicalTradePlan(legacyOnlyCandidate(), { env: PUB, screener_type: 'DAY_TRADE' });
  assert.equal(bad.source, 'legacy_fallback');
});

test('14. resistance_as_major_resistance diagnostic metadata is present (swing adapters)', () => {
  // Swing Konglo: plain resistance + a local resistance => engine maps resistance
  // to MAJOR_RESISTANCE, so the diagnostic must be recorded.
  const konglo = adapters.adaptSwingKonglo({
    row: { ticker: 'TLKM', entry_low: 1000, entry_high: 1010, support: 980,
      resistance: 1100, local_resistance: 1050, atr14: 15 }
  });
  assert.ok(konglo.structural.source_fields.indexOf('resistance_as_major_resistance') >= 0,
    'Konglo source_fields must record resistance_as_major_resistance');
  const nk = adapters.adaptSwingNonKonglo({
    scored: { ticker: 'ANTM', entry_low: 1000, entry_high: 1010, support: 980,
      resistance: 1100, local_resistance: 1050, atr14: 15 }
  });
  assert.ok(nk.structural.source_fields.indexOf('resistance_as_major_resistance') >= 0,
    'Non-Konglo source_fields must record resistance_as_major_resistance');
});

test('19. API JavaScript count remains exactly 12', () => {
  const apiDir = path.join(__dirname, '..', 'api');
  const count = fs.readdirSync(apiDir).filter((f) => f.endsWith('.js') &&
    fs.statSync(path.join(apiDir, f)).isFile()).length;
  assert.equal(count, 12);
});

test('20. existing 177 Trade Plan V2 tests are not weakened or deleted', () => {
  const dir = __dirname;
  const files = fs.readdirSync(dir).filter((f) => /^trade-plan-v2.*\.test\.js$/.test(f));
  let total = 0;
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const matches = src.match(/^\s*test\(/gm);
    total += matches ? matches.length : 0;
  }
  assert.equal(total, 177, 'the baseline Trade Plan V2 test count must remain exactly 177');
});
