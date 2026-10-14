'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const partial = read('partials/analisis-saham.partial.html');
const publicPartial = read('public/partials/analisis-saham.partial.html');
const standalone = read('public/analisis-saham.html');
const indexHtml = read('public/index.html');
const runtime = read('public/analisis-saham-runtime.js');

test('Fase 3: Struktur Pasar layout eliminates duplicate titles and synchronizes templates', () => {
  // Verifying all 4 templates have the reconciled header and no duplicate title
  const files = [
    { name: 'partials/analisis-saham.partial.html', content: partial },
    { name: 'public/partials/analisis-saham.partial.html', content: publicPartial },
    { name: 'public/analisis-saham.html', content: standalone },
    { name: 'public/index.html', content: indexHtml }
  ];

  for (const f of files) {
    // Zero duplicate "STRUKTUR PASAR" screaming header in the panel head
    assert.ok(
      !f.content.includes('<h2 class="text-lg font-bold text-slate-100">STRUKTUR PASAR</h2>'),
      `Must not have redundant H2 in ${f.name}`
    );
    // Reconciled metadata subtitle present
    assert.match(
      f.content,
      /962 emiten terdaftar · 961 memiliki data pemegang saham &gt;5% \(7\.154 entitas teridentifikasi\) · Data resmi KSEI &amp; BEI/,
      `Missing reconciled metadata subtitle in ${f.name}`
    );
    // Table wrap and 8 columns present
    assert.match(f.content, /id="marketStructureTable"/, `Missing table in ${f.name}`);
    assert.match(f.content, /id="marketStructurePaginationBar"/, `Missing pagination bar in ${f.name}`);
    assert.match(f.content, /id="marketStructureCountText"/, `Missing count text in ${f.name}`);
    assert.match(f.content, /id="marketStructureGoToChartBtn"/, `Missing chart button in ${f.name}`);
    assert.match(f.content, /id="marketStructureOwnershipSummaryNote"/, `Missing ownership summary note in ${f.name}`);
    assert.match(f.content, /id="marketStructureMobileSheet"/, `Missing mobile sheet in ${f.name}`);
  }
});

test('Fase 3: Filter chip counts match real KSEI dataset invariants exactly', () => {
  const ownFile = path.join(ROOT, 'data', 'insider-network', 'ownership_30sep2026.json');
  assert.ok(fs.existsSync(ownFile), 'ownership_30sep2026.json must exist');
  const universe = JSON.parse(fs.readFileSync(ownFile, 'utf8'));

  // 1. Total universe count
  assert.equal(universe.length, 962, 'Total universe must be 962 emiten');

  // 2. Low Free Float count (<15%)
  const lowFf = universe.filter((r) => r.freeFloat != null && r.freeFloat < 15);
  assert.equal(lowFf.length, 551, 'Low free float (<15%) count must be 551');

  // 3. HSC Active count (fail-closed, 0 active in dataset)
  const hscActive = universe.filter((r) => r.hsc_flag === true);
  assert.equal(hscActive.length, 0, 'Active HSC count must be 0');

  // 4. Incomplete data count (reconciled: 961 Lengkap, 1 CNTX Belum Lengkap)
  const incomplete = universe.filter((r) => r.freeFloat == null || !Array.isArray(r.investors) || r.investors.length === 0 || r.market_structure_status === 'DATA_INCOMPLETE');
  assert.equal(incomplete.length, 1, 'Incomplete data count must be 1 (CNTX lacking reported KSEI investors)');

  // 5. Markup verification: chips have the exact numbers
  assert.match(partial, /id="marketStructureFilterAll"[^>]*>Semua \(962\)</);
  assert.match(partial, /id="marketStructureFilterLowFF"[^>]*>Free Float Rendah &lt;15% \(551\)</);
  assert.match(partial, /id="marketStructureFilterHsc"[^>]*>HSC Aktif \(0\)</);
  assert.match(partial, /id="marketStructureFilterIncomplete"[^>]*>Data Belum Lengkap \(1\)</);
});

