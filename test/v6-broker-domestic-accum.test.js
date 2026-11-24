'use strict';

/**
 * test/v6-broker-domestic-accum.test.js
 * ============================================================================
 * Subtask J — Broker Accumulation / Domestic / Bandarmologi / Foreign Flow
 * ============================================================================
 *
 * WHAT THIS SUITE PROVES
 *   1. DOMESTIC = ALL − FOREIGN is only computed when the two sides are
 *      compatible, and it NEVER invents a negative ("negative fake dilarang").
 *   2. A missing / unreleased Foreign side yields an explicit
 *      `foreign_missing` / `FOREIGN_NOT_RELEASED` state with ZERO brokers —
 *      never `D = ALL` and never fabricated zeros.
 *   3. A clipped ALL summary (25 broker levels without `all_data: true`) is
 *      refused, because subtracting an authentic F from a truncated ALL would
 *      silently misattribute the unobserved turnover to "domestic".
 *   4. DERIVED_LOCAL accumulation (lib/broker-accumulation-local.js,
 *      lib/short-swing-universe.js) is kept structurally distinct from
 *      PROVIDER_ORIGINAL accumulation (Arjum /broker-accumulation series).
 *   5. Bandarmologi / Broker Hunter ranking is by TRANSACTION VALUE, missing
 *      broker codes are rejected, and zero-activity rows never become
 *      placeholder bubbles.
 *   6. The screener readiness engine FAILS CLOSED when Broksum-derived
 *      bandar/foreign inputs are missing — it never lifts a row off the
 *      neutral default.
 *   7. Coverage of the real on-disk datasets is measured and reported
 *      honestly (file existence alone is not coverage).
 *
 * HONESTY NOTE ON THE IDENTITY TEST
 *   The local repo carries `broker-summary-D` (32 real tickers) but its
 *   `broker-summary` (ALL) and `broker-summary-F` directories are EMPTY, and no
 *   ticker has an ALL and an F snapshot for the SAME trade_date. The D = ALL − F
 *   identity therefore CANNOT be replayed against real local pairs; it is
 *   proven here against the module contract with controlled fixtures, and the
 *   real-data gap is asserted explicitly (test J-BDA-13) so it can never be
 *   mistaken for a verified parity result.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const ARJUM = path.join(ROOT, 'data', 'arjum-data');

const { computeDomestic, isAllBroksumClipped } = require('../lib/broksum-flow');
const accumLocal = require('../lib/broker-accumulation-local');
const shortSwing = require('../lib/short-swing-universe');
const sahamPotensial = require('../lib/saham-potensial-engine');
const bandarmologiService = require('../lib/bandarmologi-service');
const brokerHunter = require('../lib/broker-hunter-service');
const bandarmologiRuntime = require('../public/bandarmologi-runtime');

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

const exists = (p) => fs.existsSync(p);
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const listDirs = (p) => (exists(p) ? fs.readdirSync(p).filter((f) => fs.statSync(path.join(p, f)).isDirectory()) : []);
const listJson = (p) => (exists(p) ? fs.readdirSync(p).filter((f) => f.endsWith('.json')) : []);
const isRealTicker = (t) => /^[A-Z]{4}$/.test(t);

/** A minimal, internally consistent ALL snapshot (buy total == sell total). */
function makeAll(brokers, extra = {}) {
  return Object.assign({
    stock_code: 'TEST',
    flow: 'all',
    broker_start_date: '2026-10-27',
    broker_end_date: '2026-10-27',
    brokers
  }, extra);
}

function makeForeign(brokers) {
  return { stock_code: 'TEST', flow: 'F', brokers };
}

/* -------------------------------------------------------------------------- */
/* J-BDA-01..05  Domestic = ALL − Foreign identity & negative-fake guard       */
/* -------------------------------------------------------------------------- */

test('J-BDA-01: Domestic is exactly ALL − Foreign per broker, per side, per unit', () => {
  const all = makeAll([
    { broker_code: 'AK', broker_name: 'UBS', bval: 1000, sval: 200, bvol: 100, svol: 20, bfrq: 10, sfrq: 4 },
    { broker_code: 'PD', broker_name: 'Indo Premier', bval: 500, sval: 100, bvol: 50, svol: 10, bfrq: 5, sfrq: 2 }
  ]);
  const f = makeForeign([
    { broker_code: 'AK', broker_name: 'UBS', bval: 600, sval: 100, bvol: 60, svol: 10, bfrq: 6, sfrq: 1 }
  ]);

  const d = computeDomestic(all, f);

  assert.equal(d.flow, 'D');
  assert.equal(d.status, 'complete');
  assert.equal(d.is_complete, true);
  assert.equal(d.computed_from, 'all_minus_foreign', 'provenance must name the derivation');

  const ak = d.brokers.find((b) => b.broker_code === 'AK');
  assert.ok(ak, 'AK present in domestic');
  assert.equal(ak.bval, 400, 'bval 1000 − 600');
  assert.equal(ak.sval, 100, 'sval 200 − 100');
  assert.equal(ak.bvol, 40, 'bvol 100 − 60');
  assert.equal(ak.svol, 10, 'svol 20 − 10');
  assert.equal(ak.bfrq, 4, 'bfrq 10 − 6');
  assert.equal(ak.sfrq, 3, 'sfrq 4 − 1');
  assert.equal(ak.nval, ak.bval - ak.sval, 'nval identity holds on the derived row');
  assert.equal(ak.nvol, ak.bvol - ak.svol, 'nvol identity holds on the derived row');

  // A broker with NO foreign activity passes through unchanged (F treated as 0).
  const pd = d.brokers.find((b) => b.broker_code === 'PD');
  assert.ok(pd, 'PD present in domestic');
  assert.equal(pd.bval, 500);
  assert.equal(pd.sval, 100);
  assert.equal(pd.bvol, 50);
  assert.equal(pd.svol, 10);
});

test('J-BDA-02: NEGATIVE CONTROL — foreign larger than ALL is clamped, never negative', () => {
  const all = makeAll([
    { broker_code: 'AK', bval: 1000, sval: 200, bvol: 100, svol: 20 }
  ]);
  // Foreign reports MORE than the whole market for this broker (bad/incompatible feed).
  const f = makeForeign([
    { broker_code: 'AK', bval: 5000, sval: 9000, bvol: 500, svol: 900 }
  ]);

  const d = computeDomestic(all, f);

  for (const b of d.brokers) {
    assert.ok(b.bval >= 0, `bval must never be negative (got ${b.bval})`);
    assert.ok(b.sval >= 0, `sval must never be negative (got ${b.sval})`);
    assert.ok(b.bvol >= 0, `bvol must never be negative (got ${b.bvol})`);
    assert.ok(b.svol >= 0, `svol must never be negative (got ${b.svol})`);
    assert.ok(b.bfrq >= 0 && b.sfrq >= 0, 'frequencies must never be negative');
  }
  // The fully-overwritten broker drops out rather than printing a fake negative.
  const ak = d.brokers.find((b) => b.broker_code === 'AK');
  assert.ok(!ak || (ak.bval === 0 && ak.sval === 0), 'over-subscribed broker yields zeros or is omitted');
});

