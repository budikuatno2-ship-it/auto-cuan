'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'landing-experience.css'), 'utf8');
const runtime = fs.readFileSync(path.join(ROOT, 'public', 'landing-experience.js'), 'utf8');

// Isolate the landing page slice
const landingStart = html.indexOf('<section id="landingPage"');
const landingEnd = html.indexOf('<!-- AUTH CHOICE MODAL -->');
const landingHtml = html.slice(landingStart, landingEnd);

test('Wave 9: landing page follows canonical story order (Market -> Scan -> Investigate -> Validate -> Ask AI -> Monitor)', () => {
  const heroIdx = landingHtml.indexOf('class="landing-hero');
  const marketIdx = landingHtml.indexOf('id="landingMarket"');
  const scanIdx = landingHtml.indexOf('id="landingScan"');
  const investigateIdx = landingHtml.indexOf('id="landingInvestigate"');
  const validateIdx = landingHtml.indexOf('id="landingValidate"');
  const aiIdx = landingHtml.indexOf('id="landingAi"');
  const monitorIdx = landingHtml.indexOf('id="landingMonitor"');
  const trustIdx = landingHtml.indexOf('id="landingTrust"');
  const closingIdx = landingHtml.indexOf('class="landing-section landing-closing"');

  assert.ok(heroIdx > -1, 'Hero section must exist');
  assert.ok(marketIdx > heroIdx, 'Market context must follow Hero');
  assert.ok(scanIdx > marketIdx, 'Scan screener must follow Market');
  assert.ok(investigateIdx > scanIdx, 'Investigate must follow Scan');
  assert.ok(validateIdx > investigateIdx, 'Validate must follow Investigate');
  assert.ok(aiIdx > validateIdx, 'Ask AI must follow Validate');
  assert.ok(monitorIdx > aiIdx, 'Monitor must follow Ask AI');
  assert.ok(trustIdx > monitorIdx, 'Data Trust must follow Monitor');
  assert.ok(closingIdx > trustIdx, 'Closing CTA must follow Data Trust');
});

test('Wave 9: Hero contains canonical heading, restrained Signal Line, and truthful workstation preview', () => {
  // Canonical heading required by DESIGN.md and existing a11y tests
  assert.match(landingHtml, /<h1 id="landingTitle">Baca pasar\.<br>Susun rencana\.<br><span>Jaga konteks\.<\/span><\/h1>/);

  // Auto-Cuan Signal Line motif (§104)
  assert.match(landingHtml, /class="landing-signal-line-wrap"/);
  assert.match(landingHtml, /<svg class="landing-signal-line"/);

  // Grounded workstation preview with provenance label
  assert.match(landingHtml, /class="landing-workstation-preview"/);
  assert.match(landingHtml, /DATA CONTOH MEJA KERJA/);
  assert.match(landingHtml, /Pratinjau statis komponen antarmuka Auto-Cuan/);
  assert.match(landingHtml, /Bukan harga pasar real-time/);

  // Primary CTA with dynamic label hook
  assert.match(landingHtml, /onclick="landingPrimaryAction\(\)"/);
  assert.match(landingHtml, /class="landing-cta-label">Mulai Sekarang<\/span>/);

  // Proof principles and hero note
  assert.match(landingHtml, /class="landing-proof-row"/);
  assert.match(landingHtml, /class="landing-hero-note"/);
});

test('Wave 9: Market context section explains IHSG, sector rotation, and preserves live snapshot showcase', () => {
  assert.match(landingHtml, /Arah IHSG &amp; Sentimen Makro/);
  assert.match(landingHtml, /Rotasi Aliran Sektoral/);
  assert.match(landingHtml, /Kesegaran Snapshot Bursa/);

  // Preserved live showcase container for loadLandingShowcase()
  assert.match(landingHtml, /id="landingPreview"/);
  assert.match(landingHtml, /id="landingShowcaseChip"/);
  assert.match(landingHtml, /id="landingShowcaseBody"/);
  assert.match(landingHtml, /id="landingShowcaseSectors"/);
});

test('Wave 9: Scan screener demonstrates Swing Konglomerat, Swing Non-Konglomerat, and Day Trade', () => {
  assert.match(landingHtml, /<h3>Swing Konglomerat<\/h3>/);
  assert.match(landingHtml, /<h3>Swing Non-Konglomerat<\/h3>/);
  assert.match(landingHtml, /<h3>Day Trade Momentum<\/h3>/);
  assert.match(landingHtml, /Hasil scan adalah titik awal penyaringan, bukan sinyal otomatis beli/);
});

test('Wave 9: Investigate section presents Bandarmologi, Broker Hunter, Insider, and Market Structure', () => {
  assert.match(landingHtml, /Bandarmologi &amp; Broker Summary/);
  assert.match(landingHtml, /Broker Hunter/);
  assert.match(landingHtml, /Aktivitas Kepemilikan Insider/);
  assert.match(landingHtml, /Struktur Pasar &amp; Konfluensi/);
});

test('Wave 9: Validate section covers financial ratios, Free Float, HSC, and data period transparency', () => {
  assert.match(landingHtml, /Laporan Keuangan &amp; Rasio/);
  assert.match(landingHtml, /Porsi Free Float Publik/);
  assert.match(landingHtml, /High Shareholder Concentration/);
  assert.match(landingHtml, /Transparansi Periode Data/);
  // Transparent note: HSC or low float doesn't guarantee price rises
  assert.match(landingHtml, /Konsentrasi tinggi atau float rendah tidak menjamin harga naik, melainkan penanda volatilitas tinggi/);
});

