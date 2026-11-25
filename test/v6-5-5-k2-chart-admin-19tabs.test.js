'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('K2-1: Analisis & Chart places #chart-workstation above #anaPlanSheet and keeps Gemini 4', () => {
  for (const file of ['public/partials/analisis-saham.partial.html', 'public/index.html']) {
    const html = read(file);
    const iChart = html.indexOf('id="chart-workstation"');
    const iPlan = html.indexOf('id="anaPlanSheet"');
    assert.ok(iChart > 0 && iPlan > 0, file + ' has both containers');
    assert.ok(iChart < iPlan, file + ' renders #chart-workstation ABOVE #anaPlanSheet');
  }
  const standalone = read('public/analisis-saham.html');
  assert.ok(standalone.indexOf('id="panel-tab-chart"') < standalone.indexOf('id="panel-tab-analisis"'));
  assert.match(standalone, /Gemini 4/);
  assert.doesNotMatch(standalone, /Gemini 2\.5/i);
});

test('K2-2: 5 Chart Modes pack sub-panes for 1440x900, Pro activates 1-3 top patterns without zigzag', () => {
  const ws = require(path.join(ROOT, 'public', 'chart-workstation.js'));
  assert.equal(ws.CLEAN_CHART.MODE_LAYOUT.simpel.subpanes.volume, 90);
  assert.equal(ws.CLEAN_CHART.MODE_LAYOUT.scalping.subpanes.rsi14, 110);
  assert.ok(ws.CLEAN_CHART.MODE_LAYOUT.investor.priceDesktop >= 360);
  assert.ok(ws.CLEAN_CHART.MODE_LAYOUT.investor.priceMobile >= 360);
  const invTotal = ws.CLEAN_CHART.MODE_LAYOUT.investor.priceDesktop +
    ws.CLEAN_CHART.MODE_LAYOUT.investor.subpanes.volume +
    ws.CLEAN_CHART.MODE_LAYOUT.investor.subpanes.foreign_flow +
    ws.CLEAN_CHART.MODE_LAYOUT.investor.subpanes.obv;
  assert.ok(invTotal <= 580, 'Investor main + 3 sub-panes fit inside 1440x900 (' + invTotal + 'px)');

  assert.deepEqual(ws.AUTO_PATTERN_PRESET_DEFAULTS.simpel, []);
  assert.deepEqual(ws.AUTO_PATTERN_PRESET_DEFAULTS.swing, []);
  assert.deepEqual(ws.AUTO_PATTERN_PRESET_DEFAULTS.investor, []);
  assert.ok(ws.AUTO_PATTERN_PRESET_DEFAULTS.pro.length >= 1 && ws.AUTO_PATTERN_PRESET_DEFAULTS.pro.length <= 3);
  assert.ok(!ws.AUTO_PATTERN_PRESET_DEFAULTS.pro.includes('zigzag'));
  assert.ok(!ws.AUTO_PATTERN_PRESET_DEFAULTS.pro.includes('harmonic'));
  assert.ok(!ws.AUTO_PATTERN_PRESET_DEFAULTS.pro.includes('elliott'));
});

test('K2-3: Separate Volume sub-pane, compact Jt/M/T Y-axes, and shared right-axis collision guard', () => {
  const mfr = read('public/market-feature-runtime.js');
  assert.match(mfr, /_vol_container/);
  assert.match(mfr, /function acFormatAxisCompact\(/);
  assert.match(mfr, /window\.AutoCuanRightAxisGuard\s*=/);
  assert.match(mfr, /volumeSeries\.update\(/);
  assert.match(mfr, /priceFormat:\s*\{\s*type:\s*'custom',\s*formatter:\s*acFormatAxisCompact\s*\}/);

  const wsSrc = read('public/chart-workstation.js');
  assert.match(wsSrc, /reg\.volChart/);
  assert.match(wsSrc, /reg\.macdChart/);
  assert.match(wsSrc, /reg\.obvChart/);
  assert.match(wsSrc, /AutoCuanRightAxisGuard/);

  const v2 = read('public/analisis-v2.js');
  assert.match(v2, /AutoCuanRightAxisGuard/);
  assert.match(v2, /_rowsCache/);
});

test('K2-4: Mobile 390x844 toolbar wrap CSS keeps 7 drawing tools & 5 modes unclipped', () => {
  const css = read('public/ac-v2.css');
  assert.match(css, /\.ac-draw-toolbar\s*\{[^}]*flex-wrap:\s*nowrap/);
  assert.match(css, /@media \(max-width:\s*640px\)\s*\{[\s\S]{0,250}\.ac-draw-toolbar[\s\S]{0,180}flex-wrap:\s*wrap !important/);
  assert.match(css, /@media \(max-width:\s*430px\)\s*\{[\s\S]{0,400}\.cw-seg[\s\S]{0,120}flex-wrap:\s*wrap/);
});

test('K2-5: Anti-Lockout 3x retry + wake grace and EOD header without Belum pasti', () => {
  const html = read('public/index.html');
  assert.match(html, /var maxAttempts = .*3/);
  assert.match(html, /var retryDelayMs = 1500/);
  assert.match(html, /visibilitychange/);
  assert.match(html, /if \(status === 'eod' && canonicalEodAt\)/);
  assert.doesNotMatch(html, /var label = 'Belum pasti'/);
  assert.doesNotMatch(html, /<h3>Swing Konglomerat<\/h3>/);
  assert.doesNotMatch(html, /<h3>Swing Non-Konglomerat<\/h3>/);
  assert.match(html, /<h3>Potensi Besok \(1–5H\)<\/h3>/);
  assert.match(html, /<div class="metric-row">\s*<span>Konsentrasi Pengendali \(HSC\)<\/span>\s*<strong>&mdash;<\/strong>\s*<\/div>/);
});

test('K2-6: Zero demo 10.250/Mrd regressions, legacy-gmail 503 guard, and ?v=v6.5.5-k2 cache busting', () => {
  const dev = read('tools/local-dev-server.js');
  assert.doesNotMatch(dev, /currentPrice:\s*10250/);
  assert.doesNotMatch(dev, /'Swing Konglomerat'/);
  assert.doesNotMatch(read('lib/market-intelligence-engine.js'), /\bMrd\b/);
  assert.match(read('public/legacy-gmail-runtime.js'), /google_link_state==='unavailable'/);
  assert.match(read('public/index.html'), /\/chart-workstation\.js\?v=v6\.5\.5-k2/);
  assert.match(read('public/index.html'), /<script src="\/admin-console-runtime\.js"><\/script>/);
  assert.match(read('public/analisis-saham.html'), /\/market-feature-runtime\.js\?v=v6\.5\.5-k2/);
});

test('K2-7: Pattern Radar uses RAM Buffer cache and Riwayat Top 5 guards stale dates + AMBIGUOUS_SAME_BAR', () => {
  const pr = read('api/pattern-radar.js');
  assert.match(pr, /getCachedPatternsBuffer/);
  assert.doesNotMatch(pr, /pattern-radar-cache\.json/);

  const sh = read('api/sector-hot.js');
  assert.match(sh, /isStaleBeforePick/);
  assert.match(sh, /stock_daily_history/);
  assert.match(sh, /AMBIGUOUS_SAME_BAR/);
  assert.match(sh, /mSrc === 'three_horizon_top5'/);
});
