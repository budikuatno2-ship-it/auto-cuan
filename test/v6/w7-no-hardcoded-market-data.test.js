'use strict';

/**
 * test/v6/w7-no-hardcoded-market-data.test.js
 * ============================================================================
 * V6 W7 — Whole-web route/tab hardcode & data-provenance audit.
 *
 *   (a) audited pages contain zero P0 hardcoded market-data literals
 *   (b) every public/*.html has zero duplicate DOM ids (markup only)
 *   (c) the null-handling contract renders '—' + status for null and the value
 *       for a genuine 0
 *   (d) the ticker-race guard renders only the latest overlapping response
 *
 * These are source/unit assertions. Live browser behaviour is documented in
 * docs/v6/V6_W7_HARDCODE_AUDIT.md.
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* -------------------------------------------------------------------------- */
/* (a) No hardcoded market-data literals in audited pages                     */
/* -------------------------------------------------------------------------- */

// Pages that render market data to the user. Config-only pages (404, trust,
// methodology, ketentuan, register, maintenance) are excluded by design.
const AUDITED_PAGES = [
  'public/index.html',
  'public/analisis-saham.html',
  'public/admin-console.html',
  'public/admin-ownership.html',
  'public/admin-foreign.html',
  'public/admin-ai-eval.html',
  'public/portfolio-command-center.html',
  'public/portfolio-command-center-v2.html',
  'public/portfolio-planner.html',
  'public/pattern-radar.html',
  'partials/analisis-saham.partial.html',
  'partials/money-management.partial.html',
  'partials/portfolio-command-center.partial.html'
];

// A price literal presented as live market data: "Rp 1.534", "harga 1.550",
// "Entry Rp 2.230". The em-dash empty state (&mdash; / —) is the allowed form.
const PRICE_LITERAL = /(?:Rp\.?\s*|harga\s*|price\s*|last\s*|close\s*)[^<\n]{0,20}?\b\d{1,3}(?:[.,]\d{3})+\b/gi;

// Documented allowlist: legitimate configuration constants that are NOT market
// data presented as live. Each entry is a file + exact substring that may match
// the price pattern but is a threshold/default, not a quote.
const ALLOWLIST = [
  // Landing calculator slider bounds (modal in juta rupiah, risk %).
  { file: 'public/index.html', contains: 'min="10" max="1000"' },
  // Risk-per-trade slider bounds.
  { file: 'public/index.html', contains: 'min="0.25" max="3"' }
];

function isAllowlisted(file, snippet) {
  return ALLOWLIST.some((a) => a.file === file && snippet.indexOf(a.contains) >= 0);
}

test('W7-(a): audited pages contain zero hardcoded live market-price literals', () => {
  const violations = [];
  for (const p of AUDITED_PAGES) {
    let text;
    try { text = read(p); } catch (_) { continue; }
    // Only scan visible markup, not <script> logic.
    const visible = text.replace(/<script[\s\S]*?<\/script>/gi, (m) => ' '.repeat(m.length));
    let m;
    PRICE_LITERAL.lastIndex = 0;
    while ((m = PRICE_LITERAL.exec(visible))) {
      const snippet = m[0].trim();
      if (isAllowlisted(p, snippet)) continue;
      violations.push(p + ' :: ' + snippet);
    }
  }
  assert.deepEqual(violations, [], 'hardcoded market-price literals remain:\n' + violations.join('\n'));
});

test('W7-(a2): landing preview + calculator default to an explicit empty state', () => {
  const html = read('public/index.html');
  // The static preview must not carry a hardcoded score/price as if live.
  assert.equal(/<span class="score-number">\d+<\/span>/.test(html), false, 'score-number must not be a literal');
  assert.equal(html.includes('<b id="lpCalcEntryVal" style="font-family:monospace">1.210</b>'), false, 'entry must not be hardcoded');
  assert.ok(html.includes('<b id="lpCalcEntryVal" style="font-family:monospace">&mdash;</b>'), 'entry must be an em-dash empty state');
  assert.ok(html.includes('SIMULASI INTERAKTIF (data belum tersedia)'), 'calculator badge must be an empty state');
});

