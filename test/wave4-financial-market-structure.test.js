'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const partial = read('public/partials/analisis-saham.partial.html');
const runtime = read('public/analisis-saham-runtime.js');
const css = read('public/ui-theme.css');

test('Wave 4: Financial panel implements verified snapshot and strict data truth', () => {
  // Bounded container and header
  assert.match(partial, /class="[^"]*ac-financial-container[^"]*"/);
  assert.match(partial, /class="[^"]*ac-financial-header[^"]*"/);
  assert.match(partial, /class="[^"]*ac-financial-title[^"]*"/);
  assert.match(partial, /class="[^"]*ac-financial-subtitle[^"]*"/);

  // Compact metric strip: PBV, BVPS, Market Cap, Saham Beredar
  assert.match(partial, /id="financialPbv"/);
  assert.match(partial, /id="financialBvps"/);
  assert.match(partial, /id="financialMarketCap"/);
  assert.match(partial, /id="financialShares"/);
  assert.match(partial, /class="[^"]*ac-financial-metric-strip[^"]*"/);

  // Tabular lining numerals applied
  assert.match(css, /\.ac-financial-metric-num\s*\{[^}]*tabular-nums lining-nums/);

  // Wave 3 provenance row and trust note
  assert.match(partial, /id="financialPeriod"/);
  assert.match(partial, /id="financialSource"/);
  assert.match(partial, /id="financialMarketCapSource"/);
  assert.match(partial, /id="financialUpdatedAt"/);
  assert.match(partial, /class="[^"]*ac-financial-note[^"]*"/);

  // Single compact unavailable state
  assert.match(partial, /id="financialDataUnavailable"/);
  assert.match(partial, /id="financialUnavailableTitle"/);
  assert.match(partial, /id="financialUnavailableDesc"/);
});

