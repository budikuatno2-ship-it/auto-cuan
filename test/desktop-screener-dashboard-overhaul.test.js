'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const theme = fs.readFileSync(path.join(ROOT, 'public', 'ui-theme.css'), 'utf8');
const dtRuntime = fs.readFileSync(path.join(ROOT, 'public', 'daytrade-runtime.js'), 'utf8');

test('PR 4: 2-column sticky classes (sticky-col-1 and sticky-col-2) are defined in ui-theme.css', () => {
  assert.match(theme, /\.panel table th\.sticky-col-1/);
  assert.match(theme, /\.panel table th\.sticky-col-2/);
  assert.match(theme, /position:\s*sticky;\s*left:\s*36px;/);
});

test('PR 4: Day Trade table has sticky # and Ticker headers and row cells', () => {
  assert.match(html, /<tr class="scr-cols-22 bg-dark-700\/80">\s*<th[^>]*sticky-col-1[^>]*>#<\/th>\s*<th[^>]*sticky-col-2[^>]*>Ticker<\/th>/);
  assert.match(dtRuntime, /sticky-col-1 sticky left-0/);
  assert.match(dtRuntime, /sticky-col-2 sticky left-\[36px\]/);
});

test('PR 4: Non-Konglo table has sticky # and Ticker headers and row cells', () => {
  assert.match(html, /<tr class="scr-cols-18 bg-dark-700\/80">\s*<th[^>]*sticky-col-1[^>]*>#<\/th>\s*<th[^>]*sticky-col-2[^>]*>Ticker<\/th>/);
  assert.match(html, /sticky-col-1 sticky left-0[^>]*>\'\s*\+\s*\(r\.rank/);
  assert.match(html, /sticky-col-2 sticky left-\[36px\][^>]*>\'\s*\+\s*r\.ticker/);
});

test('PR 4: Standardized trade-plan-grid is defined in ui-theme.css and used in card grids', () => {
  assert.match(theme, /\.trade-plan-grid\s*\{/);
  assert.match(theme, /\.trade-plan-tile\[data-type="entry"\]/);
  assert.match(theme, /\.trade-plan-tile\[data-type="sl"\]/);
  assert.match(theme, /\.trade-plan-tile\[data-type="tp"\]/);
  assert.match(theme, /\.trade-plan-tile\[data-type="rr"\]/);

  assert.match(html, /function renderDtCardGrid[\s\S]*?trade-plan-grid/);
  assert.match(html, /function renderKgCardGrid[\s\S]*?trade-plan-grid/);
  assert.match(html, /function renderNkCardGrid[\s\S]*?trade-plan-grid/);
});

test('PR 4: Skeleton loader helpers are present for both tables and cards', () => {
  assert.match(html, /function screenerSkeletonTableRowsHtml\(/);
  assert.match(html, /function screenerSkeletonCardHtml\(/);
  assert.match(html, /tbody\.innerHTML\s*=\s*screenerSkeletonTableRowsHtml\(17,\s*5\)/);
  assert.match(html, /tbody\.innerHTML\s*=\s*screenerSkeletonTableRowsHtml\(18,\s*5\)/);
  assert.match(dtRuntime, /screenerSkeletonTableRowsHtml\(22,\s*5\)/);
});

test('PR 4: Rich empty states provide clear guidance and action buttons', () => {
  assert.match(html, /function screenerEmptyCardHtml\(message,\s*actionLabel,\s*actionFn\)/);
  assert.match(html, /id="chartPageContainer"[\s\S]*?Ketik ticker di atas untuk melihat candlestick chart interaktif/);
  assert.match(html, /chartTickerInput[\s\S]*?BBCA[\s\S]*?loadChartPage/);
});