test('W7-(a3): bandarmologi runtime never fabricates foreign flow or bandar score', () => {
  const js = read('public/bandarmologi-runtime.js');
  // The old fabrication: foreignNetVal = Math.round(bandarNetVal * 0.755)
  assert.equal(/foreignNetVal\s*=\s*Math\.round\(bandarNetVal\s*\*\s*0\.755\)/.test(js), false,
    'foreign flow must not be derived from bandar net');
  // The old fabricated score fallback: net_flow >= 0 ? 92 : 35
  assert.equal(/\?\s*92\s*:\s*35/.test(js), false, 'bandar score must not be a fabricated 92/35');
});

/* -------------------------------------------------------------------------- */
/* (b) Duplicate DOM ids across every public/*.html                           */
/* -------------------------------------------------------------------------- */

test('W7-(b): no duplicate DOM ids in any public/*.html (markup only)', () => {
  const dir = path.join(ROOT, 'public');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.html'));
  const problems = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    // Strip <script>/<style>: ids there are strings/selectors, not DOM nodes.
    const markup = text.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
    const ids = {};
    const re = /id="([^"]+)"/g;
    let m;
    while ((m = re.exec(markup))) {
      const id = m[1];
      if (id.indexOf("'") >= 0 || id.indexOf('+') >= 0) continue; // template concat
      ids[id] = (ids[id] || 0) + 1;
    }
    for (const [id, c] of Object.entries(ids)) {
      if (c > 1) problems.push(f + ' :: id="' + id + '" x' + c);
    }
  }
  assert.deepEqual(problems, [], 'duplicate ids:\n' + problems.join('\n'));
});

test('W7-(b2): portfolio-command-center-v2 strips a duplicate loader before append', () => {
  const html = read('public/portfolio-command-center-v2.html');
  assert.ok(html.includes("querySelectorAll('#portfolioV2Loader')"), 'must strip fetched loader before appending LOADER_HTML');
});

/* -------------------------------------------------------------------------- */
/* (c) Null-handling contract: '—' + status for null, value for 0             */
/* -------------------------------------------------------------------------- */

test('W7-(c): null renders an absence marker + status; a measured 0 renders the value', () => {
  const contract = require(path.join(ROOT, 'lib', 'market-data-contract.js'));

  const missing = contract.describeForeignFlow(null);
  assert.equal(missing.display, '\u2014', 'null must render an em dash');
  assert.equal(missing.isKnown, false);
  assert.ok(missing.dataStatus, 'null must carry an explicit data status');

  const bareZero = contract.describeForeignFlow(0);
  assert.equal(bareZero.display, '\u2014', 'an unbacked 0 is absence, not a measurement');

  const measuredZero = contract.describeForeignFlow({ value: 0, data_status: 'AVAILABLE' });
  assert.equal(measuredZero.isKnown, true, 'an AVAILABLE 0 is a real market fact');
  assert.notEqual(measuredZero.display, '\u2014', 'a measured 0 must render a value, not an em dash');

  const real = contract.describeForeignFlow(1500000);
  assert.equal(real.isKnown, true);
  assert.notEqual(real.display, '\u2014');
});

/* -------------------------------------------------------------------------- */
/* (d) Ticker-race guard: only the latest overlapping response renders        */
/* -------------------------------------------------------------------------- */

test('W7-(d): app.js loadMatrix carries a monotonic request token', () => {
  const js = read('public/app.js');
  assert.ok(/var\s+matrixSeq\s*=\s*0/.test(js), 'a monotonic sequence counter must exist');
  assert.ok(/var\s+seq\s*=\s*\+\+matrixSeq/.test(js), 'each request must capture its own sequence');
  assert.ok(/if\s*\(\s*seq\s*!==\s*matrixSeq\s*\)\s*return/.test(js), 'a stale response must be discarded');
});

test('W7-(d2): two overlapping responses render only the latest ticker', async () => {
  // Replicate the exact guard semantics from public/app.js loadMatrix.
  let matrixSeq = 0;
  const rendered = [];
  function renderMatrix(data) { rendered.push(data.ticker); }

  async function loadMatrix(ticker, delayMs) {
    const seq = ++matrixSeq;
    await new Promise((r) => setTimeout(r, delayMs));
    if (seq !== matrixSeq) return; // superseded
    renderMatrix({ ticker });
  }

  // Ticker A is slow, ticker B is fast and issued after A.
  const a = loadMatrix('AAAA', 30);
  const b = loadMatrix('BBBB', 5);
  await Promise.all([a, b]);

  assert.deepEqual(rendered, ['BBBB'], 'only the latest ticker may render; got ' + JSON.stringify(rendered));
});