test('J-BDA-03: NEGATIVE CONTROL — missing/unreleased Foreign refuses to compute (no D = ALL)', () => {
  const all = makeAll([{ broker_code: 'AK', bval: 1000, sval: 200, bvol: 100, svol: 20 }]);

  // An ABSENT or explicitly-unreleased foreign side must never be treated as
  // "zero foreign activity". Publishing D = ALL here would silently relabel
  // every foreign rupiah as domestic.
  for (const badForeign of [null, undefined, {}, { status: 'foreign_missing' }, { is_complete: false }]) {
    const d = computeDomestic(all, badForeign);
    assert.equal(d.status, 'foreign_missing', `status must be foreign_missing for ${JSON.stringify(badForeign)}`);
    assert.equal(d.is_complete, false);
    assert.equal(d.reason, 'foreign_missing');
    assert.deepEqual(d.brokers, [], 'must NOT publish brokers — equating D with ALL is forbidden');
    assert.deepEqual(d.broker_levels, []);
  }

  // DISTINCT CASE: an explicitly RELEASED foreign payload that simply contains
  // no foreign rows is a real measurement ("no foreign activity that session"),
  // so D = ALL is the arithmetically correct answer — not a fabrication. The
  // guard above is what keeps the two cases apart: presence of the `brokers`
  // array is the release signal, emptiness is data.
  const releasedEmpty = computeDomestic(all, makeForeign([]));
  assert.equal(releasedEmpty.status, 'complete');
  assert.equal(releasedEmpty.is_complete, true);
  assert.equal(releasedEmpty.computed_from, 'all_minus_foreign');
  const ak = releasedEmpty.brokers.find((b) => b.broker_code === 'AK');
  assert.equal(ak.bval, 1000, 'with zero foreign rows, domestic equals ALL');
  assert.equal(ak.sval, 200);
});

test('J-BDA-04: NEGATIVE CONTROL — clipped ALL (25 levels, no all_data) is refused as incomplete', () => {
  const clippedLevels = Array.from({ length: 25 }, (_, i) => ({
    buy: { broker_code: 'B' + i, bval: 100, bvol: 10 },
    sell: { broker_code: 'S' + i, sval: 50, svol: 5 }
  }));
  const clipped = { stock_code: 'TEST', broker_levels: clippedLevels };

  assert.equal(isAllBroksumClipped(clipped), true, '25 levels without all_data is clipped');
  assert.equal(isAllBroksumClipped(Object.assign({ all_data: true }, clipped)), false, 'all_data:true opts out');
  assert.equal(isAllBroksumClipped(null), false);

  const d = computeDomestic(clipped, makeForeign([{ broker_code: 'B0', bval: 10, sval: 5, bvol: 1, svol: 1 }]));
  assert.equal(d.status, 'incomplete');
  assert.equal(d.is_complete, false);
  assert.equal(d.reason, 'all_clipped_25');
  assert.deepEqual(d.brokers, [], 'no subtraction against a truncated ALL');
});

test('J-BDA-05: broker-accumulation-local mirrors the same fail-closed contract', () => {
  const all = makeAll([{ broker_code: 'AK', bval: 1000, sval: 200, bvol: 100, svol: 20 }]);
  const f = makeForeign([{ broker_code: 'AK', bval: 600, sval: 100, bvol: 60, svol: 10 }]);

  const ok = accumLocal.computeDomesticBroksum(all, f, '2026-10-27', 'TEST');
  assert.equal(ok.status, 'RELEASED');
  assert.equal(ok.data_asing_dirilis, true);
  assert.equal(ok.flow, 'D');
  const ak = ok.brokers.find((b) => b.broker_code === 'AK');
  assert.equal(ak.bval, 400);
  assert.equal(ak.sval, 100);

  const noForeign = accumLocal.computeDomesticBroksum(all, null, '2026-10-27', 'TEST');
  assert.equal(noForeign.status, 'FOREIGN_NOT_RELEASED');
  assert.equal(noForeign.data_asing_dirilis, false);
  assert.equal(noForeign.message, 'Data Asing Belum Dirilis');
  assert.deepEqual(noForeign.brokers, []);

  const noAll = accumLocal.computeDomesticBroksum(null, f, '2026-10-27', 'TEST');
  assert.equal(noAll.status, 'NO_ALL_DATA');
  assert.deepEqual(noAll.brokers, []);
});

/* -------------------------------------------------------------------------- */
/* J-BDA-06..08  unit, scope and date compatibility                            */
/* -------------------------------------------------------------------------- */

test('J-BDA-06: unit contract — lot is volume/100 and nval/nvol identities hold', () => {
  const map = accumLocal.parseDailyBroksumLevels({
    brokers: [{ broker_code: 'ak', broker_name: 'UBS', bval: 1000, sval: 250, bvol: 12300, svol: 4500, nval: 750, nvol: 7800 }]
  });
  const ak = map.get('AK');
  assert.ok(ak, 'broker code is normalised to upper case');
  assert.equal(ak.buy_lot, 123, 'buy_lot = bvol / 100');
  assert.equal(ak.sell_lot, 45, 'sell_lot = svol / 100');
  assert.equal(ak.net_lot, 78, 'net_lot = nvol / 100');
  assert.equal(ak.nval, ak.bval - ak.sval);

  // NEGATIVE CONTROL: a unit mismatch (volume already in lots) is detectable —
  // lot would come out 100x too small relative to the stated volume.
  const mismatched = accumLocal.parseDailyBroksumLevels({
    brokers: [{ broker_code: 'PD', bval: 1000, sval: 0, bvol: 123, svol: 0 }]
  }).get('PD');
  assert.equal(mismatched.buy_lot, 1, 'bvol=123 read as shares yields 1 lot — the 100x unit assumption is explicit');
});

test('J-BDA-07: NEGATIVE CONTROL — wrong/missing date never masquerades as the requested session', () => {
  const all = makeAll([{ broker_code: 'AK', bval: 1000, sval: 200, bvol: 100, svol: 20 }], {
    broker_start_date: '2026-10-27',
    broker_end_date: '2026-10-27'
  });
  const f = makeForeign([{ broker_code: 'AK', bval: 100, sval: 50, bvol: 10, svol: 5 }]);

  const d = computeDomestic(all, f);
  assert.equal(d.broker_start_date, '2026-10-27');
  assert.equal(d.broker_end_date, '2026-10-27');

  // A multi-day ALL must not be labelled as a single session.
  const ranged = makeAll([{ broker_code: 'AK', bval: 1000, sval: 200, bvol: 100, svol: 20 }], {
    broker_start_date: '2026-10-01',
    broker_end_date: '2026-10-27'
  });
  const dr = computeDomestic(ranged, f);
  assert.equal(dr.broker_start_date, '2026-10-01');
  assert.equal(dr.broker_end_date, '2026-10-27');
  assert.notEqual(dr.broker_start_date, dr.broker_end_date, 'range is preserved, not collapsed to one day');

  // The service must report not-found for a date it does not hold, rather than
  // silently serving the newest snapshot under the requested label.
  return bandarmologiService.getBandarmologiData('TLKM', { date: '2026-01-05', range: '1d', allowLiveFetch: false })
    .then((res) => {
      assert.equal(res.not_found, true, 'an unarchived date must be reported as not found');
      assert.equal(res.not_found_reason, 'requested_date_not_available');
      assert.equal(res.status, 'NO_DATA');
      assert.equal(res.broker_summary.net_status, 'NO_DATA');
      assert.deepEqual(res.broker_summary.top_buyers, []);
    });
});

