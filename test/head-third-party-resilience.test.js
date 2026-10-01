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
//     then:   0 page errors — but the app still rendered completely unstyled,
//             because the CDN was not just configuring Tailwind, it *was* the
//             stylesheet
//     now:    the sheet is built ahead of time and served from this origin, so
//             blocking the CDN changes nothing at all
//
// LOCAL / STATIC ONLY.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
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

test('Tailwind cannot fail open, because it is no longer fetched at runtime', () => {
  // This used to guard `tailwind.config = ...` against a ReferenceError when the
  // Play CDN was blocked. That guard only stopped the console error; the page
  // still lost its entire layout, because the CDN *is* the stylesheet.
  // The sheet is now built ahead of time and served from this origin, so there
  // is no runtime compiler to be absent.
  assert.doesNotMatch(head, /cdn\.tailwindcss\.com/);
  assert.doesNotMatch(head, /tailwind\.config\s*=/);
  assert.match(head, /<link[^>]+href="\/tailwind-build\.css/);
});

test('the brand palette survives the move to a built stylesheet', () => {
  // The palette that used to live in the inline tailwind.config now lives in
  // tailwind.config.js and must reach the generated sheet.
  const config = fs.readFileSync(path.join(ROOT, 'tailwind.config.js'), 'utf8');
  assert.match(config, /900:\s*'#0b0e14'/);
  const css = fs.readFileSync(path.join(ROOT, 'public', 'tailwind-build.css'), 'utf8');
  assert.match(css, /#0b0e14/);
});

test('the canonical-domain redirect still runs before anything else in the head', () => {
  // It must stay ahead of the stylesheet and every app script: reordering the
  // head is the easy way to break it.
  const redirect = head.indexOf("window.location.hostname === 'auto-cuan.vercel.app'");
  const stylesheet = head.indexOf('/tailwind-build.css');
  assert.ok(redirect > 0 && redirect < stylesheet, 'the canonical redirect runs first');
});
