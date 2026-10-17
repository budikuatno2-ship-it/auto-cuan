'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

test('FIX-18: public/ui-theme.css has no duplicate .ac-split-view block and unified .page-content', () => {
  const css = fs.readFileSync(require.resolve('../public/ui-theme.css'), 'utf8');

  // 1. Check duplicate desktop block removal: the exact desktop rule
  //    `[data-ac-ui="v2"] .ac-split-view,` followed by `.ac-ui-v2.ac-split-view,`
  //    must appear exactly once (the mobile media-query override uses a different
  //    indented form and is legitimate).
  const desktopBlockMatches = css.match(/\[data-ac-ui="v2"\] \.ac-split-view,\n\.ac-ui-v2\.ac-split-view,\n\.ac-ui-v2 \.ac-split-view \{/g) || [];
  assert.equal(desktopBlockMatches.length, 1, 'The .ac-split-view desktop layout block must appear exactly once, not duplicated');

  // 2. Check .page-content contradiction resolution
  assert.ok(!css.includes('.page-content {\n  overflow-y: auto !important;\n  -webkit-overflow-scrolling: touch;\n}'),
    '.page-content must not have conflicting overflow-y: auto !important rule');

  // 3. Check ac-ticker-sticky-cell definition
  assert.match(css, /\.ac-ticker-sticky-cell/, 'Must declare .ac-ticker-sticky-cell rule in ui-theme.css');
});

test('FIX-18: public/daytrade-runtime.js adds ac-ticker-sticky-cell to sticky columns', () => {
  const js = fs.readFileSync(require.resolve('../public/daytrade-runtime.js'), 'utf8');
  assert.match(js, /sticky-col-1[^"]*ac-ticker-sticky-cell/, 'Sticky col 1 must have ac-ticker-sticky-cell');
  assert.match(js, /sticky-col-2[^"]*ac-ticker-sticky-cell/, 'Sticky col 2 must have ac-ticker-sticky-cell');
});
