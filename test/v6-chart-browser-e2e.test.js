'use strict';

/**
 * V6 Subtask G/I — Real browser chart E2E (honest PASS / FAIL / BLOCKED).
 *
 * Two layers of evidence, neither of which can be satisfied by a known-enum
 * check alone:
 *
 *   1. LIVE browser run (tools/v6-chart-browser-harness.js) over the regression
 *      tickers: every individual row must be a real render outcome. A single
 *      FAIL / BLOCKED / NOT_TESTED row fails the test.
 *   2. The committed all-universe artifact
 *      (docs/v6/V6_ALL_IDX_CHART_BROWSER_MATRIX.csv, produced by
 *      tools/v6-all-ticker-browser-audit.js): must cover the WHOLE local
 *      universe, carry data_as_of + stale_flag per ticker, and contain zero
 *      FAIL / BLOCKED_BROWSER / NOT_TESTED rows. No fake "963/963".
 *
 * When Chromium/Puppeteer is unavailable the live subtests are skipped with an
 * explicit "BLOCKED: ..." reason and a dedicated subtest asserts the harness
 * honestly reported BLOCKED (never PASS).
 *
 * Also covers the Subtask I BMRI regression: a screener plan whose entry
 * deviates > 25% from the identity-verified market price must be rejected as
 * STALE_PLAN_REJECTED at the DISPLAY layer, so no profit calculator is shown
 * and no stale price lines are painted on the chart.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const harness = require('../tools/v6-chart-browser-harness');
const allTicker = require('../tools/v6-all-ticker-browser-audit');

const TARGET_TICKERS = ['BBCA', 'BBRI', 'BMRI', 'PANI', 'BRMS', 'BUMI', 'DEWA', 'LPIN', 'ASGR', 'LPPF', 'GPRA'];
// Statuses proving the chart really rendered (EXPECTED_NO_DATA = dormant issuer,
// honestly reported, never counted as a render PASS).
const ACCEPTED_RENDER_STATUS = new Set(['BROWSER_RENDER_PASS', 'EXPECTED_NO_DATA']);
const FORBIDDEN_STATUS = ['FAIL', 'BLOCKED', 'BLOCKED_BROWSER', 'NOT_TESTED'];

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
}

function waitForServer(baseUrl, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function check() {
      const req = http.get(baseUrl + '/preview/analisis-saham', (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) reject(new Error('server start timeout'));
        else setTimeout(check, 300);
      });
    })();
  });
}

/** Minimal CSV line splitter (the writers quote every field). */
function splitCsv(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** Load public/analisis-v2.js in a sandbox with a controllable chart bus. */
function loadAnalisisV2(busEntries) {
  const code = fs.readFileSync(path.join(ROOT, 'public', 'analisis-v2.js'), 'utf8');
  const noop = () => {};
  const sandbox = {
    document: { readyState: 'complete', addEventListener: noop, getElementById: () => null },
    Intl, Math, Number, String, Object, Array, Date, Promise, isFinite,
    fetch: () => Promise.resolve({ status: 200, json: () => Promise.resolve({ success: true, results: [] }) })
  };
  sandbox.window = sandbox;
  sandbox.normalizeDisplayLevels = (row) => ({
    e1: row.entry1 || row.entry_high,
    e2: row.entry2 || row.entry_low,
    sl: row.stop_loss || row.sl,
    t1: row.tp1,
    t2: row.tp2
  });
  // Identity-checked snapshot bus stub: candles only for the exact ticker.
  sandbox.AutoCuanChartBus = {
    get(ticker, category) {
      if (category !== 'CHART') return null;
      return (busEntries && busEntries[String(ticker).toUpperCase()]) || null;
    }
  };
  vm.runInNewContext(code, sandbox);
  return sandbox.AutoCuanAnalisisV2;
}

let child = null;
let sharedBaseUrl = null;

async function ensureServer() {
  if (sharedBaseUrl) return sharedBaseUrl;
  let baseUrl = process.env.AUTO_CUAN_BASE_URL;
  if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
    const port = await freePort();
    baseUrl = 'http://127.0.0.1:' + port;
    child = spawn(process.execPath, ['tools/local-dev-server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port) },
      stdio: 'ignore'
    });
    await waitForServer(baseUrl, 20000);
  }
  sharedBaseUrl = baseUrl;
  return baseUrl;
}

test.after(async () => {
  if (child) { try { child.kill(); } catch (_) {} child = null; }
});

/* ------------------------------------------------------------------ */
/* 1. Availability honesty                                             */
/* ------------------------------------------------------------------ */

