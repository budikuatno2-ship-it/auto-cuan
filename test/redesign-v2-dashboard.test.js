'use strict';

// Redesign v2 Dashboard (canvas Main.dc.html) and the price tape (HANDOFF §4a).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const tape = require('../lib/price-tape');

function store(rows) {
  const historyByTicker = {};
  Object.keys(rows).forEach((t) => { historyByTicker[t] = rows[t]; });
  return { historyByTicker };
}
const bar = (date, close, prev, volume) => ({ trade_date: date, close, previous_close: prev, volume });

test('tape keeps liquid risers of the latest session, largest gain first', () => {
  const s = store({
    AAAA: [bar('2026-10-13', 100, 100, 1), bar('2026-10-14', 110, 100, 1e8)], // +10%, Rp 11 M
    BBBB: [bar('2026-10-13', 100, 100, 1), bar('2026-10-14', 105, 100, 1e8)], // +5%
    CCCC: [bar('2026-10-13', 100, 100, 1), bar('2026-10-14', 120, 100, 1e6)], // +20% but Rp 120 jt: not liquid
    DDDD: [bar('2026-10-10', 100, 100, 1), bar('2026-10-13', 150, 100, 1e9)]  // stale session
  });
  const out = tape.buildTape({ store: s, tickers: Object.keys(s.historyByTicker), rootDir: path.join(__dirname, 'no-such-dir') });
  assert.equal(out.as_of_date, '2026-10-14');
  assert.equal(out.basis, 'close');
  assert.deepEqual(out.items.map((x) => x.ticker), ['AAAA', 'BBBB']);
  assert.equal(out.items[0].change_pct, 10);
  assert.equal(out.ihsg, null, 'no IHSG file means no IHSG item, never a made-up one');
});

test('tape tops up with the most liquid non-risers when fewer than 8 rose', () => {
  const rows = {};
  rows.UP01 = [bar('2026-10-13', 100, 100, 1), bar('2026-10-14', 101, 100, 1e8)];
  for (let i = 0; i < 10; i++) rows['DN' + i] = [bar('2026-10-13', 100, 100, 1), bar('2026-10-14', 99, 100, (i + 1) * 1e8)];
  const s = store(rows);
  const out = tape.buildTape({ store: s, tickers: Object.keys(rows), rootDir: path.join(__dirname, 'no-such-dir') });
  assert.equal(out.items.length, tape.MIN_GREEN);
  assert.equal(out.items[0].ticker, 'UP01');
  assert.equal(out.items[1].ticker, 'DN9', 'then the most liquid of the rest');
});