test('Wave 4: Financial runtime strictly enforces data truth, formatting, and snapshot caching', () => {
  // Indonesian date formatter with WIB
  assert.match(runtime, /function formatIndonesianDateWithWib/);
  assert.match(runtime, /WIB/);

  // Explicit share unit wording and compact market cap (Wave 4B §3)
  assert.match(runtime, /function formatIndonesianSharesCount/);
  assert.match(runtime, /miliar lembar/);
  assert.match(runtime, /formatIndonesianSharesCount\(f\.shares_outstanding\)/);
  assert.match(runtime, /function formatIndonesianMarketCap/);
  assert.match(runtime, /formatIndonesianMarketCap\(f\.market_cap\)/);

  // Single compact unavailable state triggered when all 4 are missing
  assert.match(runtime, /if\s*\(coverageCount === 0\)\s*\{/);
  assert.match(runtime, /if\s*\(unavailable\)\s*unavailable\.hidden = false;/);

  // Missing values remain '—', never 0 or 0.00
  assert.match(runtime, /hasPbv \? researchNumber\(f\.pbv, 2\) \+ 'x' : '—'/);
  assert.match(runtime, /hasBvps \? researchIdr\(f\.book_value_per_share\) : '—'/);

  // Last valid snapshot caching and retention on failure
  assert.match(runtime, /financialSnapshotCache\[ticker\] =/);
  assert.match(runtime, /if \(isFinancial && financialSnapshotCache\[ticker\]\)/);
});

test('Wave 4B: Detailed financial statements workstation contract', () => {
  // Level-2 Local Statement Mode Tabs (Laba Rugi, Neraca, Arus Kas, Rasio)
  assert.match(partial, /id="financialStatementModeGroup"/);
  assert.match(partial, /data-statement-mode="income"/);
  assert.match(partial, /data-statement-mode="balance"/);
  assert.match(partial, /data-statement-mode="cashflow"/);
  assert.match(partial, /data-statement-mode="ratios"/);

  // Local Period Mode Toggle (Kuartalan / Tahunan)
  assert.match(partial, /id="financialPeriodModeGroup"/);
  assert.match(partial, /data-period-mode="quarterly"/);
  assert.match(partial, /data-period-mode="annual"/);

  // Workstation Table Container & Elements
  assert.match(partial, /id="financialStatementsTableWrap"/);
  assert.match(partial, /id="financialStatementsTable"/);
  assert.match(partial, /id="financialStatementsTableHead"/);
  assert.match(partial, /id="financialStatementsTableBody"/);

  // Single compact unavailable state inside statement mode
  assert.match(partial, /id="financialStatementUnavailable"/);
  assert.match(partial, /id="financialStatementUnavailableTitle"/);
  assert.match(partial, /id="financialStatementUnavailableDesc"/);

  // Workstation Table CSS: Sticky first column & sticky header
  assert.match(css, /\.ac-table--financial thead th\s*\{[^}]*position:\s*sticky;\s*top:\s*0;/);
  assert.match(css, /\.ac-table--financial thead th:first-child\s*\{[^}]*position:\s*sticky;\s*left:\s*0;/);
  assert.match(css, /\.ac-table--financial td:first-child\s*\{[^}]*position:\s*sticky;\s*left:\s*0;/);
  assert.match(css, /\.ac-table--financial\s*td\s*\{[^}]*tabular-nums lining-nums/);

  // Semantic value restraint: negative red, no global green for ordinary numbers
  assert.match(css, /\.ac-fin-negative\s*\{[^}]*color:\s*var\(--ac-negative/);

  // Runtime Controller: AutoCuanFinancialStatements
  assert.match(runtime, /var AutoCuanFinancialStatements =/);
  assert.match(runtime, /root\.AutoCuanFinancialStatements = AutoCuanFinancialStatements/);
  assert.match(runtime, /setStatementMode:\s*function/);
  assert.match(runtime, /setPeriodMode:\s*function/);
  assert.match(runtime, /loadStatements:\s*function/);
  assert.match(runtime, /normalizeStatements:\s*function/);
  assert.match(runtime, /renderTable:\s*function/);
});

test('Wave 4: Struktur Pasar implements list-first universe architecture', () => {
  // Universe search input, filter buttons, sort dropdown
  assert.match(partial, /id="marketStructureSearchInput"/);
  assert.match(partial, /id="marketStructureFilterGroup"/);
  assert.match(partial, /data-filter="all"/);
  assert.match(partial, /data-filter="low_ff"/);
  assert.match(partial, /data-filter="hsc"/);
  assert.match(partial, /data-filter="incomplete"/);
  assert.match(partial, /id="marketStructureSortSelect"/);

  // Universe table with required column headers
  assert.match(partial, /id="marketStructureTable"/);
  assert.match(partial, /<th[^>]*>TICKER<\/th>/i);
  assert.match(partial, /<th[^>]*>FREE FLOAT<\/th>/i);
  assert.match(partial, /<th[^>]*>STATUS HSC<\/th>/i);
  assert.match(partial, /<th[^>]*>STATUS STRUKTUR<\/th>/i);
  assert.match(partial, /<th[^>]*>PER TANGGAL<\/th>/i);

  // Split-view layout: desktop pane (320-380px) and mobile sheet overlay
  assert.match(partial, /id="marketStructureDetailPane"/);
  assert.match(partial, /id="marketStructureMobileSheet"/);
  assert.match(partial, /id="marketStructureSheetBackdrop"/);
  assert.match(partial, /id="marketStructureSheetCloseBtn"/);
  assert.match(css, /clamp\(320px,\s*25vw,\s*380px\)/);
});

test('Wave 4B: Struktur Pasar eliminates user-visible raw screaming enums', () => {
  // Clean Indonesian enum formatters in runtime
  assert.match(runtime, /function formatMarketStructureStatus/);
  assert.match(runtime, /Struktur Terverifikasi/);
  assert.match(runtime, /Konsentrasi Kepemilikan Tinggi/);
  assert.match(runtime, /Free Float Rendah/);
  assert.match(runtime, /Data Belum Lengkap/);
  assert.match(runtime, /function formatMarketStructureGuard/);
  assert.match(runtime, /function formatComplianceStatus/);
  assert.match(runtime, /function formatHscStatus/);

  // 'Tidak Flagged' replaced with precise 'Tidak Terindikasi HSC'
  assert.match(runtime, /Tidak Terindikasi HSC/);
  assert.doesNotMatch(runtime, /Bebas Indikasi/);

  // Raw enum markup placeholders replaced
  assert.doesNotMatch(partial, />UNKNOWN</);
  assert.doesNotMatch(partial, />NOT_EVALUATED</);
});

test('Wave 4C: Mobile statement matrix sticky contract, active states, and copy precision', () => {
  // Mobile statement matrix inner scroll only & containment
  assert.match(css, /\.ac-fin-table-scroll-container\s*\{[^}]*position:\s*relative;/);
  assert.match(css, /\.ac-fin-table-wrap\s*\{[^}]*overflow-x:\s*auto;/);
  assert.match(css, /\.ac-fin-scroll-hint/);
  assert.match(partial, /id="financialScrollHint"/);
  assert.match(runtime, /wrap\.addEventListener\('scroll'/);
  assert.match(runtime, /hint\.classList\.add\('is-scrolled'\)/);

  // Sticky first column and group label sticky contract
  assert.match(css, /\.ac-table--financial thead th:first-child\s*\{[^}]*position:\s*sticky;\s*left:\s*0;\s*top:\s*0;\s*z-index:\s*4;/);
  assert.match(css, /\.ac-table--financial td:first-child\s*\{[^}]*position:\s*sticky;\s*left:\s*0;/);
  assert.match(css, /\.ac-table--financial \.ac-fin-group-label-sticky\s*\{[^}]*position:\s*sticky;[^}]*left:\s*0;[^}]*z-index:\s*3;/);
  assert.match(runtime, /stickyDiv\.className = 'ac-fin-group-label-sticky'/);

  // Active statement mode semantics: aria-selected="true", tabindex="0", is-active
  assert.match(partial, /class="[^"]*ac-fin-tab-btn is-active[^"]*"/);
  assert.match(partial, /aria-selected="true"/);
  assert.match(runtime, /btn\.setAttribute\('aria-selected',\s*'true'\)/);
  assert.match(runtime, /btn\.setAttribute\('tabindex',\s*'0'\)/);
  assert.match(runtime, /btn\.setAttribute\('tabindex',\s*'-1'\)/);

  // Active period mode semantics: aria-pressed="true", is-active
  assert.match(partial, /class="[^"]*ac-fin-period-btn is-active[^"]*"/);
  assert.match(partial, /aria-pressed="true"/);
  assert.match(runtime, /btn\.setAttribute\('aria-pressed',\s*'true'\)/);

  // Financial Indonesian-first copy
  assert.match(partial, /Nilai Buku \/ Saham \(BVPS\)/);
  assert.match(partial, /Kapitalisasi Pasar/);
  assert.doesNotMatch(partial, /Book Value \/ Share/);
  assert.doesNotMatch(partial, /<span[^>]*>Market Cap<\/span>/);
  assert.doesNotMatch(runtime, /'As of '\s*\+\s*formatIndonesianDateWithWib/);
  assert.match(runtime, /'Per '\s*\+\s*formatIndonesianDateWithWib/);

  // Struktur Pasar copy precision: 'Tidak Terindikasi HSC', no user-facing 'Bebas Indikasi'
  assert.match(runtime, /Tidak Terindikasi HSC/);
  assert.doesNotMatch(runtime, /Bebas Indikasi/);
  assert.doesNotMatch(partial, /Bebas Indikasi/);
});

test('Wave 4: AutoCuanMarketStructure controller enforces filter and sort semantic invariants', () => {
  assert.match(runtime, /var AutoCuanMarketStructure =/);
  assert.match(runtime, /root\.AutoCuanMarketStructure = AutoCuanMarketStructure/);

  // Invariant 1: FF <15% strictly excludes nulls
  assert.match(runtime, /f === 'low_ff'/);
  assert.match(runtime, /r\.free_float_pct != null && Number\.isFinite\(Number\(r\.free_float_pct\)\) && Number\(r\.free_float_pct\) < 15/);

  // Invariant 2: HSC Aktif requires explicit true
  assert.match(runtime, /f === 'hsc'/);
  assert.match(runtime, /r\.hsc_flag === true/);

  // Invariant 3: Incomplete data catches missing FF or HSC or DATA_INCOMPLETE
  assert.match(runtime, /f === 'incomplete'/);
  assert.match(runtime, /r\.free_float_pct == null/);
  assert.match(runtime, /r\.hsc_flag == null/);
  assert.match(runtime, /r\.market_structure_status === 'DATA_INCOMPLETE'/);

  // Invariant 4: Missing numeric values sort at the end, never coerced to 0
  assert.match(runtime, /if \(!aHas && !bHas\) return 0;/);
  assert.match(runtime, /if \(!aHas\) return 1;/);
  assert.match(runtime, /if \(!bHas\) return -1;/);

  // Invariant 5: Sheet close restores keyboard focus
  assert.match(runtime, /if \(this\.lastSelectedRowEl && typeof this\.lastSelectedRowEl\.focus === 'function'\)/);
});