test('V6 chart browser harness: availability is reported honestly', () => {
  const avail = harness.browserAvailability();
  assert.equal(typeof avail.available, 'boolean');
  if (!avail.available) {
    assert.ok(avail.reason && avail.reason.length > 0, 'BLOCKED must carry a reason');
  } else {
    assert.ok(avail.puppeteer, 'puppeteer lib present when available');
    assert.ok(avail.executablePath, 'executable path present when available');
  }
});

test('V6 chart browser harness: BLOCKED (no fake PASS) when browser is truly unavailable', async () => {
  const avail = harness.browserAvailability();
  if (!avail.available) {
    const summary = await harness.runBrowserAudit({ tickers: ['BBCA'], baseUrl: 'http://127.0.0.1:1' });
    assert.equal(summary.status, 'BLOCKED');
    assert.equal(summary.BROWSER_RENDER_PASS, 0);
    assert.ok(summary.rows.every(r => r.status === 'BLOCKED'), 'all rows BLOCKED, none PASS');
  } else {
    // Browser present but the server is unreachable: must NOT invent a PASS.
    const summary = await harness.runBrowserAudit({ tickers: ['BBCA'], baseUrl: 'http://127.0.0.1:1' });
    assert.equal(summary.BROWSER_RENDER_PASS, 0, 'unreachable server must not produce a render PASS');
  }
});

/* ------------------------------------------------------------------ */
/* 2. LIVE browser E2E on the regression tickers — STRICT              */
/* ------------------------------------------------------------------ */

test('V6 chart browser E2E: every ticker really rendered (FAIL/BLOCKED/NOT_TESTED fails the test)', async (t) => {
  const avail = harness.browserAvailability();
  if (!avail.available) {
    t.skip('BLOCKED: ' + (avail.reason || 'Chromium/Puppeteer TIDAK tersedia di environment'));
    return;
  }
  const baseUrl = await ensureServer();

  const summary = await harness.runBrowserAudit({
    tickers: TARGET_TICKERS,
    baseUrl,
    screenshotDir: path.join(ROOT, 'docs', 'v6', 'V6_BROWSER_SCREENSHOTS')
  });

  assert.equal(summary.rows.length, TARGET_TICKERS.length, 'one row per ticker');

  // STRICT: a recognised enum is NOT enough — any non-render status fails.
  const bad = summary.rows.filter(r => !ACCEPTED_RENDER_STATUS.has(r.status));
  assert.deepEqual(
    bad.map(r => `${r.ticker}=${r.status}`),
    [],
    'no ticker may end as FAIL / BLOCKED / NOT_TESTED'
  );

  for (const row of summary.rows) {
    // Identity: the rendered chart must belong to the requested ticker, not the
    // previously selected series.
    assert.equal(row.render_match, 'true', `${row.ticker}: registry identity matches input`);
    assert.equal(row.candle_series, 'true', `${row.ticker}: candle series bound`);
    assert.equal(row.main_chart, 'true', `${row.ticker}: main chart bound`);
    assert.equal(row.canvas_visible, 'true', `${row.ticker}: canvas visible`);
    assert.ok(Number(row.canvas_count) >= 1, `${row.ticker}: >=1 visible canvas`);
    // Canvas dims measured from the DOM, never a hardcoded constant.
    assert.match(String(row.first_canvas), /^\d+x\d+ css \d+x\d+$/, `${row.ticker}: canvas dims measured from DOM`);
    // No uncaught page exception and no CHART-PIPELINE error. Secondary-panel
    // errors (AI matrix 404 for an issuer without a computable matrix, the
    // broker-summary/quote bridge to the intentionally-offline local VPS) are
    // recorded honestly in the CSV but are not chart render defects — the same
    // rule the all-universe engine applies.
    assert.equal(Number(row.page_errors), 0, `${row.ticker}: no uncaught page error (${row.page_errors_detail})`);
    assert.equal(Number(row.chart_critical_errors || 0), 0,
      `${row.ticker}: no chart-critical error (${row.chart_critical_detail || row.console_errors_detail})`);
  }

  // BBCA regression: header quote / OHLC populated from the real render.
  const bbca = summary.rows.find(r => r.ticker === 'BBCA');
  assert.ok(bbca, 'BBCA present in browser matrix');
  assert.match(bbca.header_ohlcv || '', /O\s?\d/, 'BBCA OHLC header shows a real open price');
  assert.match(bbca.header_ohlcv || '', /Volume/i, 'BBCA header shows volume');
  assert.ok(/\d/.test(bbca.quote || ''), 'BBCA quote is populated with a number');
});