test('Wave 9: Ask AI assistant explains synthesis role, BYOK AES-256-GCM encryption, and lack of oracle certainty', () => {
  assert.match(landingHtml, /Sintesis Konfluensi Data/);
  assert.match(landingHtml, /Bring Your Own Key \(BYOK\)/);
  assert.match(landingHtml, /AES-256-GCM/);
  assert.match(landingHtml, /Tanpa Kepastian Buatan/);
  assert.match(landingHtml, /AI tidak memprediksi kepastian masa depan dan tidak menjamin keuntungan/);
});

test('Wave 9: Monitor section covers Watchlist, Portfolio risk planning, and Track Record signal audit', () => {
  assert.match(landingHtml, /Watchlist Terorganisir/);
  assert.match(landingHtml, /Portofolio &amp; Kalkulator Risiko/);
  assert.match(landingHtml, /Track Record Sinyal Sistem/);
  // Track Record is an audit of system signal outcomes, not user personal profit
  assert.match(landingHtml, /Audit terbuka hasil sinyal algoritma sistem Auto-Cuan/);
});

test('Wave 9: Data Trust & Risk section clearly outlines data limits and manual execution boundaries (§105)', () => {
  assert.match(landingHtml, /Ketersediaan &amp; Kesegaran Data/);
  assert.match(landingHtml, /Risiko Pasar Modal Tetap Nyata/);
  assert.match(landingHtml, /Bukan Penasihat Investasi atau Manajer Investasi/);
  assert.match(landingHtml, /Keputusan dan Eksekusi Tetap Mandiri/);
  assert.match(landingHtml, /id="landingSafety"/);
  assert.match(landingHtml, /id="landingSchedule"/);
  assert.match(landingHtml, /id="landingRules"/);
});

test('Wave 9: Anti-Slop copy hygiene check (no em dashes, no empty buzzwords, no fake stats/reviews)', () => {
  // R-02: Em dash character (—) is strictly forbidden in UI text
  const emDashMatch = landingHtml.match(/—/);
  assert.equal(emDashMatch, null, 'Landing HTML must contain zero em dash characters (—)');

  // R-16: Generic empty buzzwords forbidden
  assert.doesNotMatch(landingHtml, /\bAI Powered\b/i);
  assert.doesNotMatch(landingHtml, /\bSeamless\b/i);
  assert.doesNotMatch(landingHtml, /\bRevolutionary\b/i);
  assert.doesNotMatch(landingHtml, /\bNext Generation\b/i);
  assert.doesNotMatch(landingHtml, /\bGame Changer\b/i);
  assert.doesNotMatch(landingHtml, /\bCutting Edge\b/i);
  assert.doesNotMatch(landingHtml, /\bUltra Fast\b/i);

  // R-17 & R-18: No fake statistics or testimonials
  assert.doesNotMatch(landingHtml, /10\.?000\+\s*(Pengguna|Investor|Trader)/i);
  assert.doesNotMatch(landingHtml, /99%|98%|100%\s*(Akurat|Win Rate|Profit)/i);
  assert.doesNotMatch(landingHtml, /Bintang 5|Rating 4\.9|Testimoni/i);

  // R-36: No fabricated claims of OJK endorsement
  assert.doesNotMatch(landingHtml, /Terdaftar di OJK|Diawasi OJK|Izin OJK/i);
});

test('Wave 9: CSS tokens enforce high-contrast Light-first canonical design and dark mode compatibility', () => {
  // Light mode tokens
  assert.match(css, /html\.light #landingPage\s*\{[\s\S]*--lp-bg:\s*#f6f8f9;/);
  assert.match(css, /html\.light #landingPage\s*\{[\s\S]*--lp-surface:\s*#ffffff;/);
  assert.match(css, /html\.light #landingPage\s*\{[\s\S]*--lp-text:\s*#172421;/);
  assert.match(css, /html\.light #landingPage\s*\{[\s\S]*--lp-accent:\s*#09634d;/);

  // Dark mode tokens
  assert.match(css, /#landingPage\s*\{[\s\S]*--lp-bg:\s*#090c10;/);
  assert.match(css, /#landingPage\s*\{[\s\S]*--lp-surface:\s*#11161d;/);
  assert.match(css, /#landingPage\s*\{[\s\S]*--lp-text:\s*#edf2f6;/);
  assert.match(css, /#landingPage\s*\{[\s\S]*--lp-accent:\s*#22c55e;/);
});

test('Wave 9: Mobile and accessibility standards are met (44px min tap targets, reduced motion, focus indicators)', () => {
  // Tap target 44px
  assert.match(css, /min-height:\s*44px/);

  // Focus visible outline
  assert.match(css, /:is\(button, a, summary\):focus-visible\s*\{\s*outline:\s*2px solid var\(--lp-accent\);/);

  // Reduced motion
  assert.match(css, /@media\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(runtime, /reduced\.addEventListener\('change'/);

  // Content visibility
  assert.match(css, /content-visibility: visible; contain-intrinsic-size: none;/);

  // Mobile navigation disclosure
  assert.match(css, /landing-menu-open/);
  assert.match(css, /max-width:900px/);
});
