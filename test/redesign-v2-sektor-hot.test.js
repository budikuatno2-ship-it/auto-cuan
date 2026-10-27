'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

test('Sektor Hot: canvas markup elements and structures exist', () => {
  // Page container
  assert.ok(html.includes('id="page-sektor"'), 'page-sektor must exist');
  assert.ok(html.includes('id="sektorContent"'), 'sektorContent must exist');

  // Header and switch
  assert.ok(html.includes('Rotasi institusi &amp; konglomerasi IDX') || html.includes('Rotasi institusi & konglomerasi IDX'));
  assert.ok(html.includes('id="sektorBtnTable"') && html.includes('Tabel klasemen'));
  assert.ok(html.includes('id="sektorBtnGrid"') && html.includes('Heatmap'));
  assert.ok(html.includes('id="sektorViewInd"'));

  // Search input and counts
  assert.ok(html.includes('id="sektorSearchInput"'));
  assert.ok(html.includes('placeholder="Cari grup atau emiten"'));
  assert.ok(html.includes('id="sektorCounts"'));
  assert.ok(html.includes('id="sektorSubtitle"'));

  // Table wrapper and table
  assert.ok(html.includes('id="sektorTableWrap"') && html.includes('overflow-x-auto'));
  assert.ok(html.includes('id="sektorGroupsTable"'));
  assert.ok(html.includes('id="sektorGroupsTableBody"'));

  // Heatmap
  assert.ok(html.includes('id="sektorGroupsGrid"') && html.includes('hm'));
  assert.ok(html.includes('id="sektorHeatmapProv"'));

  // Detail view
  assert.ok(html.includes('id="sektorDetailView"'));
  assert.ok(html.includes('backToSektorList()'));
  assert.ok(html.includes('id="sektorDetailHeader"'));
  assert.ok(html.includes('id="sektorDetailStrip"'));
  assert.ok(html.includes('id="sektorDetCap"'));
  assert.ok(html.includes('id="sektorDetNf"'));
  assert.ok(html.includes('id="sektorDetPbv"'));
  assert.ok(html.includes('id="sektorDetVol"'));
  assert.ok(html.includes('id="sektorDetDate"'));
  assert.ok(html.includes('id="sektorDetailTable"'));
});

test('Sektor Hot: zero internal database/server names exposed in UI markup', () => {
  const sektorSection = html.slice(html.indexOf('id="page-sektor"'), html.indexOf('id="page-screener"'));
  assert.ok(!sektorSection.includes('Arjum'), 'Arjum must not appear in Sektor Hot UI');
  assert.ok(!sektorSection.includes('VPS'), 'VPS must not appear in Sektor Hot UI');
  assert.ok(!sektorSection.includes('sector_hot_latest'), 'Raw table name must not appear in UI');
  assert.ok(!sektorSection.includes('sector-hot-*.json'), 'Raw file pattern must not appear in UI');
});

test('Sektor Hot: table has horizontal overflow protection and no svg hidden attribute', () => {
  const sektorSection = html.slice(html.indexOf('id="page-sektor"'), html.indexOf('id="page-screener"'));
  assert.ok(sektorSection.includes('overflow-x-auto'), 'Table wrappers must have overflow-x-auto');
  assert.doesNotMatch(sektorSection, /<svg[^>]*\shidden[=>\s]/i, 'No .hidden attribute on SVG elements');
});
