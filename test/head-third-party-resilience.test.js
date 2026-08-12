'use strict';

// ===========================================================================
// The document head loads two third-party resources from origins the product
// does not control: the Tailwind Play CDN and Google Fonts. Neither may be
// allowed to break or stall the page when it is slow, filtered, or down —
// which happens on plenty of corporate and ISP networks.
//
// Measured in Chromium:
//   font stylesheet render-blocking, font CDN answering in 1200ms
//     FCP ~1408/1428/1432 ms
//   same, loaded with media="print" + onload
//     FCP  ~200/304/216 ms, and link.media flips to "all" so Inter still applies
//
//   Tailwind CDN aborted entirely
//     before: uncaught ReferenceError "tailwind is not defined" on every load
//     after:  0 page errors, landing page renders, loader hidden
//
// LOCAL / STATIC ONLY.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const head = html.slice(0, html.indexOf('</head>'));

test('the webfont stylesheet does not block first paint', () => {
  const link = head.match(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>/);
  assert.ok(link, 'the Inter stylesheet link must exist');
  assert.match(
    link[0],
    /media="print"/,
    'a plain stylesheet link hands the whole font-CDN round trip to first paint'
  );
  assert.match(link[0], /onload="this\.media='all'/, 'it must be promoted to all once loaded');
});

test('the webfont still applies without JavaScript', () => {
  const noscript = head.match(/<noscript>[\s\S]*?<\/noscript>/);
  assert.ok(noscript, 'the media=print swap needs a noscript fallback');
  assert.match(noscript[0], /fonts\.googleapis\.com/);
  assert.doesNotMatch(noscript[0], /media="print"/, 'the fallback must load normally');
});

test('preconnect hints for the font origins are kept', () => {
  assert.match(head, /<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com">/);
  assert.match(head, /<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin>/);
});

test('the Tailwind config does not throw when the CDN is unavailable', () => {
  const idx = head.indexOf('tailwind.config');
  assert.ok(idx > 0, 'the Tailwind theme extension must still be configured');
  const guard = head.lastIndexOf("typeof tailwind !== 'undefined'", idx);
  assert.ok(
    guard > 0 && guard < idx,
    'a bare `tailwind.config = ...` throws ReferenceError whenever the CDN is '
    + 'blocked, throttled, or filtered'
  );
});

test('the brand palette survives the guard', () => {
  // The guard must not have quietly dropped the theme extension it wraps.
  assert.match(head, /dark:\s*\{\s*900:\s*'#0b0e14'/);
});

test('the canonical-domain redirect still runs before app init', () => {
  // Unrelated to the above, but it shares this head and is easy to break by
  // reordering: it must stay ahead of the Tailwind and app scripts.
  const redirect = head.indexOf("window.location.hostname === 'auto-cuan.vercel.app'");
  const tailwind = head.indexOf('cdn.tailwindcss.com');
  assert.ok(redirect > 0 && redirect < tailwind, 'the canonical redirect runs first');
});