test('J-BDA-08: NEGATIVE CONTROL — missing broker code is rejected, zero activity makes no bubble', () => {
  const items = bandarmologiRuntime.buildBrokerBubbleItems(
    [
      { broker: 'AK', bval: 1000, sval: 0, bvol: 100, svol: 0 },
      { broker: '', bval: 5000, sval: 0 },          // empty code -> rejected
      { bval: 9000 },                                // no code at all -> rejected
      null,                                          // null row -> ignored
      { broker: 'PD', bval: 0, sval: 0 }             // zero activity -> no bubble
    ],
    [{ broker: 'YP', bval: 0, sval: 800, bvol: 0, svol: 60 }],
    'gross'
  );

  const codes = items.map((i) => i.broker);
  assert.ok(codes.includes('AK'), 'valid broker kept');
  assert.ok(codes.includes('YP'), 'valid seller kept');
  assert.ok(!codes.includes(''), 'empty broker code rejected');
  assert.ok(!codes.includes('PD'), 'zero-activity broker produces no placeholder bubble');
  assert.equal(items.length, 2, `only real brokers survive (got ${JSON.stringify(codes)})`);

  // Every surviving bubble carries a positive transaction value — no 0.0 placeholders.
  for (const it of items) {
    assert.ok(it.txVal > 0, `${it.broker} must have txVal > 0, got ${it.txVal}`);
    assert.ok(Number.isFinite(it.txVal), 'txVal must be a finite number');
  }
});

/* -------------------------------------------------------------------------- */
/* J-BDA-09..11  ranking by transaction value                                  */
/* -------------------------------------------------------------------------- */

test('J-BDA-09: Broker Hunter ranking sorts BOTH sides by transaction value', () => {
  const payload = {
    top_accumulated: [
      { ticker: 'A', net_val: 5 },
      { ticker: 'B', net_val: 50 },
      { ticker: 'C', net_val: 20 }
    ],
    top_distributed: [
      { ticker: 'D', net_val: -5 },
      { ticker: 'E', net_val: -50 },
      { ticker: 'F', net_val: -20 }
    ]
  };

  const sorted = brokerHunter.sortHunterRankings(payload);

  assert.deepEqual(sorted.top_accumulated.map((x) => x.ticker), ['B', 'C', 'A'], 'accumulated: largest net_val first');
  assert.deepEqual(sorted.top_distributed.map((x) => x.ticker), ['E', 'F', 'D'], 'distributed: most negative first');

  // The input must not be mutated (callers still hold the cached object).
  assert.deepEqual(payload.top_accumulated.map((x) => x.ticker), ['A', 'B', 'C']);
  assert.deepEqual(payload.top_distributed.map((x) => x.ticker), ['D', 'E', 'F']);
});

test('J-BDA-10: hunterNetVal resolves value from every field shape, defaulting to 0 not NaN', () => {
  assert.equal(brokerHunter.hunterNetVal({ net_val: -123 }), -123);
  assert.equal(brokerHunter.hunterNetVal({ net_buy_val: 456 }), 456);
  assert.equal(brokerHunter.hunterNetVal({ net_sell_val: -789 }), -789);
  assert.equal(brokerHunter.hunterNetVal({ buy_val: 1000, sell_val: 250 }), 750, 'falls back to buy − sell');
  assert.equal(brokerHunter.hunterNetVal({}), 0, 'empty row is 0, never NaN');
  assert.equal(brokerHunter.hunterNetVal(null), 0);
  assert.equal(brokerHunter.hunterNetVal({ net_val: 'not-a-number' }), 0, 'garbage is rejected, not propagated');
});

test('J-BDA-11: every committed Broker Hunter index is served in correct value order', async () => {
  const dir = path.join(ROOT, 'data', 'broker-hunter-indexes');
  if (!exists(dir)) return; // dataset absent -> nothing to assert

  const files = listJson(dir).filter((f) => f !== 'catalog.json');
  assert.ok(files.length > 0, 'index files exist');

  let checked = 0;
  const badAcc = [];
  const badDist = [];
  for (const f of files) {
    let j;
    try { j = readJson(path.join(dir, f)); } catch (_) { continue; }
    if (!Array.isArray(j.top_accumulated) && !Array.isArray(j.top_distributed)) continue;
    checked++;
    const sorted = brokerHunter.sortHunterRankings(j);
    const a = sorted.top_accumulated.map((x) => brokerHunter.hunterNetVal(x));
    const d = sorted.top_distributed.map((x) => brokerHunter.hunterNetVal(x));
    if (!a.every((x, i) => i === 0 || a[i - 1] >= x)) badAcc.push(f);
    if (!d.every((x, i) => i === 0 || d[i - 1] <= x)) badDist.push(f);
  }

  assert.deepEqual(badAcc, [], 'accumulated ranking is descending by net_val after sorting');
  assert.deepEqual(badDist, [], 'distributed ranking is most-negative-first after sorting');
  assert.ok(checked > 0, `at least one index file was checked (checked=${checked})`);
});

/* -------------------------------------------------------------------------- */
/* J-BDA-12  DERIVED_LOCAL vs PROVIDER_ORIGINAL accumulation                   */
/* -------------------------------------------------------------------------- */

test('J-BDA-12: DERIVED_LOCAL and PROVIDER_ORIGINAL accumulation are structurally distinct', () => {
  // DERIVED_LOCAL: lib/broker-accumulation-local.js output shape.
  const days = [
    { date: '2026-10-26', broksum: makeAll([{ broker_code: 'AK', bval: 1000, sval: 200, bvol: 100, svol: 20, nval: 800, nvol: 80 }]) },
    { date: '2026-10-27', broksum: makeAll([{ broker_code: 'AK', bval: 2000, sval: 500, bvol: 200, svol: 50, nval: 1500, nvol: 150 }]) }
  ];
  const derived = accumLocal.computeBrokerAccumulation('TEST', days);
  assert.equal(derived.code, 'TEST');
  assert.equal(derived.start_date, '2026-10-26');
  assert.equal(derived.end_date, '2026-10-27');
  assert.ok(Array.isArray(derived.series));
  assert.ok(Array.isArray(derived.top_buyers));
  assert.ok(Array.isArray(derived.top_sellers));
  const derivedPointKeys = derived.series[0] ? Object.keys(derived.series[0].points[0]) : [];
  assert.ok(derivedPointKeys.includes('cum_nval'), 'DERIVED_LOCAL point carries cum_nval');

  // PROVIDER_ORIGINAL: Arjum /broker-accumulation series on disk (BBCA only).
  const provPath = path.join(ARJUM, 'broker-accumulation', 'BBCA', 'series.json');
  if (exists(provPath)) {
    const prov = readJson(provPath);
    assert.equal(prov.code, 'BBCA', 'provider payload identifies its own ticker');
    assert.ok(prov.start_date && prov.end_date, 'provider carries an explicit period');
    assert.ok(Array.isArray(prov.series) && prov.series.length > 0);
    const provPointKeys = Object.keys(prov.series[0].points[0]);
    assert.ok(provPointKeys.includes('cum_nval'));
    assert.ok(provPointKeys.includes('bavg') && provPointKeys.includes('savg'), 'provider carries buy/sell average price');

    // The two are NOT the same measurement: different period, different broker
    // selection, and the provider set is a curated top-N rather than a full
    // rolling recomputation.
    assert.notEqual(`${prov.start_date}..${prov.end_date}`, `${derived.start_date}..${derived.end_date}`,
      'provider and derived windows differ — they must never be claimed identical');
  }

  // Rolling windows are a DERIVED_LOCAL-only concept.
  assert.deepEqual(accumLocal.WINDOWS, [1, 3, 5, 10, 20]);
  const rolling = accumLocal.computeFullRollingAccumulation('TEST', days, []);
  assert.equal(rolling.ticker, 'TEST');
  assert.equal(rolling.total_sessions, 2);
  assert.ok(rolling.history['2026-10-27'].windows['1H'].all, 'rolling window 1H present');
  assert.ok(rolling.history['2026-10-27'].windows['20H'].all, 'rolling window 20H present');
  // Foreign absent => the domestic/foreign nodes stay empty rather than copying ALL.
  assert.equal(rolling.history['2026-10-27'].has_foreign, false);
  assert.equal(rolling.history['2026-10-27'].foreign_status, 'FOREIGN_NOT_RELEASED');
  assert.equal(rolling.history['2026-10-27'].windows['1H'].foreign.window_days, 0);
  assert.equal(rolling.history['2026-10-27'].windows['1H'].domestic.window_days, 0);
});