test('tape endpoint is a sector-hot action (api/ stays at 13 files) and is mounted under the top bar', () => {
  const api = read('api/sector-hot.js');
  assert.match(api, /if \(action === 'tape'\) \{/);
  assert.match(api, /Cache-Control', 'public, max-age=60, s-maxage=60'/);
  const html = read('public/index.html');
  assert.match(html, /<\/header>\n<div class="tape" id="acTape" role="region"[^>]*hidden><\/div>/);
  const js = read('public/ac-tape.js');
  assert.match(js, /\/api\/sector-hot\?action=tape/);
  assert.match(js, /ac-tape-paused/);
  const css = read('public/ac-v2.css');
  assert.match(css, /\.tape\[data-ac-ui="v2"\]:hover \.tape-in, \.tape\[data-ac-ui="v2"\]:focus-within \.tape-in, \.tape\[data-ac-ui="v2"\]\.paused \.tape-in \{ animation-play-state: paused; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\n  \.tape\[data-ac-ui="v2"\] \.tape-in \{ animation: none; \}/);
});

function dashboardModule() {
  const sandbox = { window: {}, document: { getElementById: () => null }, Intl, Date, Number, Math, String, Object, Array, fetch: () => Promise.reject(new Error('offline')) };
  sandbox.window.document = sandbox.document;
  vm.runInNewContext(read('public/dashboard-v2.js'), sandbox);
  return sandbox.window.AutoCuanDashboardV2;
}

test('session cell follows the IDX schedule and respects the holiday calendar', () => {
  const d = dashboardModule();
  const at = (iso) => new Date(iso);
  assert.equal(d.sessionOf(at('2026-10-22T02:30:00Z'), null).name, 'Sesi 1');          // Thu 09:30 WIB
  assert.equal(d.sessionOf(at('2026-10-22T05:30:00Z'), null).name, 'Istirahat');       // Thu 12:30 WIB
  assert.equal(d.sessionOf(at('2026-10-23T05:30:00Z'), null).name, 'Istirahat');       // Fri 12:30 WIB
  assert.equal(d.sessionOf(at('2026-10-22T07:00:00Z'), null).name, 'Sesi 2');          // Thu 14:00 WIB
  assert.equal(d.sessionOf(at('2026-10-24T03:00:00Z'), null).name, 'Bursa tutup');     // Saturday
  assert.equal(d.sessionOf(at('2026-10-22T02:30:00Z'), { date: '2026-10-22', is_trading_day: false }).note, 'Hari libur bursa');
});

test('strongest sector needs real counts and is never invented', () => {
  const d = dashboardModule();
  assert.equal(d.strongestSector(null), '');
  assert.equal(d.strongestSector({ sectorCounts: { Health: { gainers: 0, losers: 5, total: 40 } } }), '');
  assert.equal(d.strongestSector({ sectorCounts: { Health: { gainers: 22, losers: 6, total: 41 }, Energy: { gainers: 27, losers: 35, total: 90 } } }), 'Kesehatan (22 dari 41 naik)');
});

test('Dashboard markup follows the canvas and keeps the loader ids', () => {
  const html = read('public/index.html');
  const start = html.indexOf('<div id="page-dashboard"');
  const page = html.slice(start, html.indexOf('<!-- ===== PAGE: ANALISIS SAHAM', start));
  assert.match(page, /class="page-content ac-page[^"]*" data-ac-ui="v2"/);
  ['dashKickDate', 'dashGreeting', 'ihsgSummaryCard', 'ihsgLast', 'ihsgChange', 'dashBreadthCounts', 'dashMarketGate', 'dashSessionName', 'dashMarketFreshness', 'dashMarketFreshnessNote', 'dashboardMarketBreadthWrap', 'dashboardTop5List', 'dashboardTop5LockNote', 'dashboardMonitorList', 'top5HistoryList', 'top5HistoryTabActive', 'top5HistoryTabTp']
    .forEach((id) => assert.ok(page.includes('id="' + id + '"'), id + ' must stay in the Dashboard'));
  assert.match(page, /Bukan rekomendasi beli atau jual\./);
  assert.doesNotMatch(page, /Data contoh/, 'the canvas sample-data chip is not product UI');
  // IHSG: no invented fallback value anymore.
  assert.doesNotMatch(html, /'7\.500,00'/);
});

// Top 5 rows read the field names the production screeners write into
// raw_payload: Konglo rows carry stock_name, group_code, change_pct and
// volume_ratio_avg20 (api/sector-hot.js results.push), Day Trade rows
// volume_ratio_20d, Fusion picks fusion_rvol (lib/top5-fusion-engine.js).
test('Top 5 columns read the production screener field names', () => {
  const html = read('public/index.html');
  assert.match(html, /var volRatio = dashPick\(r, \['volume_ratio_avg20', 'volume_ratio_20d', 'volume_ratio', 'fusion_rvol',/);
  assert.match(html, /var name = dashPick\(r, \['stock_name', 'company_name',/);
  assert.match(html, /var group = dashPick\(r, \['group_name', 'group_code',/);
  assert.match(html, /var chg = dashPick\(r, \['change_pct',/);
  const api = read('api/sector-hot.js');
  assert.match(api, /group_code: item\.group_code,\n\s+stock_name: item\.stock_name,/);
  assert.match(api, /change_pct: analysis\.change_pct,/);
  assert.match(api, /volume_ratio_avg20: analysis\.volume_ratio_avg20,/);
  assert.match(api, /raw_payload: candidate/, 'the locked Top 5 row keeps the whole candidate');
  assert.match(read('lib/top5-fusion-engine.js'), /fusion_rvol: evaluation\.momentum_pillar/);
});

// The IHSG sparkline is an <svg>: SVGElement has no .hidden property, so
// spark.hidden = false never removed the attribute and the line never showed.
test('IHSG sparkline toggles the hidden attribute, not a .hidden property', () => {
  const js = read('public/dashboard-v2.js');
  assert.match(js, /spark\.removeAttribute\('hidden'\)/);
  assert.match(js, /spark\.setAttribute\('hidden', ''\)/);
  assert.doesNotMatch(js, /spark\.hidden\s*=/);
});
