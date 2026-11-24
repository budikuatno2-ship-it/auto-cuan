'use strict';

/**
 * FIX 3 regression contract — single-label SVG rendering + canonical data binding.
 * Guardrails: read-only snapshot DB, no HTTP, no DB writes, no deploy.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const runtime = require('../public/bandarmologi-runtime');
const canonical = require('../lib/canonical-insider-source');

const GHOST_LABELS = [
  'Robert Budi Hartono', 'PT Dwimuria Investama Andalan', 'BBCA', 'TOWR', 'BELI',
  'Jahja Setiaatmadja', 'Armand Wahyudi Hartono', 'Masyarakat/Publik',
  '0,01%', '0,02%', '41,82%'
];

test('FIX3-SVG: graph renders each node/edge label exactly once (no .gov ghost overlay)', () => {
  const html = runtime.renderCanvasInsiderGraph('BBCA');
  assert.ok(!html.includes('class="gov"'), 'no HTML ghost overlay container');
  assert.ok(!html.includes('class="glb'), 'no duplicate HTML overlay labels');
  assert.ok(!html.includes('govEdgeLabels') && !html.includes('govNodeLabels'), 'no overlay label builders');
  assert.equal((html.match(/<svg id="insiderNetworkSvg"/g) || []).length, 1, 'one SVG');
  assert.equal((html.match(/<\/svg>/g) || []).length, 1, 'one SVG close');
  // Count only VISIBLE <text> label content, not attribute strings such as
  // aria-label / onclick which legitimately repeat a ticker several times.
  const visibleText = (html.match(/<text[^>]*>[^<]*<\/text>/g) || []).join('|');
  for (const label of GHOST_LABELS) {
    const count = visibleText.split(label).length - 1;
    assert.ok(count <= 1, label + ' rendered as visible text ' + count + ' times (ghost/double text)');
  }
});

test('FIX3-SVG: percentages are sharp SVG <text> nodes, not HTML spans', () => {
  const html = runtime.renderCanvasInsiderGraph('BBCA');
  assert.match(html, /<text class="edge-text"/, 'edge percentages are SVG text');
  assert.ok(!/<span[^>]*>\s*0,0[12]%\s*<\/span>/.test(html), 'no HTML span ghost percentages');
  assert.ok(!/<span[^>]*>\s*41,82%\s*<\/span>/.test(html), 'no HTML span ghost 41,82%');
});

test('FIX3-UI: provenance labels name the canonical source and omit internal table names', () => {
  const container = { innerHTML: '' };
  runtime.renderInsiderNetworkUI(container, 'BBCA');
  const ui = container.innerHTML;
  assert.match(ui, /kepemilikan (?:&|&amp;) aktivitas insider|Keterbukaan Insider IDX/i, 'canonical source named cleanly');
  assert.ok(!/arjum_insiders/.test(ui), 'internal table name never leaks to UI');
  assert.match(ui, /data-v6-insider-source="true"/, 'source label marked for assertions');
  assert.match(ui, /tidak diketahui|unknown/i, 'unknown relationships marked honestly');
  assert.ok(!/Per 30 Sep 2026 · KSEI/.test(ui), 'stale KSEI-only provenance removed');
});

test('FIX3-DATA: canonical source is read-only when snapshot/DB exists', (t) => {
  const meta = canonical.getCanonicalInsiderMeta();
  if (!meta.db_path) {
    t.skip('No local canonical snapshot or market.sqlite in clean worktree');
    return;
  }
  assert.equal(meta.status, 'OK');
  assert.ok(meta.rows > 0, 'canonical row count positive');
  assert.ok(meta.issuers > 0, 'canonical issuer count positive');
  assert.match(meta.data_source, /Keterbukaan Insider IDX/, 'user-facing source named');
});

test('FIX3-DATA: every canonical record carries data_source and as_of; unknown stays unknown', (t) => {
  const meta = canonical.getCanonicalInsiderMeta();
  if (!meta.db_path) {
    t.skip('No local canonical snapshot or market.sqlite in clean worktree');
    return;
  }
  const rows = canonical.getCanonicalInsidersForTicker('BBCA');
  assert.ok(rows.length > 0, 'BBCA has canonical rows');
  for (const r of rows) {
    assert.ok(r.data_source && r.data_source.includes('Keterbukaan Insider IDX'), 'data_source present');
    assert.ok(r.as_of === null || /^\d{4}-\d{2}-\d{2}$/.test(r.as_of), 'as_of is a real date or null');
    assert.equal(r.ticker, 'BBCA');
  }
  const unknown = canonical.getCanonicalInsidersForTicker('ZZZZ');
  assert.deepEqual(unknown, [], 'unknown ticker yields no fabricated rows');
});

test('FIX3-API: served insider endpoints expose canonical metadata', () => {
  const src = read('api/sector-hot.js');
  assert.match(src, /canonical_source: canonicalMeta\.data_source/, 'network response carries source');
  assert.match(src, /canonical_as_of: canonicalMeta\.max_date/, 'network response carries as-of');
  assert.match(src, /getCanonicalInsidersForTicker\(ticker\)/, 'roster bound to canonical rows');
  assert.match(src, /roster_source: 'CANONICAL_ARJUM_INSIDERS'/, 'roster rows marked canonical');
  assert.ok(!/fetch\(['"]https?:\/\//.test(src.slice(src.indexOf('async function handleInsiderNetwork'), src.indexOf('async function handleInsiderNetwork') + 2500)),
    'no upstream HTTP in insider network handler');
});

test('FIX3-SOURCE: no DB writes in canonical source', () => {
  const src = read('lib/canonical-insider-source.js');
  assert.match(src, /readOnly: true/, 'read-only DB open');
  assert.match(src, /fileMustExist: true/, 'no DB creation');
  assert.ok(!/\bINSERT\b|\bUPDATE\b|\bDELETE\b|\.exec\(/.test(src), 'no write SQL');
  assert.ok(!/fetch\(|https?:\/\//.test(src), 'no HTTP calls');
});