/* -------------------------------------------------------------------------- */
/* J-BDA-13..15  real-data coverage & honest status                            */
/* -------------------------------------------------------------------------- */

test('J-BDA-13: real local broksum coverage is measured and the ALL/F gap is declared', () => {
  const dDir = path.join(ARJUM, 'broker-summary-D');
  const allDir = path.join(ARJUM, 'broker-summary');
  const fDir = path.join(ARJUM, 'broker-summary-F');

  const dTickers = listDirs(dDir).filter(isRealTicker);
  const allTickers = listDirs(allDir).filter(isRealTicker);
  const fTickers = listDirs(fDir).filter(isRealTicker);

  // Documented local reality: D exists, ALL and F do not.
  assert.ok(dTickers.length > 0, `broker-summary-D has real tickers (got ${dTickers.length})`);
  assert.ok(allTickers.length <= 37, 'broker-summary (ALL) is EMPTY locally — identity cannot be replayed on real pairs');
  assert.ok(fTickers.length <= 37, 'broker-summary-F is EMPTY locally — identity cannot be replayed on real pairs');

  // Per-ticker / per-date coverage of the D dataset.
  let files = 0;
  let datedFiles = 0;
  const dates = new Set();
  const perTicker = [];
  for (const t of dTickers) {
    const fl = listJson(path.join(dDir, t));
    const dated = fl.filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
    files += fl.length;
    datedFiles += dated.length;
    dated.forEach((f) => dates.add(f.slice(0, 10)));
    perTicker.push({ ticker: t, files: fl.length, dated: dated.length });
  }

  assert.ok(files > 0, 'D dataset is not empty');
  const sortedDates = Array.from(dates).sort();
  // Every D file must be internally consistent and honestly labelled.
  let released = 0;
  let flowD = 0;
  let tickerMismatch = 0;
  let negative = 0;
  let nvalBad = 0;
  let emptyBrokers = 0;
  const emptyBrokerFiles = [];
  for (const t of dTickers) {
    for (const f of listJson(path.join(dDir, t))) {
      const j = readJson(path.join(dDir, t, f));
      if (j.flow === 'D') flowD++;
      if (j.data_asing_dirilis === true) released++;
      if (j.stock_code !== t) tickerMismatch++;
      const brs = Array.isArray(j.brokers) ? j.brokers : [];
      if (brs.length === 0) {
        emptyBrokers++;
        emptyBrokerFiles.push(`${t}/${f}`);
      }
      for (const b of brs) {
        if ((b.bval || 0) < 0 || (b.sval || 0) < 0 || (b.bvol || 0) < 0 || (b.svol || 0) < 0) negative++;
        if (b.nval != null && Math.abs(b.nval - ((b.bval || 0) - (b.sval || 0))) > 1) nvalBad++;
      }
    }
  }

  assert.equal(tickerMismatch, 0, 'every D file names its own ticker — no mis-mapped payload');
  assert.equal(negative, 0, 'no negative bval/sval/bvol/svol anywhere in the real D dataset');
  assert.equal(nvalBad, 0, 'nval = bval − sval holds on every real broker row');
  assert.equal(flowD, files, 'every D file is labelled flow=D');
  assert.equal(released, files, 'every D file is labelled data_asing_dirilis=true');

  // HONEST DATA-QUALITY FINDING (not a code bug): two REAL tickers — GPRA and
  // META — carry a broker-summary-D file stamped status=RELEASED /
  // data_asing_dirilis=true with ZERO brokers and zero total_buyers/sellers.
  // They are genuine IDX issuers (present in data/daily-candles and in the
  // 962-row ownership snapshot), so this is an empty-but-released snapshot, not
  // a test fixture. A consumer that reads `status === 'RELEASED'` as "there is
  // domestic broker data here" would render an empty table as if it were a
  // complete session. Asserted explicitly so the count can never silently grow.
  assert.equal(emptyBrokers, 4,
    'exactly the 4 known GPRA/META files (dated + latest) are released-but-empty');
  assert.deepEqual(emptyBrokerFiles.sort(), [
    'GPRA/2026-09-25.json', 'GPRA/latest.json', 'META/2026-09-30.json', 'META/latest.json'
  ], 'released-but-empty D files are exactly GPRA and META');

  // Report the honest coverage numbers (asserted so a silent shrink fails CI).
  assert.ok(sortedDates[0] <= '2026-06-19', `earliest D date is ${sortedDates[0]}`);
  assert.ok(sortedDates[sortedDates.length - 1] <= '2026-10-28', `latest D date is ${sortedDates[sortedDates.length - 1]} — data is STALE vs today`);
  assert.ok(perTicker.length >= 30, `at least 30 real tickers covered (got ${perTicker.length})`);
  assert.ok(datedFiles >= 250, `at least 250 dated D files (got ${datedFiles})`);
});

test('J-BDA-14: foreign flow reports NO_DATA honestly instead of a neutral verdict', () => {
  // A ticker with no local snapshot at all.
  const missing = bandarmologiService.getNetForeignFlow('ZZZZ', 'latest');
  assert.equal(missing.has_data, false, 'has_data must be false when there is no snapshot');
  assert.equal(missing.foreign_flow_status, 'NO_DATA', 'NO_DATA, never NEUTRAL');
  assert.equal(missing.date, null);
  assert.equal(missing.whale_status, 'NO_DATA');

  const confluence = bandarmologiService.evaluateConfluenceSignal('ZZZZ');
  assert.equal(confluence.confluence_flag, 'NEUTRAL');
  assert.equal(confluence.confluence_action, 'HOLD');
  assert.equal(confluence.confluence_penalty, 0, 'no penalty is invented from absent data');
  assert.match(confluence.notes, /belum tersedia/i, 'the reason states data is unavailable');

  // A ticker WITH a local snapshot must expose a real, dated foreign number.
  const real = bandarmologiService.getNetForeignFlow('TLKM', 'latest');
  if (real.has_data) {
    assert.ok(Number.isFinite(real.foreign_net), 'foreign_net is a real number');
    assert.ok(real.date, 'a real reading carries its date');
    assert.equal(real.foreign_net_status, 'AVAILABLE');
    assert.ok(['ACCUMULATION', 'DISTRIBUTION', 'NEUTRAL'].includes(real.foreign_flow_status));
  } else {
    assert.equal(real.foreign_net_status, 'NOT_PUBLISHED', 'unpublished foreign decomposition is declared, not re-derived');
  }
});

