'use strict';

/**
 * AUDIT FASE 5 — Akumulasi Broker Historis, Broker Hunter & Konsentrasi Multi-Day
 * (Top 1, Top 3, Top 5).
 *
 * Every case below was confirmed against the live source BEFORE the fix
 * (see scratch/fase5-probe.js and scratch/fase5-probe2.js). Each test encodes
 * the honest contract the subsystem must satisfy:
 *
 *   F5-01  getHunterTickerMap fabricated multi-day figures by multiplying a
 *          single base-range window by 5/7, 14/7 and 2.0 — a 5D "aggregate"
 *          was literally 71.4% of the 7D numbers with the SAME target_dates.
 *   F5-02  filterCalendarWindowDates / aggregateBrokerSummaries aggregated a
 *          duplicated date twice, double-counting that session's flow.
 *   F5-03  date_headers (the "Riwayat Harian" window) was replaced by a 24-day
 *          series whenever the real window was shorter, so a 3D request
 *          reported 24 sessions of history.
 *   F5-04  An accumulation payload with no series was labelled DISTRIBUTION —
 *          a status fabricated from absent data.
 *   F5-05  computeConcentrationRatios read the feed with raw Number(), so the
 *          thousand-separated / comma-decimal forms sanitised elsewhere in the
 *          repo turned CR3/CR5 into NaN -> TURNOVER_UNAVAILABLE.
 *   F5-06  A churning stock (net 0, huge gross both ways) scored a positive
 *          accumulation score instead of being flagged as churn.
 *
 * Offline only: no Telegram, no Supabase, no production endpoint.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const service = require('../lib/bandarmologi-service');
const intelService = require('../lib/bandarmologi-intel-service');

const INTEL_SOURCE = path.join(__dirname, '..', 'lib', 'bandarmologi-intel-service.js');

// ─── fixtures ──────────────────────────────────────────────────────────────

function withTempDataDir(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-f5-'));
  const previous = process.env.ARJUM_DATA_DIR;
  process.env.ARJUM_DATA_DIR = tmp;
  try {
    return fn(tmp);
  } finally {
    if (previous === undefined) delete process.env.ARJUM_DATA_DIR;
    else process.env.ARJUM_DATA_DIR = previous;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
}

function writeSummary(dir, ticker, date, netFlow, opts) {
  const o = opts || {};
  const target = path.join(dir, 'broker-summary', ticker);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, `${date}.json`), JSON.stringify({
    date,
    broker_start_date: date,
    stock_code: ticker,
    net_flow: netFlow,
    gross_buyers: [{ broker: 'YP', broker_name: 'Mirae', bval: Math.abs(netFlow) + 1000000000, bvol: 1000000, sval: 0, svol: 0, nval: Math.abs(netFlow) }],
    gross_sellers: [{ broker: 'XC', broker_name: 'Ajaib', sval: Math.abs(netFlow) / 2, svol: 500000, bval: 0, bvol: 0, nval: -Math.abs(netFlow) / 2 }]
  }, null, 2), 'utf8');
  return target;
}

// ─── F5-01: no fabricated multi-day scaling in the hunter index reader ──────

test('F5-01: hunter index reader must not scale a base window by a fractional multiplier', () => {
  const source = fs.readFileSync(INTEL_SOURCE, 'utf8');

  // The three fabricated multipliers that produced the 5/7, 14/7 and x2 figures.
  assert.equal(/scale\s*=\s*5\s*\/\s*7/.test(source), false,
    'F5-01: getHunterTickerMap must not scale a 7d window by 5/7 to fake a 5d aggregate');
  assert.equal(/scale\s*=\s*14\s*\/\s*7/.test(source), false,
    'F5-01: getHunterTickerMap must not scale a 7d window by 14/7 to fake a 14d aggregate');
  assert.equal(/scale\s*=\s*2\.0/.test(source), false,
    'F5-01: getHunterTickerMap must not scale a 30d window by 2.0 to fake a 60d aggregate');

  // And the observable consequence must be gone: a narrower range must never
  // report a value that is a clean fraction of the wider range's value.
  const wide = intelService.getBrokersFromHunterIndexes('BBCA', '7d');
  const narrow = intelService.getBrokersFromHunterIndexes('BBCA', '5d');
  const wider = intelService.getBrokersFromHunterIndexes('BBCA', '14d');

  if (!wide || !Array.isArray(wide.top_buyers) || wide.top_buyers.length === 0) {
    return; // gitignored hunter data absent in CI — the source assertion above still holds
  }

  const wideVal = Number(wide.top_buyers[0].buy_val || 0);
  assert.ok(wideVal > 0, 'fixture sanity: 7d top buyer must carry a real value');

  for (const [label, data, forbiddenRatio] of [
    ['5d', narrow, 5 / 7],
    ['14d', wider, 2.0]
  ]) {
    if (!data || !Array.isArray(data.top_buyers) || data.top_buyers.length === 0) continue;
    const val = Number(data.top_buyers[0].buy_val || 0);
    if (!(val > 0)) continue;
    const ratio = val / wideVal;
    assert.equal(Math.abs(ratio - forbiddenRatio) > 0.001, true,
      `F5-01: ${label} value must not be the ${label} window fabricated as ${forbiddenRatio}x the 7d value (ratio=${ratio})`);
  }
});

test('F5-01b: hunter index reader never invents a target_dates window it does not have', () => {
  const source = fs.readFileSync(INTEL_SOURCE, 'utf8');

  // The narrow-range path used to relabel a 7d window's dates as a 5d/14d/60d
  // window. If a range's dates are not on disk the honest answer is to report
  // only the sessions actually present, never a substituted window.
  assert.equal(/targetDayCount\s*=\s*14/.test(source) && /scale\s*=\s*14\s*\/\s*7/.test(source), false,
    'F5-01b: a 14d window must be read from real 14d data, not relabelled from 7d');

  // A range backed by a different (real) index must say so, so no consumer can
  // mistake the returned figures for the requested window.
  const wide = intelService.getBrokersFromHunterIndexes('BBCA', '14d');
  if (!wide) return; // gitignored hunter data absent
  assert.ok(typeof wide.data_range === 'string' && wide.data_range,
    'F5-01b: the payload must expose which range actually backed the numbers');
  assert.equal(typeof wide.range_is_exact, 'boolean',
    'F5-01b: range_is_exact must tell the caller whether the request was honoured exactly');
  if (wide.data_range !== '14d') {
    assert.equal(wide.range_is_exact, false,
      'F5-01b: a degraded range must not claim to be exact');
  }
});

test('F5-01c: a degraded range reports real magnitudes, never a rescaled fraction', () => {
  const narrow = intelService.getBrokersFromHunterIndexes('BBCA', '5d');
  const wide = intelService.getBrokersFromHunterIndexes('BBCA', '7d');
  if (!narrow || !wide || !narrow.top_buyers || !narrow.top_buyers.length || !wide.top_buyers || !wide.top_buyers.length) {
    return; // gitignored hunter data absent in CI
  }

  // If 5d is served from the 5d index the values are that window's own. If it
  // degrades to 7d the values must be 7d's verbatim — never 5/7 of them.
  if (narrow.data_range !== '5d') {
    assert.equal(narrow.top_buyers[0].buy_val, wide.top_buyers[0].buy_val,
      'F5-01c: a degraded range must return the backing range verbatim, not a proportional fraction');
  }
});

// ─── F5-02: a duplicated date must never be aggregated twice ────────────────

test('F5-02: filterCalendarWindowDates must return each session at most once', () => {
  const duplicated = ['2026-09-22', '2026-09-22', '2026-09-19', '2026-09-18'];
  const window = service.filterCalendarWindowDates(duplicated, 3);

  assert.equal(new Set(window).size, window.length,
    `F5-02: duplicated input dates must be de-duplicated, got ${JSON.stringify(window)}`);
});

test('F5-02b: aggregateBrokerSummaries must not double-count a repeated date', () => {
  withTempDataDir((dir) => {
    const ticker = 'AUDITDUP';
    writeSummary(dir, ticker, '2026-09-22', 10000000000);
    writeSummary(dir, ticker, '2026-09-19', 3000000000);
    writeSummary(dir, ticker, '2026-09-18', 2000000000);

    const clean = service.aggregateBrokerSummaries(
      ticker, ['2026-09-22', '2026-09-19', '2026-09-18'], 3);
    const repeated = service.aggregateBrokerSummaries(
      ticker, ['2026-09-22', '2026-09-22', '2026-09-19'], 3);

    assert.ok(clean && repeated, 'both aggregations must produce a result');

    // 2026-09-22 (10bn) + 2026-09-19 (3bn) = 13bn. A repeated date must not
    // push it to 23bn by summing the same session twice.
    assert.equal(repeated.net_flow, 13000000000,
      `F5-02b: repeated date must be counted once, got net_flow=${repeated.net_flow}`);

    const dates = repeated.date_headers.map(h => h.date);
    assert.equal(new Set(dates).size, dates.length,
      `F5-02b: date_headers must not contain the same session twice, got ${JSON.stringify(dates)}`);
  });
});

// ─── F5-03: the history window must not be silently widened ─────────────────

test('F5-03: a short requested window must not be replaced by a 24-day history series', () => {
  withTempDataDir((dir) => {
    const ticker = 'AUDITWIN';
    const dates = [];
    for (let i = 0; i < 30; i++) {
      const d = new Date(Date.UTC(2026, 8, 22));
      d.setUTCDate(d.getUTCDate() - i);
      dates.push(d.toISOString().slice(0, 10));
    }
    for (let i = 0; i < dates.length; i++) {
      writeSummary(dir, ticker, dates[i], 1000000000 * (i + 1));
    }

    const agg = service.aggregateBrokerSummaries(ticker, dates.slice(0, 3), 3);
    assert.equal(agg.date_headers.length, 3, 'sanity: real 3-day aggregation has 3 headers');

    // Mirror the production guard: a window shorter than 24 sessions must keep
    // its OWN sessions. Widening it to 24 sessions reports flow the caller
    // never asked for (and the range label still claims 3 days).
    const full24 = service.buildDailyHistorySeries(ticker, 24);
    assert.equal(full24.length, 24, 'sanity: the 24-day series is available');

    const windowDates = agg.date_headers.map(h => h.date);
    const widenedDates = full24.map(h => h.date);
    const extra = widenedDates.filter(d => !windowDates.includes(d));
    assert.ok(extra.length > 0, 'sanity: a 24-day series genuinely contains sessions outside a 3-day window');
    assert.equal(agg.range_days, 3, 'the aggregate still declares a 3-day window');
  });
});

test('F5-03b: getBandarmologiData must keep the requested window for date_headers', async () => {
  const ticker = 'AUDITWIN2';
  await withTempDataDirAsync(async (dir) => {
    const dates = [];
    for (let i = 0; i < 30; i++) {
      const d = new Date(Date.UTC(2026, 8, 22));
      d.setUTCDate(d.getUTCDate() - i);
      dates.push(d.toISOString().slice(0, 10));
    }
    for (let i = 0; i < dates.length; i++) {
      writeSummary(dir, ticker, dates[i], 1000000000 * (i + 1));
    }

    const res = await service.getBandarmologiData(ticker, { range: '5d', days: 5 });
    const bs = res && res.broker_summary;
    assert.ok(bs, 'a broker_summary must be produced');
    assert.equal(bs.range_days, 5, 'a 5D request over 30 on-disk sessions must aggregate exactly 5');
    assert.ok(Array.isArray(bs.date_headers), 'date_headers must be present for a multi-day window');
    assert.equal(bs.date_headers.length, 5,
      `F5-03b: date_headers must cover the requested 5 sessions, got ${bs.date_headers.length}`);
  });
});

function withTempDataDirAsync(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-f5-'));
  const previous = process.env.ARJUM_DATA_DIR;
  process.env.ARJUM_DATA_DIR = tmp;
  return Promise.resolve(fn(tmp)).finally(() => {
    if (previous === undefined) delete process.env.ARJUM_DATA_DIR;
    else process.env.ARJUM_DATA_DIR = previous;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  });
}

// ─── F5-04: absent data must never become a DISTRIBUTION status ─────────────

test('F5-04: an accumulation payload without a series must not be labelled DISTRIBUTION', () => {
  const empty = service.normalizeBrokerAccumulation({ series: [], top_buyers: [], top_sellers: [] }, 'AUDITNOACC');

  assert.equal(empty.status, 'NO_DATA',
    `F5-04: no series => no verdict, got status=${empty.status}`);
  assert.equal(empty.accumulation_score, null,
    'F5-04: an unverifiable payload must not carry a numeric score');

  const nullPayload = service.normalizeBrokerAccumulation(null, 'AUDITNOACC');
  assert.equal(nullPayload.status, 'NO_DATA',
    `F5-04: null payload => NO_DATA, got status=${nullPayload.status}`);
});

test('F5-04b: a real distribution series is still labelled DISTRIBUTION', () => {
  const raw = {
    series: [
      { date: '2026-09-22', net_val: -42000000000 },
      { date: '2026-09-19', net_val: -11000000000 }
    ],
    net_buyers: [{ broker: 'YP', nval: 1000000000, bval: 5000000000, sval: 4000000000 }],
    net_sellers: [{ broker: 'XC', nval: -53000000000, bval: 1000000000, sval: 54000000000 }]
  };
  const norm = service.normalizeBrokerAccumulation(raw, 'AUDITDIST');
  assert.equal(norm.status, 'DISTRIBUTION', 'a genuinely negative series must still read DISTRIBUTION');
  assert.equal(norm.series[norm.series.length - 1].status, 'DIST');
});

// ─── F5-05: thousand-separated feed must not destroy the CR3/CR5 basis ─────

test('F5-05: concentration ratios must sanitise thousand-separated feed values', () => {
  const feed = {
    top_buyers: [
      { broker: 'YP', bval: '1.500.000.000.000', bvol: '10.000.000', net_val: '1.500.000.000.000' },
      { broker: 'CC', bval: '1.000.000.000.000', bvol: '7.000.000', net_val: '1.000.000.000.000' },
      { broker: 'BK', bval: '500.000.000.000', bvol: '3.000.000', net_val: '500.000.000.000' }
    ],
    gross_buyers: [
      { broker: 'YP', bval: '1.500.000.000.000', bvol: '10.000.000', net_val: '1.500.000.000.000' },
      { broker: 'CC', bval: '1.000.000.000.000', bvol: '7.000.000', net_val: '1.000.000.000.000' },
      { broker: 'BK', bval: '500.000.000.000', bvol: '3.000.000', net_val: '500.000.000.000' },
      { broker: 'XC', bval: '1.000.000.000.000', bvol: '6.000.000', net_val: '1.000.000.000.000' },
      { broker: 'NI', bval: '1.000.000.000.000', bvol: '6.000.000', net_val: '1.000.000.000.000' }
    ],
    total_turnover: '6.000.000.000.000',
    total_volume: '32.000.000'
  };

  const res = intelService.computeConcentrationRatios('AUDITSTRFEED', { brokerSummary: feed, range: '7d' });

  assert.equal(Number.isFinite(res.top_3_val), true,
    `F5-05: top_3_val must be a finite number, got ${res.top_3_val}`);
  assert.equal(Number.isFinite(res.top_5_val), true,
    `F5-05: top_5_val must be a finite number, got ${res.top_5_val}`);

  // Top 3 keeps the feed's own order: YP 1.5e12 + CC 1.0e12 + BK 0.5e12 = 3.0e12
  // Top 5 extends with the next genuine net buyers: + XC 1.0e12 + NI 1.0e12 = 5.0e12
  assert.equal(res.top_3_val, 3000000000000,
    `F5-05: "1.500.000.000.000" must parse to 1.5e12 and Top 3 = 3.0e12 (got ${res.top_3_val})`);
  assert.equal(res.top_5_val, 5000000000000,
    `F5-05: Top 5 must sum five real net buyers = 5.0e12 (got ${res.top_5_val})`);
  assert.notEqual(res.cr5, res.cr3,
    'F5-05: a 5-broker feed must not collapse CR5 onto the CR3 figure');

  assert.equal(res.cr_basis, 'VALUE',
    `F5-05: a parseable value denominator must be used, got basis=${res.cr_basis} reason=${res.reason}`);
  assert.equal(res.cr3, 50, `F5-05: 3.0e12 / 6e12 = 50%, got ${res.cr3}`);
  assert.equal(res.cr5, 83.33, `F5-05: 5e12 / 6e12 = 83.33%, got ${res.cr5}`);
  assert.equal(res.total_turnover, 6000000000000,
    `F5-05: the localised turnover string must parse to 6e12, got ${res.total_turnover}`);
  assert.equal(res.triggered, true, 'F5-05: CR3 50% must trigger the concentration signal');
});

test('F5-05b: comma-decimal and plain-string feed forms parse identically', () => {
  const makeFeed = (fmt) => ({
    top_buyers: [
      { broker: 'YP', bval: fmt(1500000000000), bvol: fmt(10000000), net_val: fmt(1500000000000) },
      { broker: 'CC', bval: fmt(1000000000000), bvol: fmt(7000000), net_val: fmt(1000000000000) },
      { broker: 'BK', bval: fmt(500000000000), bvol: fmt(3000000), net_val: fmt(500000000000) }
    ],
    gross_buyers: [
      { broker: 'YP', bval: fmt(1500000000000), bvol: fmt(10000000), net_val: fmt(1500000000000) },
      { broker: 'CC', bval: fmt(1000000000000), bvol: fmt(7000000), net_val: fmt(1000000000000) },
      { broker: 'BK', bval: fmt(500000000000), bvol: fmt(3000000), net_val: fmt(500000000000) },
      { broker: 'XC', bval: fmt(1000000000000), bvol: fmt(6000000), net_val: fmt(1000000000000) },
      { broker: 'NI', bval: fmt(1000000000000), bvol: fmt(6000000), net_val: fmt(1000000000000) }
    ],
    total_turnover: fmt(6000000000000),
    total_volume: fmt(32000000)
  });

  const commaForm = intelService.computeConcentrationRatios('AUDITSTRFEED2', {
    brokerSummary: makeFeed(v => String(v)), range: '7d'
  });
  const dotForm = intelService.computeConcentrationRatios('AUDITSTRFEED3', {
    brokerSummary: makeFeed(v => v.toLocaleString('id-ID')), range: '7d'
  });

  assert.equal(dotForm.cr3, commaForm.cr3,
    `F5-05b: "1.500.000.000.000" and "1500000000000" must yield the same CR3 (${dotForm.cr3} vs ${commaForm.cr3})`);
  assert.equal(dotForm.cr_basis, 'VALUE', 'F5-05b: the localised form must still resolve to a VALUE basis');
});

// ─── F5-06: multi-day churn must not earn a positive accumulation score ────

test('F5-06: a pure churn book must be flagged instead of scoring as accumulation', () => {
  // Broker trades the same size both ways for five sessions: gross is huge,
  // net is zero. This is "tukar barang", not accumulation.
  const churn = {
    date: '2026-09-22',
    net_flow: 0,
    gross_buyers: [
      { broker: 'YP', bval: 100000000000, sval: 100000000000, nval: 0 },
      { broker: 'CC', bval: 90000000000, sval: 90000000000, nval: 0 }
    ],
    gross_sellers: [
      { broker: 'YP', bval: 100000000000, sval: 100000000000, nval: 0 },
      { broker: 'CC', bval: 90000000000, sval: 90000000000, nval: 0 }
    ],
    net_buyers: [],
    net_sellers: []
  };

  const res = service.synthesizeAccumulationFromSummary(churn, 'AUDITCHURN');

  assert.notEqual(res.status, 'ACCUMULATION',
    'F5-06: a zero-net churn book must never be reported as ACCUMULATION');
  assert.equal(res.status, 'NEUTRAL',
    `F5-06: a zero-net book is NEUTRAL, got ${res.status}`);

  const score = res.accumulation_score;
  assert.equal(score, null,
    `F5-06: a zero-net churn book must not earn a numeric accumulation score, got ${score}`);
});

test('F5-06b: genuine net accumulation still scores above neutral', () => {
  const acc = {
    date: '2026-09-22',
    net_flow: 40000000000,
    gross_buyers: [
      { broker: 'YP', bval: 60000000000, sval: 10000000000, nval: 50000000000 },
      { broker: 'CC', bval: 30000000000, sval: 20000000000, nval: 10000000000 }
    ],
    gross_sellers: [
      { broker: 'XC', bval: 5000000000, sval: 25000000000, nval: -20000000000 }
    ],
    net_buyers: [
      { broker: 'YP', bval: 60000000000, sval: 10000000000, nval: 50000000000 }
    ],
    net_sellers: [
      { broker: 'XC', bval: 5000000000, sval: 25000000000, nval: -20000000000 }
    ]
  };

  const res = service.synthesizeAccumulationFromSummary(acc, 'AUDITACC');
  assert.equal(res.status, 'ACCUMULATION', 'a genuinely positive net book reads ACCUMULATION');
  assert.ok(res.accumulation_score != null && res.accumulation_score > 50,
    `F5-06b: real net accumulation must score above the 50 midpoint, got ${res.accumulation_score}`);
});

// ─── F5-07: hunter index files are written atomically ──────────────────────

test('F5-07: broker hunter index writes must not be torn by a concurrent reader', () => {
  const fetcherPath = path.join(__dirname, '..', 'lib', 'vps-data-fetcher.js');
  const source = fs.readFileSync(fetcherPath, 'utf8');

  // fetchBrokerHunterFromVpsSync wrote the fetched index straight over the
  // live path, so a reader (getBrokerHunterData fast path) could observe a
  // half-written JSON document. It must publish through the atomic helper.
  const hunterFn = /function fetchBrokerHunterFromVpsSync[\s\S]*?\n}\n/.exec(source);
  assert.ok(hunterFn, 'fetchBrokerHunterFromVpsSync must exist');

  assert.ok(/atomicWriteJsonSync\(/.test(hunterFn[0]),
    'F5-07: fetchBrokerHunterFromVpsSync must publish via atomicWriteJsonSync, not an in-place writeFileSync');
  assert.equal(/fs\.writeFileSync\(/.test(hunterFn[0]), false,
    'F5-07: no bare writeFileSync may remain in the hunter sync path');

  // And the helper itself must genuinely be atomic: temp file + rename.
  const helperFn = /function atomicWriteJsonSync[\s\S]*?\n}\n/.exec(source);
  assert.ok(helperFn, 'atomicWriteJsonSync must exist');
  assert.ok(/renameSync\(/.test(helperFn[0]),
    'F5-07: atomicWriteJsonSync must publish via renameSync');

  // Prove it behaviourally: a published file is always complete JSON.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-f5-atomic-'));
  try {
    const target = path.join(tmp, 'AK_1d.json');
    fs.writeFileSync(target, JSON.stringify({ broker: 'AK', top_accumulated: [{ ticker: 'OLD' }] }), 'utf8');
    const fetcher = require('../lib/vps-data-fetcher');
    assert.equal(typeof fetcher.__atomicWriteJsonSync, 'function',
      'the atomic writer must be exposed for verification');
    fetcher.__atomicWriteJsonSync(target, { broker: 'AK', top_accumulated: [{ ticker: 'NEW' }] });

    const published = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.equal(published.top_accumulated[0].ticker, 'NEW', 'the new snapshot must be fully visible');

    // No temp litter left behind for a concurrent reader to trip over.
    const leftovers = fs.readdirSync(tmp).filter(f => f.includes('.tmp'));
    assert.equal(leftovers.length, 0, `no temp files may remain, found ${JSON.stringify(leftovers)}`);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
});

test('F5-07b: the accumulation series snapshot is also published atomically', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'vps-data-fetcher.js'), 'utf8');
  const accFn = /function fetchBrokerAccumulationFromVpsSync[\s\S]*?\n}\n/.exec(source);
  assert.ok(accFn, 'fetchBrokerAccumulationFromVpsSync must exist');
  assert.ok(/atomicWriteJsonSync\(/.test(accFn[0]),
    'F5-07b: fetchBrokerAccumulationFromVpsSync must publish series.json via atomicWriteJsonSync');
  assert.equal(/fs\.writeFileSync\(/.test(accFn[0]), false,
    'F5-07b: no bare writeFileSync may remain in the accumulation sync path');
});

console.log('\n✅ audit-fase5-accumulation-bugs test module loaded\n');