/* ------------------------------------------------------------------ */
/* 3. All-universe artifact integrity (committed evidence)             */
/* ------------------------------------------------------------------ */

test('V6 all-universe browser matrix: full coverage, honest statuses, zero FAIL/BLOCKED/NOT_TESTED', (t) => {
  const csvPath = allTicker.BROWSER_MATRIX_CSV;
  if (!fs.existsSync(csvPath)) {
    t.skip('artifact not generated yet: ' + csvPath);
    return;
  }
  const lines = fs.readFileSync(csvPath, 'utf8').trim().split(/\r?\n/);
  const header = lines[0].split(',');
  const iTicker = header.indexOf('ticker');
  const iStatus = header.indexOf('status');
  const iMatch = header.indexOf('render_match');
  const iCanvas = header.indexOf('canvas_count');
  const iCanvasAttr = header.indexOf('canvas_attr');
  const iAsOf = header.indexOf('data_as_of');
  const iStale = header.indexOf('stale_flag');
  const iSource = header.indexOf('data_source');
  const iPageErr = header.indexOf('page_errors');
  const iCritErr = header.indexOf('chart_critical_errors');
  assert.ok(iTicker >= 0 && iStatus >= 0 && iAsOf >= 0 && iStale >= 0 && iSource >= 0,
    'matrix carries the honesty columns (data_as_of, stale_flag, data_source)');

  const rows = lines.slice(1).map(splitCsv);
  const universe = allTicker.loadUniverse();

  // Full coverage: no fake "963/963" — the row count must equal the universe.
  assert.equal(rows.length, universe.length,
    `matrix must cover the whole local universe (${universe.length}); got ${rows.length}`);

  const counts = {};
  const offenders = [];
  for (const r of rows) {
    const ticker = r[iTicker];
    const status = r[iStatus];
    counts[status] = (counts[status] || 0) + 1;
    assert.ok(allTicker.VALID_STATUS.includes(status), `${ticker}: known status vocabulary, got "${status}"`);
    if (FORBIDDEN_STATUS.includes(status)) offenders.push(`${ticker}=${status}`);

    if (status === 'BROWSER_RENDER_PASS') {
      assert.equal(r[iMatch], 'true', `${ticker}: PASS requires identity match`);
      assert.ok(Number(r[iCanvas]) >= 1, `${ticker}: PASS requires a visible canvas`);
      assert.match(r[iCanvasAttr] || '', /^\d+x\d+$/, `${ticker}: PASS requires measured canvas dims`);
      assert.equal(Number(r[iPageErr] || 0), 0, `${ticker}: PASS requires no uncaught page error`);
      assert.equal(Number(r[iCritErr] || 0), 0, `${ticker}: PASS requires no chart-critical error`);
    }
    if (r[iSource] === 'LOCAL_REAL') {
      assert.match(r[iAsOf] || '', /^\d{4}-\d{2}-\d{2}$/, `${ticker}: data_as_of recorded`);
      assert.ok((r[iStale] || '').length > 0, `${ticker}: stale_flag recorded (local snapshot is stale)`);
    }
    if (r[iSource] === 'MOCK_DEVSERVER') {
      assert.equal(status, 'EXPECTED_NO_DATA',
        `${ticker}: a ticker without real local candles must never be a render PASS`);
    }
  }

  assert.deepEqual(offenders, [],
    'no ticker may be FAIL / BLOCKED_BROWSER / NOT_TESTED in the committed matrix');

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  assert.equal(total, universe.length, 'status tally equals the universe size');
  assert.ok((counts.BROWSER_RENDER_PASS || 0) > 0, 'at least one real render PASS recorded');
});

/* ------------------------------------------------------------------ */
/* 4. BMRI stale-plan gate regression (Subtask I finding)              */
/* ------------------------------------------------------------------ */