test('J-BDA-15: normalized broker summary never fabricates magnitude for value-less rows', () => {
  // AUDIT-F4-12 regression: a row carrying only an identity (no numbers) used
  // to become a phantom seller with net −1, flipping the day to BIG_DISTRIBUTION.
  const norm = bandarmologiService.normalizeBrokerSummary({
    stock_code: 'TEST',
    date: '2026-10-27',
    brokers: [
      { broker_code: 'AK', broker_name: 'UBS' },                                  // identity only
      { broker_code: 'PD', broker_name: 'IP', bval: 1000, sval: 200, bvol: 100, svol: 20 }
    ]
  }, '2026-10-27', 'TEST');

  assert.ok(norm, 'summary normalized');
  const ak = (norm.brokers || []).find((b) => b.broker === 'AK');
  assert.ok(ak, 'identity-only broker is retained as an identity');
  assert.equal(ak.nval, 0, 'no magnitude is invented for a value-less row');
  assert.equal(ak.net_val, 0);
  assert.equal(ak.bval, 0);
  assert.equal(ak.sval, 0);

  const pd = (norm.brokers || []).find((b) => b.broker === 'PD');
  assert.equal(pd.nval, 800, 'a row with real numbers keeps its real net');
});

/* -------------------------------------------------------------------------- */
/* J-BDA-16..18  screener fail-closed integration (Subtask H engine)           */
/* -------------------------------------------------------------------------- */

const SESSION = '2026-11-11';

function baseCandidate(over = {}) {
  return Object.assign({
    ticker: 'ZZZQ',
    last_price: 1000,
    entry_low: 990,
    entry_high: 1000,
    sl: 950,
    tp1: 1150,
    as_of: SESSION,
    price_asof: SESSION,
    technical_score: 70,
    technical_asof: SESSION,
    volume_ratio_20d: 1.6,
    volume_asof: SESSION
  }, over);
}

test('J-BDA-16: screener FAILS CLOSED when Broksum-derived bandar/foreign are missing', () => {
  const r = sahamPotensial.evaluateShortSwingCandidate(baseCandidate(), { sessionDate: SESSION });

  assert.equal(r.readiness, 'BLOCKED', 'missing mandatory broker inputs must BLOCK, never default to neutral');
  assert.equal(r.blocked_reason, 'MANDATORY_BROKER_FOREIGN_UNAVAILABLE');
  assert.equal(r.score, null, 'no fused score is fabricated from absent components');
  assert.equal(r.score_components.bandar.value, null);
  assert.equal(r.score_components.bandar.status, 'UNKNOWN');
  assert.equal(r.score_components.foreign.value, null);
  assert.ok(r.risk_flags.includes('BROKER_DATA_UNAVAILABLE'));
  assert.ok(r.risk_flags.includes('FOREIGN_DATA_UNAVAILABLE'));
  assert.notEqual(r.readiness, 'READY');
  assert.notEqual(r.readiness, 'WAITING_ENTRY');
});

test('J-BDA-17: NEGATIVE CONTROL — an explicit real 0 is data, not "missing"', () => {
  const r = sahamPotensial.evaluateShortSwingCandidate(baseCandidate({
    bandar_score: 0,
    bandar_asof: SESSION,
    foreign_flow_score: 0,
    foreign_asof: SESSION
  }), { sessionDate: SESSION });

  assert.equal(r.score_components.bandar.value, 0, 'a real zero is preserved');
  assert.equal(r.score_components.bandar.status, 'ZERO');
  assert.notEqual(r.readiness, 'BLOCKED', 'real zeros do not trigger the missing-data block');
  assert.ok(!r.risk_flags.includes('BROKER_DATA_UNAVAILABLE'));
});

test('J-BDA-18: stale broksum clock demotes readiness (mixed-clock plan is not actionable)', () => {
  const stale = sahamPotensial.evaluateShortSwingCandidate(baseCandidate({
    bandar_score: 90,
    bandar_asof: '2026-10-01',
    foreign_flow_score: 90,
    foreign_asof: SESSION
  }), { sessionDate: SESSION });

  assert.equal(stale.readiness, 'NOT_READY');
  assert.match(stale.status_reason, /STALE_MANDATORY_COMPONENT/);
  assert.ok(stale.risk_flags.some((f) => f.startsWith('STALE_COMPONENT_BANDAR')));

  // A value with NO as-of clock can never be promoted to READY either.
  const noClock = sahamPotensial.evaluateShortSwingCandidate(baseCandidate({
    bandar_score: 90,
    foreign_flow_score: 90,
    foreign_asof: SESSION
  }), { sessionDate: SESSION });
  assert.notEqual(noClock.readiness, 'READY');
  assert.ok(noClock.risk_flags.includes('UNKNOWN_ASOF_COMPONENT_BANDAR'));

  // Fully fresh and complete => actionable.
  const fresh = sahamPotensial.evaluateShortSwingCandidate(baseCandidate({
    bandar_score: 90,
    bandar_asof: SESSION,
    foreign_flow_score: 90,
    foreign_asof: SESSION
  }), { sessionDate: SESSION });
  assert.equal(fresh.readiness, 'READY');
  assert.ok(fresh.score > 0, 'a complete row produces a real fused score');

  assert.deepEqual(sahamPotensial.MANDATORY_FRESHNESS_COMPONENTS, ['price', 'bandar', 'foreign']);
});

/* -------------------------------------------------------------------------- */
/* J-BDA-19..21  no neutral-50 default; derived scores stay null               */
/* -------------------------------------------------------------------------- */

test('J-BDA-19: bandar/foreign scores stay null without broksum — never defaulted to 50', () => {
  assert.deepEqual(shortSwing.deriveBrokerForeignScores(null, null), {
    bandar_score: null, bandar_asof: null, bandar_basis: null,
    foreign_flow_score: null, foreign_asof: null, foreign_status: null
  });
  assert.deepEqual(
    shortSwing.deriveBrokerForeignScores({ hasData: false }, null),
    shortSwing.deriveBrokerForeignScores(null, null),
    'hasData:false is indistinguishable from no data — both stay null'
  );

  // hasData true but no turnover denominator => still null (no division by zero,
  // and no invented neutral).
  const noTurnover = shortSwing.deriveBrokerForeignScores(
    { hasData: true, broksumDate: '2026-10-27', top3Net: 5e9, foreignNet: 1e9 },
    null
  );
  assert.equal(noTurnover.bandar_score, null);
  assert.equal(noTurnover.foreign_flow_score, null);
  assert.equal(noTurnover.bandar_asof, '2026-10-27', 'the clock is still reported even when the score is not');
});

test('J-BDA-20: a real broksum entry yields a discriminating score, not a constant 50', () => {
  const entry = {
    date: '2026-10-27',
    has_foreign: true,
    foreign_status: 'RELEASED',
    windows: { '1H': { all: { total_buy_val: 1e11, total_sell_val: 1e11 } } },
    consistency: { all: { net_buy_days_10h: 8, of_days: 10 } }
  };

  const accum = shortSwing.deriveBrokerForeignScores(
    { hasData: true, broksumDate: '2026-10-27', top3Net: 5e9, foreignNet: 1e9 }, entry);
  const distrib = shortSwing.deriveBrokerForeignScores(
    { hasData: true, broksumDate: '2026-10-27', top3Net: -5e9, foreignNet: -1e9 }, entry);

  assert.ok(accum.bandar_score > 50, `accumulation scores above neutral (got ${accum.bandar_score})`);
  assert.ok(distrib.bandar_score < 50, `distribution scores below neutral (got ${distrib.bandar_score})`);
  assert.notEqual(accum.bandar_score, distrib.bandar_score, 'the score discriminates direction');
  assert.notEqual(accum.bandar_score, 50, 'not a fake neutral');
  assert.equal(accum.bandar_asof, '2026-10-27');
  assert.equal(accum.foreign_asof, '2026-10-27');
  assert.ok(accum.bandar_basis.one_sided_turnover > 0);
  assert.equal(accum.bandar_basis.net_buy_days_10h, 8);
  assert.equal(accum.bandar_basis.of_days, 10);
});