test('Fase 3: 2-Way reverse search correctly discovers emitens by investor name', () => {
  const ownFile = path.join(ROOT, 'data', 'insider-network', 'ownership_30sep2026.json');
  const universe = JSON.parse(fs.readFileSync(ownFile, 'utf8'));

  function search(q) {
    const query = q.toLowerCase();
    return universe.filter((r) => {
      const t = (r.ticker || '').toLowerCase();
      const name = (r.name || '').toLowerCase();
      const sector = (r.sector || '').toLowerCase();
      if (t.includes(query) || name.includes(query) || sector.includes(query)) return true;
      if (Array.isArray(r.investors)) {
        return r.investors.some((inv) => {
          const invName = (inv.investorName || inv.name || '').toLowerCase();
          return invName.includes(query);
        });
      }
      return false;
    });
  }

  // Reverse search: DWIMURIA (Djarum Group)
  const dwimuria = search('DWIMURIA');
  assert.equal(dwimuria.length, 6, 'DWIMURIA should own shares in 6 emiten');
  const dwimuriaTickers = dwimuria.map((r) => r.ticker).sort();
  assert.deepEqual(dwimuriaTickers, ['BBCA', 'BELI', 'HEAL', 'SSIA', 'TOWR', 'WOOD']);

  // Reverse search: Boy Thohir / Garibaldi Thohir
  const thohir = search('THOHIR');
  assert.equal(thohir.length, 10, 'THOHIR should own shares in 10 emiten');
  assert.ok(thohir.some((r) => r.ticker === 'ADRO'));
  assert.ok(thohir.some((r) => r.ticker === 'MDKA'));

  // Reverse search: Sandiaga Uno
  const sandiaga = search('SANDIAGA');
  assert.equal(sandiaga.length, 3, 'SANDIAGA should own shares in 3 emiten');
  const sandiagaTickers = sandiaga.map((r) => r.ticker).sort();
  assert.deepEqual(sandiagaTickers, ['AADI', 'ADRO', 'SRTG']);

  // Reverse search: Salim Group
  const salim = search('Salim');
  assert.equal(salim.length, 22, 'Salim should own shares in 22 emiten');
});

test('Fase 3: HSC fail-closed safety formatting invariants', () => {
  // Verify formatHscStatus handles null and missing safely
  assert.match(runtime, /function formatHscStatus\(flag, asOf\)/);
  assert.match(runtime, /return 'Belum Terverifikasi';/);
  // Never coerce unknown HSC to 'Bebas HSC' or 'Aman'
  assert.ok(!runtime.includes("return 'Bebas HSC';"), 'Must never return Bebas HSC');
});

test('Fase 3: Zero em dash in Struktur Pasar section and rendered outputs', () => {
  // Check partials have zero em dash in market structure section
  const start = partial.indexOf('id="panel-tab-market-structure"');
  const end = partial.indexOf('</section>', start + 50);
  const snippet = partial.slice(start, end);
  assert.ok(!snippet.includes('—'), 'No em dash in partial market structure section');
  assert.ok(!snippet.includes('–'), 'No en dash in partial market structure section');
});

test('Fase 3: Mobile bottom sheet and touch targets meet accessibility standards', () => {
  // Close button minimum 44x44px touch target
  assert.match(partial, /id="marketStructureSheetClose"[^>]*min-w-\[44px\] min-h-\[44px\]/);
  // Sticky header and sticky Kode column for tablet/desktop
  assert.match(partial, /sticky top-0/);
  assert.match(partial, /sticky left-0/);
});

test('Fase 3 Remediation: Invariants for CNTX, Mobile Cards, Empty State Reset, and Indonesian UI', () => {
  // 1. CNTX missing free float must display 'Belum Terverifikasi', never 100% or 0%
  assert.match(runtime, /hasFf \? Number\(row\.free_float_pct\)\.toFixed\(2\) \+ '%' : 'Belum Terverifikasi'/);

  // 2. Empty state reset button exists with >=44px touch target
  assert.match(partial, /id="marketStructureResetFilterBtn"[^>]*min-h-\[44px\]/);
  assert.match(partial, /Reset Filter/);

  // 3. Mobile cards view container exists in templates
  assert.match(partial, /id="marketStructureCardsContainer"/);

  // 4. Sector select options in Indonesian
  assert.match(partial, /<option value="Keuangan">Keuangan<\/option>/);
  assert.match(partial, /<option value="Barang Baku">Barang Baku<\/option>/);
  assert.match(partial, /<option value="Infrastruktur">Infrastruktur<\/option>/);

  // 5. Status Risiko label (translated from RISK GUARD)
  assert.match(partial, /<span>Status Risiko<\/span>/);
});
