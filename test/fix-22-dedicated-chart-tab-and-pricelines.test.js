'use strict';

/**
 * FIX-22: Dedicated "Chart Workstation" navigation entry + real trading-plan
 * price lines drawn on the candlestick series.
 *
 * Before this fix:
 *  - Chart lived only as a sub-tab under "Analisis & Chart", splitting the
 *    trader workflow between reading AI narrative and dissecting the chart.
 *  - public/market-intelligence.js was never touched (no chart-handoff wiring).
 *  - switchTicker(planLevels) stored the levels but never drew createPriceLine.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('FIX-22: public/index.html exposes a first-class #tabChartWorkstation sidebar entry', () => {
  const html = read('public/index.html');

  assert.match(html, /id="tabChartWorkstation"/, 'sidebar must expose #tabChartWorkstation');
  assert.match(html, /Chart Workstation/, 'the entry must be labelled "Chart Workstation"');
  assert.match(
    html,
    /id="tabChartWorkstation"[^>]*data-sidebar-page="chart"|id="tabChartWorkstation"[\s\S]{0,400}data-sidebar-page="chart"/,
    'the chart entry must carry data-sidebar-page="chart"'
  );
  assert.match(
    html,
    /id="tabChartWorkstation"[\s\S]{0,400}data-tab="chart"/,
    'the chart entry must carry data-tab="chart"'
  );

  // The pre-existing analysis entry must remain intact (backward compatible).
  assert.match(html, /id="tabAnalisisChart"/, '#tabAnalisisChart must NOT be removed');
  assert.match(html, /navigateTo\('analisis', 'analisis-chart'\)/, '#tabAnalisisChart behaviour must be preserved');
});

test('FIX-22: both analisis-saham partials expose a Chart Workstation lens and stay byte-identical', () => {
  const a = fs.readFileSync(path.join(ROOT, 'partials/analisis-saham.partial.html'));
  const b = fs.readFileSync(path.join(ROOT, 'public/partials/analisis-saham.partial.html'));
  const text = a.toString('utf8');

  assert.match(text, /Chart Workstation/, 'the analysis partial must expose a Chart Workstation lens/tab');
  assert.match(text, /switchAnalisisSubTab\('chart'\)/, 'the lens must route through switchAnalisisSubTab(\'chart\')');

  const h1 = crypto.createHash('sha1').update(a).digest('hex');
  const h2 = crypto.createHash('sha1').update(b).digest('hex');
  assert.equal(h1, h2, 'both analisis-saham partials must remain 100% byte-identical (FIX-17 contract)');
});

test('FIX-22: chart-workstation exposes a real price-line drawing helper', () => {
  const Workstation = require('../public/chart-workstation.js');

  assert.equal(typeof Workstation.applyPlanPriceLines, 'function', 'applyPlanPriceLines must be exported');
  assert.equal(typeof Workstation.clearPlanPriceLines, 'function', 'clearPlanPriceLines must be exported');

  // Build a minimal fake candlestick series that records createPriceLine / removePriceLine.
  const created = [];
  const removed = [];
  const series = {
    createPriceLine(opts) {
      const line = { options: opts, removed: false };
      created.push(line);
      return line;
    },
    removePriceLine(line) {
      removed.push(line);
    }
  };

  const plan = { entry: 5000, sl: 4800, tp1: 5300, tp2: 5500 };
  const lines = Workstation.applyPlanPriceLines(series, plan);
  assert.ok(Array.isArray(lines), 'applyPlanPriceLines must return the created lines');
  assert.equal(lines.length, 4, 'exactly 4 price lines must be drawn (Entry, SL, TP1, TP2)');

  const titles = created.map((l) => String(l.options.title || '').toLowerCase());
  assert.ok(titles.some((t) => t.indexOf('entry') >= 0), 'an Entry line must be drawn');
  assert.ok(titles.some((t) => t.indexOf('sl') >= 0 || t.indexOf('stop') >= 0), 'an SL line must be drawn');
  assert.ok(titles.some((t) => t.indexOf('tp1') >= 0), 'a TP1 line must be drawn');
  assert.ok(titles.some((t) => t.indexOf('tp2') >= 0), 'a TP2 line must be drawn');

  for (const l of created) {
    assert.ok(Number.isFinite(l.options.price), 'every price line must carry a finite price');
    assert.equal(l.options.axisLabelVisible, true, 'price lines must be visible on the axis');
    assert.equal(typeof l.options.color, 'string', 'price lines must carry a color');
  }

  // Re-applying must clear the previous lines so they never stack on ticker change.
  Workstation.applyPlanPriceLines(series, plan);
  assert.ok(removed.length >= 4, 're-applying must remove the previously drawn lines');
});

test('FIX-22: market-intelligence.js and command-palette.js hand off preset + planLevels to the chart tab', () => {
  const mi = read('public/market-intelligence.js');
  const cp = read('public/command-palette.js');

  for (const [name, src] of [['market-intelligence.js', mi], ['command-palette.js', cp]]) {
    assert.match(src, /AutoCuanChartWorkstation/, `${name} must call the chart workstation`);
    assert.match(src, /switchTicker/, `${name} must call switchTicker`);
    assert.match(src, /planLevels/, `${name} must forward planLevels`);
    assert.match(src, /preset/, `${name} must forward a preset`);
  }

  assert.match(mi, /chart/, 'market-intelligence.js must navigate to the chart tab');
});