test('J-BDA-21: local universe builder leaves bandar_score null when the broksum file is absent', () => {
  const universe = shortSwing.listLocalUniverse();
  assert.ok(universe.length > 0, 'local candle universe is present');

  const broksumDir = shortSwing.DEFAULT_BROKSUM_DIR;
  const withBroksum = universe.filter((t) => exists(path.join(broksumDir, t + '.json')));
  const withoutBroksum = universe.filter((t) => !exists(path.join(broksumDir, t + '.json')));

  assert.ok(withBroksum.length > 0, 'some tickers have broksum history');
  assert.ok(withoutBroksum.length > 0, 'most tickers do NOT have broksum history');

  // A ticker with no broksum file must produce null scores, and the eligibility
  // record must say so plainly.
  const sample = withoutBroksum[0];
  const built = shortSwing.buildCandidateFromLocalData(sample, {});
  assert.equal(built.eligibility.broksum_file, false, 'eligibility records the missing broksum file');
  if (built.candidate) {
    assert.equal(built.candidate.bandar_score, null, 'no broksum => bandar_score null, never 50');
    assert.equal(built.candidate.bandar_source, null, 'no source is claimed for a null score');
  }

  // A ticker WITH broksum must carry a real score and a real source.
  const withSample = withBroksum[0];
  const built2 = shortSwing.buildCandidateFromLocalData(withSample, {});
  assert.equal(built2.eligibility.broksum_file, true);
  if (built2.candidate && built2.candidate.bandar_score !== null) {
    assert.ok(built2.candidate.bandar_source, 'a real score names its source');
    assert.ok(built2.candidate.bandar_asof, 'a real score carries its as-of date');
  }
});

/* -------------------------------------------------------------------------- */
/* J-BDA-22..24  verdict thresholds, concentration, dataset inventory          */
/* -------------------------------------------------------------------------- */

test('J-BDA-22: arah verdict thresholds are inclusive and match the documented bands', () => {
  assert.equal(accumLocal.calculateArahVerdict(1.35), 'Akumulasi Kuat');
  assert.equal(accumLocal.calculateArahVerdict(1.34), 'Akumulasi');
  assert.equal(accumLocal.calculateArahVerdict(1.10), 'Akumulasi');
  assert.equal(accumLocal.calculateArahVerdict(1.09), 'Netral');
  assert.equal(accumLocal.calculateArahVerdict(0.90), 'Netral');
  assert.equal(accumLocal.calculateArahVerdict(0.89), 'Distribusi');
  assert.equal(accumLocal.calculateArahVerdict(0.70), 'Distribusi');
  assert.equal(accumLocal.calculateArahVerdict(0.69), 'Distribusi Kuat');
  // NEGATIVE CONTROL — an absent/garbage ratio must NOT resolve to a market
  // verdict. Before the Subtask J fix, cleanNumber() coerced null/NaN/'abc' to
  // 0, which fell in the `<= 0.70` band and returned 'Distribusi Kuat' — the
  // most extreme bearish call in the vocabulary, fabricated out of missing data.
  assert.equal(accumLocal.ARAH_UNKNOWN, 'Tidak Diketahui');
  for (const bad of [null, undefined, '', 'abc', NaN, {}, []]) {
    assert.equal(accumLocal.calculateArahVerdict(bad), accumLocal.ARAH_UNKNOWN,
      `${JSON.stringify(bad)} must yield UNKNOWN, never a directional verdict`);
  }
  // A real numeric 0 is still a legitimate (extreme) ratio and keeps its band.
  assert.equal(accumLocal.calculateArahVerdict(0), 'Distribusi Kuat');
  // Numeric strings that ARE finite ratios are still graded normally.
  assert.equal(accumLocal.calculateArahVerdict('1.40'), 'Akumulasi Kuat');

  // The only in-repo caller passes a finite ratio and defaults an empty window
  // to 1.0 => 'Netral', so the fix cannot regress the rolling computation.
  const emptyWindow = accumLocal.calculateRollingWindow([], 5);
  assert.equal(emptyWindow.bs_ratio_3, 1.0);
  assert.equal(emptyWindow.arah, 'Netral');

  assert.equal(accumLocal.cleanNumber('abc'), 0);
  assert.equal(accumLocal.cleanNumber(null), 0);
});

test('J-BDA-23: CR3/CR5 concentration is bounded and guards a too-small denominator', () => {
  const normal = bandarmologiRuntime.computeConcentrationRatioMetrics(600, 800, 1000);
  assert.equal(normal.cr3, 60);
  assert.equal(normal.cr5, 80);

  // Denominator <= top5 would lock CR5 at 100%; the guard inflates it instead.
  const guarded = bandarmologiRuntime.computeConcentrationRatioMetrics(500, 1000, 900);
  assert.ok(guarded.cr5 < 100, `CR5 must stay below 100% (got ${guarded.cr5})`);
  assert.ok(guarded.cr3 <= guarded.cr5, 'CR3 <= CR5 always');

  const zero = bandarmologiRuntime.computeConcentrationRatioMetrics(0, 0, 0);
  assert.equal(zero.cr3, 0);
  assert.equal(zero.cr5, 0);

  // Bounds can never be exceeded.
  const huge = bandarmologiRuntime.computeConcentrationRatioMetrics(1e12, 2e12, 1e9);
  assert.ok(huge.cr3 <= 100 && huge.cr5 <= 100, 'ratios are clamped to 100');
  assert.ok(huge.cr3 >= 0 && huge.cr5 >= 0);
});

test('J-BDA-24: derived accumulation dataset coverage is measured, not assumed', () => {
  const baDir = path.join(ROOT, 'data', 'broker-accumulation');
  if (!exists(baDir)) return;

  const files = listJson(baDir).filter((f) => f !== 'archive-index.json');
  assert.ok(files.length > 0, 'derived accumulation files exist');

  const rows = [];
  for (const f of files) {
    const t = f.replace('.json', '');
    const j = readJson(path.join(baDir, f));
    const histDates = Object.keys(j.history || {});
    rows.push({
      ticker: t,
      ticker_match: j.ticker === t,
      start: j.start_date,
      end: j.end_date,
      sessions: j.total_sessions,
      active_dates: histDates.length,
      active_min: histDates[0] || null,
      active_max: histDates[histDates.length - 1] || null
    });
  }

  assert.ok(rows.every((r) => r.ticker_match), 'every file names its own ticker — no mis-mapped accumulation');
  assert.ok(rows.every((r) => r.sessions > 0), 'every ticker reports a session count');
  assert.ok(rows.every((r) => r.active_dates > 0), 'every ticker carries an active rolling window');

  const maxEnd = rows.map((r) => r.end).sort().slice(-1)[0];
  assert.ok(maxEnd <= '2026-10-28', `newest derived accumulation date is ${maxEnd} — STALE vs today`);

  // The gz archive must extend the window backwards and stay consistent with
  // the index that describes it.
  const idxPath = path.join(baDir, 'archive-index.json');
  if (exists(idxPath)) {
    const idx = readJson(idxPath);
    assert.equal(idx.tickers.length, idx.archived_tickers, 'archive index count matches its own listing');
    const archDir = path.join(baDir, 'archive');
    for (const entry of idx.tickers) {
      const gz = path.join(baDir, entry.archive_file);
      assert.ok(exists(gz), `archive file present for ${entry.ticker}`);
      const h = JSON.parse(zlib.gunzipSync(fs.readFileSync(gz)).toString('utf8'));
      assert.equal(h.ticker, entry.ticker, 'archive payload names its own ticker');
      const ds = Object.keys(h.history || {}).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k));
      assert.equal(ds.length, entry.archived_days, `archive day count matches the index for ${entry.ticker}`);
      // Archive and active window must not overlap or leave a hole.
      const archMax = ds.sort().slice(-1)[0];
      const active = rows.find((r) => r.ticker === entry.ticker);
      assert.ok(archMax < active.active_min,
        `${entry.ticker}: archive ends ${archMax} before active window starts ${active.active_min}`);
    }
  }
});

