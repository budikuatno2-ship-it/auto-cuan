'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const patternSafety = require('../public/pattern-direction-safety.js');
const patternHardening = require('../public/pattern-safety-hardening-v1.js');
const uiHardening = require('../public/ui-bugfix-pack-v1.js');

function hardenedSafety() {
  return patternHardening.patch(Object.assign({}, patternSafety));
}

test('Pattern safeFinite preserves real zero but never coerces missing values to zero', () => {
  const f = patternHardening.safeFinite;
  [null, undefined, '', '   ', false, true, [], {}, NaN, Infinity, -Infinity].forEach(value => {
    assert.equal(f(value), null, String(value));
  });
  assert.equal(f(0), 0);
  assert.equal(f('0'), 0);
  assert.equal(f(100), 100);
  assert.equal(f('100'), 100);
});

test('incomplete Screener plans cannot become directional Pattern confluence', () => {
  const direction = patternHardening.tradePlanDirection;
  const bullish = { entry_low:100, entry_high:110, stop_loss:95, tp1:120, tp2:130 };
  const bearish = { entry_low:100, entry_high:110, stop_loss:115, tp1:90, tp2:80 };

  assert.equal(direction(bullish), 'bullish');
  assert.equal(direction(bearish), 'bearish');

  assert.equal(direction(Object.assign({}, bullish, { stop_loss:null })), 'unknown');
  assert.equal(direction(Object.assign({}, bullish, { stop_loss:'' })), 'unknown');
  assert.equal(direction(Object.assign({}, bullish, { entry_low:null })), 'unknown');
  assert.equal(direction(Object.assign({}, bullish, { entry_high:undefined })), 'unknown');
  assert.equal(direction(Object.assign({}, bullish, { tp1:null })), 'unknown');
});

test('missing Pattern level is incomplete, never silently invalidated or target-reached', () => {
  const safety = hardenedSafety();
  const row = {
    ticker:'BBCA',
    candidate:{
      name:'Bullish ABCD', status:'confirmed', currentPrice:1000,
      confirmation:990, invalidation:950, tp1:1080, tp2:null
    }
  };
  const verdict = safety.evaluateRow(row, null);
  assert.equal(verdict.status, safety.STATUS.INCOMPLETE);
  assert.equal(verdict.actionable, false);
  assert.ok(verdict.reasons.includes('incomplete_levels'));
  assert.ok(!verdict.reasons.includes('invalidation_reached'));
  assert.ok(!verdict.reasons.includes('target_already_reached'));
  assert.equal(verdict.levels.tp2, null);
});

test('Pattern hardening is installed before the safety model/runtime loader', () => {
  const loader = fs.readFileSync(path.join(ROOT, 'public/assets/fca-stocks.js'), 'utf8');
  const hardeningAt = loader.indexOf('/pattern-safety-hardening-v1.js');
  const safetyAt = loader.indexOf('/pattern-direction-safety.js');
  const runtimeAt = loader.indexOf('/pattern-stable-runtime.js');
  assert.ok(hardeningAt >= 0, 'hardening loader missing');
  assert.ok(safetyAt > hardeningAt, 'safety model is requested before hardening');
  assert.ok(runtimeAt > hardeningAt, 'Pattern runtime is requested before hardening');
});

test('named HTML entities cannot hide an executable URL scheme', () => {
  const payloads = [
    '<a href="javascript&colon;alert(1)">x</a>',
    '<a href="javascript&colonalert(1)">x</a>',
    '<a href="java&Tab;script&colon;alert(1)">x</a>',
    '<a href="java&NewLine;script&colon;alert(1)">x</a>',
    '<a href="JaVaScRiPt&CoLoN;alert(1)">x</a>',
    '<a href="javascript&#58;alert(1)">x</a>',
    '<a href="javascript&#x3a;alert(1)">x</a>',
    '<a href="&#9;javascript&colon;alert(1)">x</a>',
    '<a href="vbscript&colon;msgbox(1)">x</a>',
    '<a href="data&colon;text/html,x">x</a>'
  ];
  payloads.forEach(payload => {
    const out = uiHardening.hardenUrlAttributes(payload, null);
    assert.match(out, /href="#"/i, payload);
    assert.doesNotMatch(out, /href\s*=\s*["'](?:javascript|vbscript|data)/i, payload);
  });
});

test('legitimate relative, anchor, http and https URLs remain untouched', () => {
  [
    '<a href="https://idx.co.id">IDX</a>',
    '<a href="http://example.com">HTTP</a>',
    '<a href="/dashboard">Dashboard</a>',
    '<a href="#section">Section</a>'
  ].forEach(payload => {
    assert.equal(uiHardening.hardenUrlAttributes(payload, null), payload);
  });
});

test('every URL-bearing attribute covered by the AI sanitizer gets the same scheme check', () => {
  ['href', 'src', 'xlink:href', 'action', 'formaction', 'data', 'poster'].forEach(attr => {
    const out = uiHardening.hardenUrlAttributes('<x ' + attr + '="javascript&colon;alert(1)">', null);
    assert.match(out, new RegExp(attr.replace(':', '\\:') + '="#"', 'i'), attr);
  });

  const srcset = uiHardening.hardenUrlAttributes(
    '<img srcset="https://ok.example/a.png 1x, java&Tab;script&colon;alert(1) 2x">',
    null
  );
  assert.match(srcset, /srcset=""/i);
});

test('runtime sanitizer wrapper hardens the actual sanitizeAIHtml sink', () => {
  const root = {
    document: {},
    sanitizeAIHtml: html => html.replace(/<script[\s\S]*?<\/script>/gi, '')
  };
  assert.equal(uiHardening.installSanitizerHardening(root), true);
  assert.equal(root.sanitizeAIHtml.__autocuanUrlHardening, uiHardening.SANITIZER_HARDENING_VERSION);
  assert.match(root.sanitizeAIHtml('<script>x</script><a href="javascript&colon;alert(1)">x</a>'), /href="#"/i);
  assert.doesNotMatch(root.sanitizeAIHtml('<script>x</script><a href="javascript&colon;alert(1)">x</a>'), /<script/i);
});
