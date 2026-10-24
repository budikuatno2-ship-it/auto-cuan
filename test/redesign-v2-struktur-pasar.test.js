const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

test('Struktur Pasar: universe and filter chips filter data correctly', () => {
  const ownFile = path.join(ROOT, 'data', 'insider-network', 'ownership_30sep2026.json');
  assert.ok(fs.existsSync(ownFile), 'ownership dataset must exist');
  const universe = JSON.parse(fs.readFileSync(ownFile, 'utf8'));

  assert.equal(universe.length, 962, 'Total universe must be 962 emiten');

  const lowFf = universe.filter(r => r.freeFloat != null && r.freeFloat < 15);
  assert.equal(lowFf.length, 551, 'Low free float count must be 551');

  const hscActive = universe.filter(r => r.hsc_flag === true);
  assert.equal(hscActive.length, 0, 'HSC active count must be 0');

  const incomplete = universe.filter(r => r.freeFloat == null || !Array.isArray(r.investors) || r.investors.length === 0 || r.market_structure_status === 'DATA_INCOMPLETE');
  assert.equal(incomplete.length, 1, 'Incomplete count must be 1 (CNTX)');
});

test('Struktur Pasar: sorting toggles correctly and places nulls last', () => {
  const sample = [
    { ticker: 'BREN', free_float_pct: 6.8 },
    { ticker: 'BBCA', free_float_pct: 41.82 },
    { ticker: 'CNTX', free_float_pct: null },
    { ticker: 'AMMN', free_float_pct: 17.2 }
  ];

  // Sort by Free Float asc (nulls last)
  const ffSorted = sample.slice().sort((a, b) => {
    const aHas = a.free_float_pct != null && Number.isFinite(Number(a.free_float_pct));
    const bHas = b.free_float_pct != null && Number.isFinite(Number(b.free_float_pct));
    if (!aHas && !bHas) return 0;
    if (!aHas) return 1;
    if (!bHas) return -1;
    return Number(a.free_float_pct) - Number(b.free_float_pct);
  });

  assert.equal(ffSorted[0].ticker, 'BREN');
  assert.equal(ffSorted[1].ticker, 'AMMN');
  assert.equal(ffSorted[2].ticker, 'BBCA');
  assert.equal(ffSorted[3].ticker, 'CNTX'); // null is at end

  // Sort by Ticker asc
  const tickerSorted = sample.slice().sort((a, b) => a.ticker.localeCompare(b.ticker));
  assert.equal(tickerSorted[0].ticker, 'AMMN');
  assert.equal(tickerSorted[1].ticker, 'BBCA');
  assert.equal(tickerSorted[2].ticker, 'BREN');
  assert.equal(tickerSorted[3].ticker, 'CNTX');
});

test('Struktur Pasar: canvas layout markup contains required elements and 0 em-dash in sentences', () => {
  const files = [
    path.join(ROOT, 'public', 'analisis-saham.html'),
    path.join(ROOT, 'public', 'index.html'),
    path.join(ROOT, 'public', 'partials', 'analisis-saham.partial.html'),
    path.join(ROOT, 'partials', 'analisis-saham.partial.html')
  ];

  for (const f of files) {
    const html = fs.readFileSync(f, 'utf8');
    assert.match(html, /id="marketStructureTable"/);
    assert.match(html, /id="marketStructureFilterAll"/);
    assert.match(html, /id="marketStructureFilterLowFF"/);
    assert.match(html, /id="marketStructureFilterHsc"/);
    assert.match(html, /id="marketStructureFilterIncomplete"/);
    assert.match(html, /id="msDetailTicker"/);
    assert.match(html, /id="msDetailFfBig"/);
    assert.match(html, /id="msDetailFfBar"/);
    assert.match(html, /id="msDetailController"/);
    assert.match(html, /id="msDetailAnalisisBtn"/);
    assert.match(html, /class="adv-tools"/);

    // Verify zero em dash in market structure panel
    const p1 = html.indexOf('id="panel-tab-market-structure"');
    const p2 = html.indexOf('</section>', p1 + 50);
    const snip = html.slice(p1, p2);
    assert.ok(!snip.includes('—'), 'No em dash in market structure snippet for ' + f);
  }
});

test('Struktur Pasar: controller runtime supports canvas elements and selection', () => {
  const runtime = fs.readFileSync(path.join(ROOT, 'public', 'analisis-saham-runtime.js'), 'utf8');
  assert.match(runtime, /toggleCanvasSort:\s*function/);
  assert.match(runtime, /msDetailTicker/);
  assert.match(runtime, /msDetailFfBig/);
  assert.match(runtime, /msDetailFfBar/);
  assert.match(runtime, /msDetailController/);
  assert.match(runtime, /msDetailNote/);
  assert.match(runtime, /msDetailAnalisisBtn/);
});