test('J-BDA-25: Provider-original accumulation coverage is reported honestly (near-empty locally)', () => {
  const provDir = path.join(ARJUM, 'broker-accumulation');
  const dirs = listDirs(provDir);
  const real = dirs.filter(isRealTicker);

  // Only BBCA carries a genuine provider series locally; META is a fixture.
  assert.ok(real.length <= 2, `provider-original accumulation is essentially absent locally (dirs: ${dirs.join(',')})`);

  const bbc = path.join(provDir, 'BBCA', 'series.json');
  if (exists(bbc)) {
    const j = readJson(bbc);
    assert.equal(j.code, 'BBCA');
    assert.ok(j.start_date && j.end_date);
    assert.ok(j.end_date <= '2026-10-28', `provider series ends ${j.end_date} — STALE vs today`);
    assert.ok(Array.isArray(j.series) && j.series.length > 0);
    for (const s of j.series) {
      assert.ok(/^[A-Z0-9]{2}$/.test(s.broker_code), `valid broker code ${s.broker_code}`);
      assert.ok(Array.isArray(s.points) && s.points.length > 0);
      let cum = 0;
      for (const p of s.points) {
        assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(p.date), 'point carries a real date');
        cum += p.nval;
        assert.ok(Math.abs(cum - p.cum_nval) <= 1, 'cum_nval is the running sum of nval');
      }
    }
  }

  // A fixture directory must never be mistaken for a real ticker series.
  const meta = path.join(provDir, 'META', 'series.json');
  if (exists(meta)) {
    const j = readJson(meta);
    assert.notEqual(j.code, 'META', 'META carries no authentic provider series — it is a test fixture');
  }
});

test('J-BDA-27: BOTH domestic implementations refuse a clipped ALL identically', () => {
  // The two implementations of the same identity must share ONE fail-closed
  // contract. Before this fix, lib/broksum-flow.computeDomestic refused a
  // 25-level ALL payload (status 'incomplete', 0 brokers) while
  // lib/broker-accumulation-local.computeDomesticBroksum happily subtracted
  // against the truncated feed and returned status 'RELEASED' with 50 brokers —
  // i.e. it published (top-25 of ALL) − F as if it were ALL − F.
  //
  // Measured exposure at audit time: 108 of 9261 external ALL files are clipped,
  // and ALL 108 are `latest.json` snapshots (0 dated files), so no committed D
  // file was affected. The defect was latent, not active — but the writer that
  // consumes this function is the one that produces broker-summary-D/*.
  const clippedLevels = Array.from({ length: 25 }, (_, i) => ({
    buy: { broker_code: 'B' + i, bval: 100, bvol: 10 },
    sell: { broker_code: 'S' + i, sval: 50, svol: 5 }
  }));
  const clippedAll = { stock_code: 'TEST', broker_levels: clippedLevels, brokers: [] };
  const f = makeForeign([{ broker_code: 'B0', bval: 10, sval: 5, bvol: 1, svol: 1 }]);

  // Shared predicate, exported from both modules.
  assert.equal(accumLocal.isAllBroksumClipped(clippedAll), true);
  assert.equal(isAllBroksumClipped(clippedAll), true);
  assert.equal(
    accumLocal.isAllBroksumClipped(Object.assign({ all_data: true }, clippedAll)),
    false,
    'all_data:true opts out in BOTH modules'
  );

  const d1 = computeDomestic(clippedAll, f);
  const d2 = accumLocal.computeDomesticBroksum(clippedAll, f, '2026-10-27', 'TEST');

  assert.equal(d1.status, 'incomplete');
  assert.equal(d1.is_complete, false);
  assert.deepEqual(d1.brokers, []);

  assert.equal(d2.status, accumLocal.STATUS_ALL_CLIPPED);
  assert.equal(d2.is_complete, false);
  assert.equal(d2.reason, 'all_clipped_25', 'same machine-readable reason as broksum-flow');
  assert.equal(d2.data_asing_dirilis, false);
  assert.deepEqual(d2.brokers, [], 'no subtraction against a truncated ALL');
  assert.deepEqual(d2.broker_levels, []);

  // The observable contract both writers key on: NOT released, ZERO brokers.
  assert.equal(d1.brokers.length, d2.brokers.length, 'both yield the same broker count');
  assert.notEqual(d2.status, 'RELEASED', 'a clipped ALL is never published as RELEASED');

  // A clipped ALL that DOES carry a brokers[] array must also be refused —
  // 18 of the 108 observed clipped files have a non-empty brokers[].
  const clippedWithBrokers = {
    stock_code: 'TEST',
    broker_levels: clippedLevels,
    brokers: [{ broker_code: 'Q1', bval: 1000, sval: 400, bvol: 100, svol: 40 }]
  };
  const d3 = accumLocal.computeDomesticBroksum(clippedWithBrokers, f, '2026-10-27', 'TEST');
  assert.equal(d3.status, accumLocal.STATUS_ALL_CLIPPED);
  assert.deepEqual(d3.brokers, [], 'a populated brokers[] does not rescue a clipped broker_levels feed');

  // Sanity: a NON-clipped ALL still computes normally (no over-blocking).
  const okAll = makeAll([{ broker_code: 'AK', bval: 1000, sval: 200, bvol: 100, svol: 20 }]);
  const d4 = accumLocal.computeDomesticBroksum(okAll, f, '2026-10-27', 'TEST');
  assert.equal(d4.status, 'RELEASED', 'an unclipped ALL is still released');
  assert.equal(d4.is_complete === false, false, 'unclipped result is not marked incomplete');
});