test('V6 BMRI regression: stale screener plan is rejected at the display layer', () => {
  // Real finding: BMRI quote 3.590 while the Swing Non-Konglo screener row still
  // carried entry1 6.700 / entry2 6.800 (deviation 86.6%). The sheet used to
  // render a full profit calculator ("lot @ 6.700 ... TP1 7.100") because the
  // plan was computed BEFORE the chart candles arrived (curClose null => the
  // deviation gate was skipped) and then cached for 10 minutes.
  const BMRI_ROW = { ticker: 'BMRI', entry1: 6700, entry2: 6800, sl: 6550, tp1: 7100, tp2: 7350, __src: 'Swing Non-Konglo' };
  const BMRI_CLOSE = 3590;

  // (a) levelsOf with a verified price rejects the plan.
  const noBus = loadAnalisisV2({});
  const rejected = noBus.levelsOf(BMRI_ROW, BMRI_CLOSE);
  assert.equal(rejected.status, 'STALE_PLAN_REJECTED');
  assert.equal(rejected.code, 'NEEDS_RECALCULATION');
  assert.equal(rejected.actionable, false, 'stale plan must not be actionable');
  assert.ok(rejected.deviationPct > 25, 'deviation recorded and above the 25% gate');
  assert.ok(rejected.reason.includes('86.6%'), 'reason states the real deviation, got: ' + rejected.reason);

  // (b) The fail-open path (no price yet) is explicitly marked unvalidated.
  const unvalidated = noBus.levelsOf(BMRI_ROW, null);
  assert.equal(unvalidated.priceValidated, false, 'plan computed without a price is flagged unvalidated');

  // (c) Fail-closed: without a verified price the plan is NOT actionable.
  const unverifiable = noBus.enforcePlanFreshness(unvalidated, 'BMRI');
  assert.equal(unverifiable.actionable, false, 'no verified price => not actionable');
  assert.equal(unverifiable.status, 'PRICE_UNVERIFIED');

  // (d) Once identity-verified candles exist, the gate re-runs and rejects the
  //     cached unvalidated plan (this is the exact BMRI production path).
  const candles = [];
  for (let i = 0; i < 30; i++) {
    candles.push({ time: '2026-10-' + String(i + 1).padStart(2, '0'), open: 3600, high: 3650, low: 3550, close: 3600, volume: 1000 });
  }
  candles[candles.length - 1] = { time: '2026-11-03', open: 3710, high: 3720, low: 3560, close: BMRI_CLOSE, volume: 215755100 };
  const withBus = loadAnalisisV2({ BMRI: { payload: { candles } } });

  assert.equal(withBus.lastVerifiedClose('BMRI'), BMRI_CLOSE, 'verified close read from the identity-checked bus');
  const enforced = withBus.enforcePlanFreshness(unvalidated, 'BMRI');
  assert.equal(enforced.status, 'STALE_PLAN_REJECTED', 'display-layer gate rejects the cached stale plan');
  assert.equal(enforced.actionable, false);
  assert.ok(enforced.source.includes('STALE DEVIASI'), 'source annotated with the deviation');

  // (e) A genuinely fresh plan is untouched by the gate.
  const freshRow = { ticker: 'BMRI', entry1: 3600, entry2: 3650, sl: 3500, tp1: 3800, tp2: 3950 };
  const fresh = withBus.levelsOf(freshRow, BMRI_CLOSE);
  assert.equal(fresh.status, 'VALID');
  assert.equal(fresh.priceValidated, true);
  assert.equal(withBus.enforcePlanFreshness(fresh, 'BMRI').status, 'VALID', 'fresh plan stays actionable');

  // (f) Source guard: the gate is wired into BOTH the sheet renderer and the
  //     chart price-line painter, and the cache cannot pin an unvalidated plan.
  const src = fs.readFileSync(path.join(ROOT, 'public', 'analisis-v2.js'), 'utf8');
  assert.match(src, /enforcePlanFreshness\(state\.plans\[state\.hz\] \|\| deriveDeterministicPlan\(t, state\.hz\), t\)/,
    'renderStock re-validates the plan against the verified price');
  assert.match(src, /enforcePlanFreshness\(state\.plans\[state\.hz\], state\.ticker\)/,
    'drawPlanLines re-validates before painting price lines');
  assert.match(src, /if \(curClose != null\) cache\[t\] = \{ at: Date\.now\(\), plans: plans \};/,
    'plans computed without a verified price are not cached');
  assert.match(src, /data-plan-gate=/, 'rejection banner carries a machine-readable gate attribute');
});

test('V6 BMRI regression: real browser shows STALE_PLAN_REJECTED, not a profit calculator', async (t) => {
  const avail = harness.browserAvailability();
  if (!avail.available) {
    t.skip('BLOCKED: ' + (avail.reason || 'Chromium/Puppeteer TIDAK tersedia di environment'));
    return;
  }
  const baseUrl = await ensureServer();

  const summary = await harness.runBrowserAudit({
    tickers: ['BMRI'],
    baseUrl,
    screenshotDir: path.join(ROOT, 'docs', 'v6', 'V6_BROWSER_SCREENSHOTS')
  });
  const bmri = summary.rows.find(r => r.ticker === 'BMRI');
  assert.ok(bmri, 'BMRI row present');
  assert.equal(bmri.status, 'BROWSER_RENDER_PASS', 'BMRI chart itself renders: ' + (bmri.reason || ''));
  assert.equal(bmri.render_match, 'true', 'BMRI identity matches');

  const plan = bmri.plan_text || '';
  assert.match(plan, /STALE_PLAN_REJECTED/, 'plan sheet shows the stale rejection banner');
  assert.doesNotMatch(plan, /Total bersih bertahap/, 'no profit calculator rendered for a stale plan');
  assert.doesNotMatch(plan, /lot @ 6\.700/, 'stale entry 6.700 is not presented as actionable');
  assert.match(plan, /86[.,]6%|Deviasi entry/, 'rejection reason carries the real deviation');
});

