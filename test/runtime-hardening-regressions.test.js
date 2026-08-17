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

test('Pattern access polling pauses while the document is hidden', () => {
  const runtime = fs.readFileSync(path.join(ROOT, 'public/pattern-stable-runtime.js'), 'utf8');
  const interval = runtime.indexOf('root.setInterval(function () {');
  const hiddenGuard = runtime.indexOf("doc.visibilityState === 'hidden'");
  assert.ok(interval >= 0, 'pattern access interval missing');
  assert.ok(hiddenGuard > interval && hiddenGuard < runtime.indexOf('if (!state.checked', interval), 'hidden-tab guard must run before access work');
});

test('the shared application shell CSS is cacheable outside the HTML document', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public/index-shell.css'), 'utf8');
  assert.match(html, /<link rel="stylesheet" href="\/index-shell\.css\?v=[^"]+">/);
  assert.doesNotMatch(html.slice(0, html.indexOf('</head>')), /<style>/);
  assert.match(css, /\.maintenance-card/);
  assert.match(css, /prefers-reduced-motion/);
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

// ---------------------------------------------------------------------------
// Dashboard pick card: attribute-context escaping
// ---------------------------------------------------------------------------
// dashJsString() escapes a backslash and a single quote, which is correct for
// the JS string literal it builds. But the result is embedded in a DOUBLE-quoted
// HTML attribute:
//
//   onclick="openDashboardPickDetail('<TICKER>')"
//
// so a ticker containing a double quote closed the attribute and let the rest
// of the value become new attributes. Verified in Chromium before the fix: the
// parsed element carried an injected `onmouseover` handler. The fix layers the
// escapes in the correct order — JS-escape, then HTML-escape.
test('ticker cannot break out of the pick card onclick attribute', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

  // Both cards must HTML-escape after JS-escaping.
  const decls = html.match(/var tickerJs = [^;]+;/g) || [];
  assert.ok(decls.length >= 2, 'expected the Top 5 and monitor card declarations');
  decls.forEach(decl => {
    assert.match(decl, /escapeHtml\(\s*dashJsString\(/,
      'tickerJs must be HTML-escaped after JS-escaping: ' + decl);
  });

  // The server-supplied rank is interpolated into markup and must be escaped.
  assert.match(html, /"dash-rank">' \+ escapeHtml\(rank\)/);

  // Reproduce both forms. dashJsString only needs to be modelled to the extent
  // that it leaves a double quote untouched, which is the whole defect.
  const escapeHtml = t => String(t == null ? '' : t).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const QUOTE = String.fromCharCode(34);
  const hostile = 'AB' + QUOTE + ' onmouseover=' + QUOTE + 'steal()' + QUOTE + ' x=' + QUOTE;

  // Unescaped: the payload's double quote closes onclick and starts new attributes.
  const unsafeAttr = 'onclick=' + QUOTE + "f('" + hostile + "')" + QUOTE;
  assert.ok(unsafeAttr.indexOf('onmouseover=') > -1,
    'sanity: the unescaped form really does break out of the attribute');
  const unsafeInner = unsafeAttr.slice(('onclick=' + QUOTE).length, -1);
  assert.ok(unsafeInner.indexOf(QUOTE) > -1, 'sanity: raw quote survives unescaped');

  // Escaped: no raw double quote can remain inside the attribute value.
  const safeAttr = 'onclick=' + QUOTE + "f('" + escapeHtml(hostile) + "')" + QUOTE;
  const safeInner = safeAttr.slice(('onclick=' + QUOTE).length, -1);
  assert.equal(safeInner.indexOf(QUOTE), -1, 'escaped payload must contain no raw double quote');
  assert.ok(safeInner.indexOf('&quot;') > -1, 'the quote must survive as an entity');
});