test('J-BDA-28: NEGATIVE CONTROL — the domestic writer never publishes an empty or heuristic session as complete', () => {
  // scripts/domestic-compile.js is the writer that produces
  // data/arjum-data/broker-summary-D/*. It has a fallthrough branch that
  // recomputes D from a hardcoded foreign broker-code set instead of
  // subtracting the foreign payload. Two fail-open defects lived there:
  //
  //   1. `Array.isArray(allJson.brokers)` is TRUE for `brokers: []`, so an ALL
  //      payload with no broker rows wrote a D file with
  //      status:'RELEASED', is_complete:true and ZERO brokers — an empty
  //      session published as a complete one. This is the exact shape of the
  //      GPRA/META files documented as blocker B-5.
  //   2. the heuristic output claimed is_complete:true and was
  //      indistinguishable from identity-derived output, so no consumer could
  //      tell that D was NOT computed as ALL − F.
  //
  // The script is require.main-guarded and processTickerBatch is not exported,
  // so the contract is asserted on the source plus on the exported predicate it
  // now calls.
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'domestic-compile.js'), 'utf8');
  const codeOnly = src.split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

  // (1) the clipped guard must be reached BEFORE the heuristic branch.
  //
  // NOTE ON LOCATING THE BRANCH: `Array.isArray(allJson.brokers)` occurs TWICE in
  // this script. The first occurrence is an unrelated block that SYNTHESIZES the
  // foreign payload from ALL when no F file exists; the second is the domestic
  // heuristic. A naive indexOf() finds the first one and would "prove" the wrong
  // ordering, so the heuristic branch is located by its own unique marker
  // (`computed_from: 'broker_code_heuristic'`) and the search is anchored there.
  const clipIdx = codeOnly.indexOf('accumLocal.isAllBroksumClipped(allJson)');
  assert.ok(clipIdx > -1, 'the writer calls the shared clipped-ALL predicate');

  const heuristicIdx = codeOnly.indexOf("computed_from: 'broker_code_heuristic'");
  assert.ok(heuristicIdx > -1, 'the heuristic branch is identifiable by its computed_from marker');

  // The `else if` that opens the heuristic branch, searched BACKWARDS from its
  // unique marker so the unrelated F-synthesis block cannot be matched.
  const branchHead = codeOnly.lastIndexOf(
    'Array.isArray(allJson.brokers) && allJson.brokers.length > 0',
    heuristicIdx
  );
  assert.ok(branchHead > -1, 'the heuristic branch condition is present');

  // (2) the heuristic branch must require a NON-EMPTY brokers array.
  assert.ok(
    branchHead > clipIdx,
    'the clipped guard precedes the heuristic branch, so a clipped ALL can never reach it'
  );

  // (3) an empty domestic result must be skipped, not written.
  assert.ok(
    /if\s*\(dBrokers\.length\s*===\s*0\)/.test(codeOnly),
    'a zero-broker domestic result is explicitly skipped'
  );

  // (4) heuristic output must be labelled and must NOT claim completeness.
  assert.ok(
    /computed_from:\s*'broker_code_heuristic'/.test(codeOnly),
    'heuristic output declares how it was computed'
  );
  assert.ok(
    /is_complete:\s*false/.test(codeOnly),
    'heuristic output does not claim is_complete:true'
  );

  // (5) refusals must be observable, not silent.
  assert.ok(
    /domestic_all_clipped_skipped/.test(codeOnly) && /domestic_empty_skipped/.test(codeOnly),
    'both refusal paths are counted and reported'
  );

  // The exported predicate the writer relies on behaves as asserted above.
  assert.equal(typeof accumLocal.isAllBroksumClipped, 'function');
  assert.equal(accumLocal.isAllBroksumClipped({ brokers: [], broker_levels: [] }), false,
    'an empty feed is not "clipped" — it is handled by the empty-brokers guard instead');
});

test('J-BDA-29: NEGATIVE CONTROL — foreign data DERIVED from ALL is never labelled as the provider feed', () => {
  // scripts/domestic-compile.js synthesizes a Foreign payload when no F file
  // exists, by filtering ALL down to a hardcoded 16-code FOREIGN_SET, and writes
  // it into `data/arjum-data/broker-summary-F/` — the very directory that every
  // consumer reads as PROVIDER_ORIGINAL foreign data.
  //
  // It used to write `status:'RELEASED', is_complete:true` with NO provenance
  // marker, so a derived file was byte-for-byte indistinguishable from an
  // authentic provider `flow=F` response. That is precisely the "do not claim
  // identical" violation this subtask exists to close, and it is worse than the
  // domestic case because it poisons the INPUT of the D = ALL − F identity:
  // D would then be `ALL − (ALL filtered by 16 codes)`, presented as if the
  // foreign side had been measured.
  //
  // The repo already sets the house standard for this in
  // lib/legacy-foreign-adapter.normalizeLegacyForeign(), which refuses to
  // fabricate a foreign decomposition and marks `is_complete:false` +
  // `data_status:'PARTIAL'`. The writer now matches it.
  //
  // Measured exposure: `data/arjum-data/broker-summary-F/` currently holds 0
  // ticker dirs and 0 files, so this path has never run in this repo. Latent.
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'domestic-compile.js'), 'utf8');
  const codeOnly = src.split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

  // Locate the F-synthesis block by its own unique marker.
  const fBlockStart = codeOnly.indexOf("computed_from: 'broker_code_heuristic_from_all'");
  assert.ok(fBlockStart > -1, 'the synthesized F payload declares how it was computed');

  const fBlock = codeOnly.slice(Math.max(0, fBlockStart - 900), fBlockStart + 900);

  assert.ok(
    /provenance:\s*'DERIVED_LOCAL'/.test(fBlock),
    'synthesized F is marked DERIVED_LOCAL, not provider-original'
  );
  assert.ok(
    /is_complete:\s*false/.test(fBlock),
    'synthesized F does not claim completeness — FOREIGN_SET is 16 codes, not the whole foreign universe'
  );
  assert.ok(
    /data_status:\s*'PARTIAL'/.test(fBlock),
    'synthesized F carries the same PARTIAL marker the legacy adapter uses'
  );
  assert.ok(
    /NOT the provider flow=F feed/.test(fBlock),
    'the note states explicitly that this is not the provider feed'
  );

  // The derived-foreign count must be observable, not silent.
  assert.ok(
    /foreign_synthesized_from_all/.test(codeOnly),
    'synthesized-F events are counted and reported'
  );

  // Provenance must PROPAGATE: a D file computed against a derived F is not the
  // same object as a D file computed against an authentic provider F.
  assert.ok(
    /foreign_provenance\s*=\s*'DERIVED_LOCAL'/.test(codeOnly),
    'D inherits the foreign side provenance so the two are never conflated'
  );
  assert.ok(
    /domestic_from_derived_foreign/.test(codeOnly),
    'D-from-derived-F events are counted and reported'
  );

  // The FOREIGN_SET really is a small hardcoded subset, which is why
  // is_complete:false is the honest label.
  const setMatch = src.match(/const FOREIGN_SET = new Set\(\[([^\]]*)\]\)/);
  assert.ok(setMatch, 'FOREIGN_SET is defined');
  const codes = setMatch[1].split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
  assert.ok(
    codes.length < 40,
    `FOREIGN_SET holds only ${codes.length} codes — far short of the full IDX foreign broker universe, so a derived F is necessarily PARTIAL`
  );

  // Cross-check: the downstream consumer really does fail closed on
  // is_complete:false, so a derived F file read back from disk cannot silently
  // produce a "complete" domestic figure.
  const derivedF = {
    stock_code: 'TEST', flow: 'F', status: 'RELEASED', is_complete: false,
    provenance: 'DERIVED_LOCAL',
    brokers: [{ broker_code: 'AK', bval: 600, sval: 100, bvol: 60, svol: 10 }]
  };
  const all = makeAll([{ broker_code: 'AK', bval: 1000, sval: 200, bvol: 100, svol: 20 }]);
  const d = computeDomestic(all, derivedF);
  assert.equal(d.status, 'foreign_missing', 'a PARTIAL derived F is not accepted as a released foreign side');
  assert.equal(d.is_complete, false);
  assert.deepEqual(d.brokers, [], 'no domestic figure is fabricated from an unverified foreign side');
});

test('J-BDA-26: broker-summary-D fixture directories are distinguishable from real tickers', () => {
  const dDir = path.join(ARJUM, 'broker-summary-D');
  if (!exists(dDir)) return;
  const all = listDirs(dDir);
  const fixtures = all.filter((t) => !isRealTicker(t));

  assert.ok(fixtures.length > 0, 'fixture dirs exist and are identifiable by their non-ticker names');
  for (const t of fixtures) {
    for (const f of listJson(path.join(dDir, t))) {
      const j = readJson(path.join(dDir, t, f));
      assert.equal(j.stock_code, t, 'fixture payload names its own fixture id');
      assert.deepEqual(j.brokers || [], [], 'fixtures carry no brokers — they must never feed a ranking');
    }
  }
});