/* ------------------------------------------------------------------ */
/* 5. Source guards (kept in lockstep with the browser path)           */
/* ------------------------------------------------------------------ */

test('V6 regex guard: BBCA p10/p90 classification is two-sided (honest)', () => {
  const code = fs.readFileSync(path.join(ROOT, 'public', 'analisis-v2.js'), 'utf8');
  assert.match(code, /tp2 < p10/, 'analyzes TP2 < p10 (lower bound)');
  assert.match(code, /tp1 > p90/, 'analyzes TP1 > p90 (upper bound)');
  assert.match(code, /di luar rentang/, 'outputs "di luar rentang" text');
});

test('V6 source guard: timeframe switch no longer references an undefined presetName', () => {
  const code = fs.readFileSync(path.join(ROOT, 'public', 'chart-workstation.js'), 'utf8');
  const i = code.indexOf('function switchTimeframe');
  assert.ok(i > 0, 'switchTimeframe exists');
  const switchBody = code.slice(i, i + 1600);
  assert.doesNotMatch(switchBody, /renderChartOverlay\([^)]*presetName\s*\)/, 'no stale presetName reference in switchTimeframe');
  assert.match(switchBody, /renderChartOverlay\(chartId, inst\.ticker, activeCandles, inst\.state\.activePreset\)/);
});

test('V6 source guard: R/R safety gate cannot be bypassed (PANI WATCHLIST contract)', () => {
  // PANI's plan R/R (1.394 at max entry) is below the 1.50 safety floor, so the
  // workstation must label it STATUS PANTAUAN / not ready — never READY.
  const ws = fs.readFileSync(path.join(ROOT, 'public', 'chart-workstation.js'), 'utf8');
  assert.match(ws, /var isSafeRR = rrRatio >= 1\.5;/, 'R/R safety floor is 1.50');
  assert.match(ws, /STATUS PANTAUAN/, 'unsafe R/R is labelled STATUS PANTAUAN (watchlist)');
  assert.match(ws, /Tidak Siap Eksekusi/, 'unsafe R/R is explicitly not ready for execution');
  assert.doesNotMatch(ws, /forceUnsafeRR\s*=\s*true/, 'no unconditional R/R bypass');
  assert.match(ws, /__allowTestForceUnsafe === true && customPlan\.forceUnsafeRR === true/,
    'R/R bypass requires an explicit namespaced test opt-in');
});

test('V6 engine unit: calculateTradingPlan flags an unsafe R/R as not ready', () => {
  const ws = require('../public/chart-workstation.js');
  const candles = [];
  let price = 3800;
  for (let i = 0; i < 80; i++) {
    const open = price;
    const close = Math.round(price * (1 + ((i % 5) - 2) * 0.004));
    candles.push({
      time: '2026-' + String(1 + Math.floor(i / 28)).padStart(2, '0') + '-' + String((i % 28) + 1).padStart(2, '0'),
      open, high: Math.max(open, close) + 20, low: Math.min(open, close) - 20, close, volume: 1000000
    });
    price = close;
  }
  // A plan whose TP1 reward is only ~1.39x the risk (mirrors the PANI finding).
  const last = candles[candles.length - 1].close;
  const plan = ws.calculateTradingPlan(candles, { entry: last, sl: last - 100, tp1: last + 139, tp2: last + 300 }, 'swing', '1D');
  assert.ok(plan, 'plan computed');
  assert.ok(plan.rrRatio < 1.5, 'R/R below the safety floor, got ' + plan.rrRatio);
  assert.equal(plan.isSafeRR, false, 'unsafe R/R is not safe');
  assert.match(plan.warningMessage, /STATUS PANTAUAN/, 'warning labels it watchlist, not ready');
  assert.doesNotMatch(plan.warningMessage, /memenuhi Risk Gate/, 'must not claim the risk gate passed');
});
