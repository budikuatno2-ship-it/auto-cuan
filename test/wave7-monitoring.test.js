'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf8');
const uiThemeCss = fs.readFileSync(path.join(rootDir, 'public', 'ui-theme.css'), 'utf8');
const watchlistRuntime = fs.readFileSync(path.join(rootDir, 'public', 'watchlist-runtime.js'), 'utf8');
const trackRecordRuntime = fs.readFileSync(path.join(rootDir, 'public', 'track-record-runtime.js'), 'utf8');
const portfolioJs = fs.readFileSync(path.join(rootDir, 'public', 'portfolio-command-center.js'), 'utf8');
const portfolioCss = fs.readFileSync(path.join(rootDir, 'public', 'portfolio-command-center.css'), 'utf8');
const portfolioScopedCss = fs.readFileSync(path.join(rootDir, 'public', 'portfolio-spa-scoped.css'), 'utf8');

// ============================================================
// 1. WATCHLIST CONTRACT (DESIGN.md §76.7, §76.9, §82)
// ============================================================

test('Watchlist: #page-watchlist carries data-ac-ui="v2"', () => {
  assert.match(indexHtml, /<div\s+id="page-watchlist"[^>]*data-ac-ui="v2"/);
});

test('Watchlist: Header adopts workstation page-header with Lensa Monitor provenance row', () => {
  assert.match(indexHtml, /id="page-watchlist"[\s\S]*?<div class="page-header/);
  assert.match(indexHtml, /Lensa Monitor:[\s\S]*?Watchlist &amp; Alert Pribadi/);
  assert.match(indexHtml, /<h1 class="page-title[^>]*>Watchlist<\/h1>/);
});

test('Watchlist: Summary metrics use continuous .ac-metric-strip instead of card grid', () => {
  assert.match(indexHtml, /<div class="ac-metric-strip[^"]*" id="watchlistSummaryStrip">/);
  assert.match(indexHtml, /id="wlTotalCount"/);
  assert.match(indexHtml, /id="wlActiveAlertCount"/);
});

test('Watchlist: Empty state title strictly matches "Belum ada saham dalam Watchlist."', () => {
  assert.match(indexHtml, /<p class="font-semibold[^>]*id="watchlistEmptyTitle">Belum ada saham dalam Watchlist\.<\/p>/);
  assert.match(watchlistRuntime, /emptyTitle\.textContent = 'Belum ada saham dalam Watchlist\.'/,
    'watchlist-runtime.js must set canonical empty state text');
});

test('Watchlist Runtime: Table-first layout with index column and tabular numerals', () => {
  assert.match(watchlistRuntime, /<th[^>]*>#<\/th>/);
  assert.match(watchlistRuntime, /<th[^>]*>Ticker &amp; Catatan<\/th>/);
  assert.match(watchlistRuntime, /<th[^>]*>Harga<\/th>/);
  assert.match(watchlistRuntime, /<th[^>]*>Perubahan<\/th>/);
  assert.match(watchlistRuntime, /<th[^>]*>Alert Aktif<\/th>/);
  assert.match(watchlistRuntime, /tabular-nums lining-nums/);
});

test('Watchlist Runtime: Alert condition mapping normalizes PRICE_ABOVE and PRICE_BELOW without undefined', () => {
  assert.match(watchlistRuntime, /var cond = String\(a\.condition_type \|\| a\.condition \|\| ''\)\.toUpperCase\(\)/);
  assert.match(watchlistRuntime, /cond === 'PRICE_ABOVE' \|\| cond === 'ABOVE'/);
  assert.match(watchlistRuntime, /cond === 'PRICE_BELOW' \|\| cond === 'BELOW'/);
});

test('Watchlist Runtime: Ticker clicking routes to research analysis', () => {
  assert.match(watchlistRuntime, /navigateTo\(\\'analisis\\',null/);
});

// ============================================================
// 2. PORTFOLIO WORKSTATION CONTRACT (DESIGN.md §28–§32, §82)
// ============================================================

test('Portfolio: Command Center template renders workstation page-header', () => {
  assert.match(indexHtml, /<template id="tpl-portfolio-command-center">[\s\S]*?<div class="page-header/);
  assert.match(indexHtml, /Portfolio Command Center/);
});

test('Portfolio Runtime: Holdings table includes pnlClass and tabular numerals', () => {
  assert.match(portfolioJs, /pnlClass/);
  assert.match(portfolioJs, /tabular-nums lining-nums/);
});

test('Portfolio Runtime: Character encoding is clean (no corrupted utf-8 bullet artifacts)', () => {
  assert.doesNotMatch(portfolioJs, /Â·/, 'portfolio-command-center.js must not contain corrupted Â· characters');
  assert.doesNotMatch(portfolioCss, /Â·/, 'portfolio-command-center.css must not contain corrupted Â· characters');
});

test('Portfolio CSS: Light mode WCAG AA contrast rules defined for cockpit cards', () => {
  assert.match(portfolioCss, /(?:html\.light|\[data-theme="light"\])\s+\.empty-portfolio-cta/);
  assert.match(portfolioCss, /(?:html\.light|\[data-theme="light"\])\s+\.posture/);
  assert.match(portfolioCss, /(?:html\.light|\[data-theme="light"\])\s+\.decision-hero/);
  assert.match(portfolioCss, /(?:html\.light|\[data-theme="light"\])\s+\.action-item/);
});

test('Portfolio Scoped CSS: Recompiled stylesheet matches source without drifts', () => {
  assert.match(portfolioScopedCss, /#portofolioPartialMount/);
  assert.match(portfolioScopedCss, /empty-portfolio-cta/);
});

// ============================================================
// 3. TRACK RECORD AUDIT LEDGER CONTRACT (DESIGN.md §76.7, §82)
// ============================================================

test('Track Record: #page-trackrecord carries data-ac-ui="v2"', () => {
  assert.match(indexHtml, /<div\s+id="page-trackrecord"[^>]*data-ac-ui="v2"/);
});

test('Track Record: Workstation header states system signal audit lens and rule-based evaluation', () => {
  assert.match(indexHtml, /id="page-trackrecord"[\s\S]*?<div class="page-header/);
  assert.match(indexHtml, /Lensa Audit:[\s\S]*?Audit Sinyal Sistem/);
  assert.match(indexHtml, /Metode:[\s\S]*?Evaluasi Berbasis Aturan/);
  assert.match(indexHtml, /<h1 class="page-title[^>]*>Track Record<\/h1>/);
});

test('Track Record: Continuous audit metric strip replaces marketing KPI card grid', () => {
  assert.match(indexHtml, /<div class="ac-metric-strip"\s+id="trackRecordSummaryGrid">/);
  assert.match(indexHtml, /id="trTotalSignals"/);
  assert.match(indexHtml, /id="trWinRateTp1"/);
  assert.match(indexHtml, /id="trWinRateTp2"/);
  assert.match(indexHtml, /id="trSlRate"/);
  assert.match(indexHtml, /id="trBestGain"/);
});

test('Track Record: Denominator and resolution subtext elements preserved', () => {
  assert.match(indexHtml, /id="trTotalSignalsSub"/);
  assert.match(indexHtml, /id="trTp1HitsSub"/);
  assert.match(indexHtml, /id="trTp2HitsSub"/);
  assert.match(indexHtml, /id="trSlHitsSub"/);
  assert.match(indexHtml, /id="trBestGainSub"/);
});

test('Track Record Runtime: Category breakdown cards safely handle sl_rate and win_rate_tp1', () => {
  assert.match(trackRecordRuntime, /var wrTp1Text = c\.win_rate_tp1 != null \? c\.win_rate_tp1/);
  assert.match(trackRecordRuntime, /var slRateText = c\.sl_rate != null \? c\.sl_rate/);
  assert.match(trackRecordRuntime, /tabular-nums lining-nums/);
});

test('Track Record Runtime: Table row rendering applies canonical tokens, lining numerals, and analysis link', () => {
  assert.match(trackRecordRuntime, /sticky left-0 bg-\[var\(--ac-surface,#181d28\)\]/);
  assert.match(trackRecordRuntime, /navigateTo\(\\'analisis\\',null/);
  assert.match(trackRecordRuntime, /tabular-nums lining-nums/);
});

// ============================================================
// 4. FROZEN SHELL CONTRACT PRESERVATION (WAVES 1–6)
// ============================================================

test('Shell Preservation: Direct sidebar direct links without category headings preserved', () => {
  assert.doesNotMatch(indexHtml, /<div class="sidebar-category">OVERVIEW<\/div>/i);
  assert.doesNotMatch(indexHtml, /<div class="sidebar-category">RESEARCH<\/div>/i);
  assert.doesNotMatch(indexHtml, /<div class="sidebar-category">MONITOR<\/div>/i);
  assert.match(indexHtml, /data-sidebar-page="watchlist"/);
  assert.match(indexHtml, /data-sidebar-page="portofolio"/);
  assert.match(indexHtml, /data-sidebar-page="trackrecord"/);
});

test('Shell Preservation: Account center button lives in sidebar footer for desktop only', () => {
  assert.match(indexHtml, /<div class="sidebar-footer"[\s\S]*?openAccountProfile/);
});

// ============================================================
// 5. WAVE 7C LIFECYCLE STATES & THEME CONTRAST ASSURANCES
// ============================================================

test('Portfolio Theme Tokens: :root bridges to canonical --ac-* workstation tokens', () => {
  assert.match(portfolioCss, /:root\{[^}]*--bg:var\(--ac-canvas/);
  assert.match(portfolioCss, /:root\{[^}]*--surface:var\(--ac-surface/);
  assert.match(portfolioCss, /:root\{[^}]*--surface2:var\(--ac-surface-raised/);
  assert.match(portfolioCss, /:root\{[^}]*--text:var\(--ac-ink/);
  assert.match(portfolioCss, /:root\{[^}]*--strong:var\(--ac-ink/);
  assert.match(portfolioCss, /:root\{[^}]*--muted:var\(--ac-text-secondary/);
});

test('Portfolio Empty State: Component declaration uses canonical --surface2 token without hardcoded dark rgb/rgba', () => {
  assert.match(portfolioCss, /\.empty-portfolio-cta\s*\{[\s\S]*?background:\s*var\(--surface2\)/);
  assert.doesNotMatch(portfolioCss, /\.empty-portfolio-cta\s*\{[\s\S]*?background:\s*rgba\(7,\s*13,\s*22/);
});

test('Portfolio Empty State: Light mode defines high-contrast text and clean raised surface', () => {
  assert.match(portfolioCss, /(?:html\.light|\[data-theme="light"\])\s+\.empty-portfolio-cta\s*\{[^}]*background:\s*#f7f9f8/);
  assert.match(portfolioCss, /(?:html\.light|\[data-theme="light"\])\s+\.empty-portfolio-cta h3\s*\{[^}]*color:\s*#17211e/);
  assert.match(portfolioCss, /(?:html\.light|\[data-theme="light"\])\s+\.empty-portfolio-cta p\s*\{[^}]*color:\s*#52605b/);
});

test('Portfolio Lifecycle States: Notes, errors, empty messages and buttons pass WCAG AA contrast rules', () => {
  assert.match(portfolioCss, /(?:html\.light|\[data-theme="light"\])\s+\.empty\s*\{[^}]*color:\s*#52605b/);
  assert.match(portfolioCss, /(?:html\.light|\[data-theme="light"\])\s+\.note\s*\{[^}]*color:\s*#1e40af/);
  assert.match(portfolioCss, /(?:html\.light|\[data-theme="light"\])\s+\.error\s*\{[^}]*color:\s*#b91c1c/);
  assert.match(portfolioCss, /(?:html\.light|\[data-theme="light"\])\s+\.success\s*\{[^}]*color:\s*#047857/);
  assert.match(portfolioCss, /(?:html\.light|\[data-theme="light"\])\s+\.btn\s*\{[^}]*color:\s*#17211e/);
  assert.match(portfolioCss, /(?:html\.light|\[data-theme="light"\])\s+\.btn\.primary\s*\{[^}]*color:\s*#ffffff/);
});

test('Watchlist Lifecycle States: Table change colors, status badges, and actions use canonical semantic variables', () => {
  assert.match(watchlistRuntime, /var chgColor = chg != null \? \(chg > 0 \? 'var\(--ac-gain,#10b981\)' : \(chg < 0 \? 'var\(--ac-loss,#ef4444\)'/);
  assert.match(watchlistRuntime, /text-\[var\(--ac-loss,#dc2626\)\]/);
  assert.match(watchlistRuntime, /bg-\[var\(--ac-gain,#059669\)\]\/15/);
});

test('Track Record Lifecycle States: Errors and audit status tones adapt to current theme', () => {
  assert.match(trackRecordRuntime, /text-\[var\(--ac-loss,#dc2626\)\]/);
  assert.match(trackRecordRuntime, /var statusTone = s\.status_tone \|\| \(outcome\.indexOf\('TP'\) !== -1 \? 'var\(--ac-gain,#10b981\)'/);
  assert.match(trackRecordRuntime, /outcome === 'SL_HIT' \? 'var\(--ac-loss,#ef4444\)'/);
  assert.match(trackRecordRuntime, /outcome === 'WAITING' \? 'var\(--ac-amber,#d97706\)'/);
});

test('Missing Data Guarantees: No undefined, null, or NaN leaked in runtime outputs', () => {
  assert.match(watchlistRuntime, /var last = item\.last_price \? Number\(item\.last_price\)\.toLocaleString\('id-ID'\) : '—'/);
  assert.match(trackRecordRuntime, /var sourceText = s\.source_short \|\| s\.source \|\| s\.category \|\| '—'/);
  assert.doesNotMatch(trackRecordRuntime, />undefined</);
  assert.doesNotMatch(watchlistRuntime, />undefined</);
});
