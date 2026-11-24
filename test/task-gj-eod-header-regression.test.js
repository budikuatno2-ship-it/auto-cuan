'use strict';
/**
 * TASK I regression — stale EOD header.
 *
 * Real finding: the dashboard header showed "EOD (Selesai) · 4 Nov 2026, 15.45 WIB"
 * from a hardcoded `when.indexOf('1 Nov 2026')` override, while the canonical
 * latest EOD session was 18 Nov 2026 (max stock_daily_history). The fix removes
 * the hardcoded calendar date and derives the displayed timestamp from the
 * backend's canonical EOD metadata, with honest staleness already computed from
 * the dataset trading date.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

test('TASK I: no hardcoded 1 Nov/4 Nov EOD date override remains', () => {
  assert.doesNotMatch(html, /when\.indexOf\('1 Nov 2026'\)/);
  assert.doesNotMatch(html, /when = '4 Nov 2026, 15\.45 WIB'/);
  assert.doesNotMatch(html, /id="globalLiveRadarTime"> · 4 Nov 2026, 15\.45 WIB/);
});

test('TASK I: EOD header reads canonical EOD metadata and keeps honest staleness', () => {
  assert.match(html, /canonicalEodAt = meta\.canonical_eod_at \|\| meta\.latest_eod_at \|\| meta\.data_as_of \|\| null/);
  assert.match(html, /if \(status === 'eod' && canonicalEodAt/);
  assert.match(html, /statesApi\.formatWib\(canonicalMs\)/);
  // The canonical date must not force a "Selesai" (today) label by itself.
  assert.doesNotMatch(html, /canonicalEodAt[^;]*;\s*label = 'EOD \(Selesai\)'/);
  // Honest staleness branches remain intact.
  assert.match(html, /label = 'EOD \/ T-1'/);
  assert.match(html, /status = 'stale'/);
});

test('TASK I: canonical EOD timestamp is formatted through the WIB formatter', () => {
  // Extract updateGlobalLiveRadarStatus and exercise the canonical branch in a
  // sandbox with a controllable DOM and formatter (no network, no DB).
  const start = html.indexOf('function updateGlobalLiveRadarStatus(');
  assert.ok(start > 0, 'helper exists');
  // Find the function by brace matching.
  let depth = 0, end = -1, seen = false;
  for (let i = html.indexOf('{', start); i < html.length; i++) {
    if (html[i] === '{') { depth++; seen = true; }
    else if (html[i] === '}') { depth--; if (seen && depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > start, 'function body extracted');
  const fnSrc = html.slice(start, end);
  const nodes = {};
  function el(id) {
    if (!nodes[id]) nodes[id] = {
      id, className: '', title: '', textContent: '', style: { removeProperty() {}, setProperty() {} },
      setAttribute(k, v) { this[k] = v; }, classList: { add() {}, remove() {}, toggle() {} }
    };
    return nodes[id];
  }
  const sandbox = {
    Date, Number, String, Array, Object, Math, isFinite,
    document: { getElementById: el },
    window: null,
    AutoCuanStates: { formatWib: (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' WIB' }
  };
  sandbox.window = sandbox;
  vm.runInNewContext(fnSrc + '\nthis.__fn = updateGlobalLiveRadarStatus;', sandbox);
  const now = Date.now();
  const meta = {
    calculated_at: new Date(now - 3600000).toISOString(),
    is_eod_final: true,
    session_status: 'FINAL_EOD',
    canonical_eod_at: '2026-11-18T08:45:00.000Z',
    data_as_of: '2026-11-18'
  };
  sandbox.__fn(meta);
  const stamp = el('globalLiveRadarTime').textContent;
  assert.match(stamp, /2026-11-18 08:45 WIB/, 'canonical EOD timestamp shown, not 4 Nov 2026');
  assert.doesNotMatch(stamp, /4 Nov 2026/);
  assert.equal(el('globalLiveRadarChip')['data-freshness-state'], 'eod');
});
