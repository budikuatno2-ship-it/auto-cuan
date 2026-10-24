'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('Track Record Redesign: HTML Markup and Canvas Structure', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  // Page container
  assert.ok(indexHtml.includes('id="page-trackrecord"'), 'Must have #page-trackrecord');

  // Header & Honest Provenance
  assert.ok(indexHtml.includes('Audit sinyal sistem'), 'Must have kick "Audit sinyal sistem"');
  assert.ok(indexHtml.includes('<h1>Track Record</h1>'), 'Must have <h1>Track Record</h1>');
  assert.ok(indexHtml.includes('id="trProvenanceChip"'), 'Must have #trProvenanceChip');
  assert.ok(!indexHtml.includes('>Data contoh<'), 'Must not display fake sample data chip');

  // Metric Strip
  assert.ok(indexHtml.includes('class="mstrip"'), 'Must have .mstrip grid');
  assert.ok(indexHtml.includes('id="trMetricTotal"'), 'Must have #trMetricTotal');
  assert.ok(indexHtml.includes('id="trMetricDone"'), 'Must have #trMetricDone');
  assert.ok(indexHtml.includes('id="trMetricAct"'), 'Must have #trMetricAct');
  assert.ok(indexHtml.includes('id="trMetricHit"'), 'Must have #trMetricHit');
  assert.ok(indexHtml.includes('id="trMetricSl"'), 'Must have #trMetricSl');
  assert.ok(indexHtml.includes('id="trMetricExp"'), 'Must have #trMetricExp');

  // Composition Bar
  assert.ok(indexHtml.includes('id="trCompositionBar"'), 'Must have #trCompositionBar');
  assert.ok(indexHtml.includes('id="trBarTp2"'), 'Must have #trBarTp2');
  assert.ok(indexHtml.includes('id="trBarTp1"'), 'Must have #trBarTp1');
  assert.ok(indexHtml.includes('id="trBarExp"'), 'Must have #trBarExp');
  assert.ok(indexHtml.includes('id="trBarSl"'), 'Must have #trBarSl');

  // Filter Chips & Canvas Table
  assert.ok(indexHtml.includes('id="trFilterChips"'), 'Must have #trFilterChips');
  assert.ok(indexHtml.includes('data-tr-status="all"'), 'Must have all filter chip');
  assert.ok(indexHtml.includes('data-tr-status="hit"'), 'Must have hit filter chip');
  assert.ok(indexHtml.includes('data-tr-status="sl"'), 'Must have sl filter chip');
  assert.ok(indexHtml.includes('data-tr-status="exp"'), 'Must have exp filter chip');

  assert.ok(indexHtml.includes('id="trCanvasTable"'), 'Must have #trCanvasTable');
  assert.ok(indexHtml.includes('id="trCanvasTableBody"'), 'Must have #trCanvasTableBody');
  assert.ok(indexHtml.includes('id="trShownRowsCount"'), 'Must have #trShownRowsCount');

  // Provenance footer
  assert.ok(indexHtml.includes('Penyebut'), 'Must state denominator rule');
  assert.ok(indexHtml.includes('Aturan'), 'Must state 10 days expiry rule');

  // Collapsible legacy controls
  assert.ok(indexHtml.includes('<details class="adv-tools"'), 'Must fold legacy tools into adv-tools');
  assert.ok(indexHtml.includes('<summary>Alat lanjutan</summary>'), 'Must have Alat lanjutan summary');
});

test('Track Record Redesign: Zero Internal Names Exposed in UI', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const trSection = indexHtml.split('id="page-trackrecord"')[1]?.split('<!-- ===== PAGE: WATCHLIST PRIBADI ===== -->')[0] || '';

  assert.ok(trSection.length > 0, 'Must extract track record section');
  assert.ok(!trSection.includes('Arjum'), 'Must not expose Arjum in track record section');
  assert.ok(!trSection.includes('VPS'), 'Must not expose VPS in track record section');
  assert.ok(!trSection.includes('cron'), 'Must not expose cron in track record section');
  assert.ok(!trSection.includes('telegram_daily_picks'), 'Must not expose table name telegram_daily_picks');
});

test('Track Record Redesign: Runtime Functions & CSS Tokens', () => {
  const runtimeJs = fs.readFileSync(path.join(__dirname, '../public/track-record-runtime.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../public/ac-v2.css'), 'utf8');

  // Runtime functions exported to window
  assert.ok(runtimeJs.includes('window.filterTrStatus = filterTrStatus'), 'Must export filterTrStatus');
  assert.ok(runtimeJs.includes('window.onTrSearchInput = onTrSearchInput'), 'Must export onTrSearchInput');
  assert.ok(runtimeJs.includes('window.toggleTrRowDetail = toggleTrRowDetail'), 'Must export toggleTrRowDetail');
  assert.ok(runtimeJs.includes('formatCanvasDate'), 'Must define formatCanvasDate');

  // CSS tokens
  assert.ok(css.includes('.mstrip'), 'CSS must define .mstrip');
  assert.ok(css.includes('.stp'), 'CSS must define .stp step progression');
  assert.ok(css.includes('.bar'), 'CSS must define .bar composition bar');
  assert.ok(css.includes('.oc.tp1'), 'CSS must define .oc.tp1');
  assert.ok(css.includes('.oc.tp2'), 'CSS must define .oc.tp2');
  assert.ok(css.includes('.oc.sl'), 'CSS must define .oc.sl');
  assert.ok(css.includes('.oc.exp'), 'CSS must define .oc.exp');
  assert.ok(css.includes('.det'), 'CSS must define .det row expansion');
});
