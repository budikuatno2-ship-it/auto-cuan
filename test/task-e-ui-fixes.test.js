'use strict';
/**
 * TASK E regression coverage:
 *  1. Legacy screener mode tabs are hidden in the UI while all panes, ids,
 *     data and switchScreenerType() remain intact in source.
 *  2. The duplicated ticker header + sub-tab bar is only rendered on
 *     issuer-research lenses; market-wide lenses hide it at the render root.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('TASK E: legacy screener mode switch hidden, legacy source preserved', () => {
  const html = read('public/index.html');
  const start = html.indexOf('<div id="page-screener"');
  const end = html.indexOf('<!-- ===== PAGE:', start + 10);
  const page = html.slice(start, end);

  // UI: the three-way mode switch is hidden from users.
  assert.match(page, /class="segx n3 scr-modes hidden" style="display:none !important"[^>]*data-task-e-legacy-mode-switch="hidden"/);

  // Source/state: all three panes, buttons and the switch function survive.
  for (const id of ['scrTypeKonglo', 'scrTypeNonKonglo', 'scrTypeDayTrade', 'screenerKongloPane', 'screenerNonKongloPane', 'screenerDayTradePane']) {
    assert.ok(page.includes('id="' + id + '"'), id + ' must remain in source');
  }
  assert.match(html, /function switchScreenerType\(type\)/);
  assert.match(html, /loadSwingScreener\(\)/);
  assert.match(html, /loadNkScreenerResults\(\)/);
  assert.match(html, /loadDayTradeScreener\(\)/);

  // Konglo is the single visible default pane.
  assert.match(page, /<div id="screenerKongloPane" class="space-y-3">/);
  assert.match(page, /<div id="screenerNonKongloPane" class="hidden space-y-3">/);
  assert.match(page, /<div id="screenerDayTradePane" class="hidden space-y-3">/);
});

test('TASK E: ticker header rendered only on issuer-research lenses', () => {
  const js = read('public/analisis-saham-runtime.js');
  assert.match(js, /var needsTickerHeader = \(parentTab === 'analisis-chart' \|\| parentTab === 'bandarmologi'\);/);
  assert.match(js, /if \(pHeader\) pHeader\.style\.display = needsTickerHeader \? 'block' : 'none';/);
  assert.match(js, /if \(pSubtabWrap\) pSubtabWrap\.style\.display = needsTickerHeader \? 'flex' : 'none';/);
  // The old unconditional show is gone.
  assert.doesNotMatch(js, /if \(pHeader\) pHeader\.style\.display = 'block';\s*if \(pSubtabWrap\) pSubtabWrap\.style\.display = 'flex';/);
});

test('TASK E: partial and inline template keep one header instance each', () => {
  const partial = read('partials/analisis-saham.partial.html');
  const inline = read('public/index.html');
  assert.equal((partial.match(/id="analisisChartHeader"/g) || []).length, 1);
  // The inline <template> is a fallback source, not a second live render.
  const tplStart = inline.indexOf('<template id="tpl-analisis-saham">');
  const tplEnd = inline.indexOf('</template>', tplStart);
  const tpl = inline.slice(tplStart, tplEnd);
  assert.equal((tpl.match(/id="analisisChartHeader"/g) || []).length, 1);
});

test('TASK E: duplicate candle requests are coalesced by shared helper', () => {
  const helper = read('public/candle-request-dedupe.js');
  assert.match(helper, /fetchCandlesOnce: fetchCandlesOnce/);
  assert.match(helper, /if \(hit && \(now - hit\.at\) < TTL_MS && hit\.promise\) return hit\.promise;/);
  const b3 = read('public/b3-liquidity-inject.js');
  const cockpit = read('public/unified-cockpit-runtime.js');
  assert.match(b3, /dedupe\.fetchCandlesOnce\(candleUrl\)/);
  assert.match(cockpit, /dedupe\.fetchCandlesOnce\(candleUrl, \{ signal: _fetchSignal \}\)/);
  const html = read('public/index.html');
  const dedupeTag = html.indexOf('<script src="/candle-request-dedupe.js');
  assert.ok(dedupeTag > 0);
  assert.ok(dedupeTag < html.indexOf('<script src="/b3-liquidity-inject.js'));
  assert.ok(dedupeTag < html.indexOf('<script src="/unified-cockpit-runtime.js'));
});
