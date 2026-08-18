'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const readPremiumCss = () => [
  read('public/premium-workstation-core.css'),
  read('public/premium-workstation-v6.css'),
  read('public/premium-workstation.css'),
].join('\n');

test('premium workstation entrypoint is loaded after the base theme', () => {
  const html = read('public/index.html');
  const themeAt = html.indexOf('/ui-theme.css?v=');
  const premiumAt = html.indexOf('/premium-workstation.css?v=20260818-v4');
  assert.ok(themeAt > 0, 'base UI theme link missing');
  assert.ok(premiumAt > themeAt, 'premium workstation layer must load after ui-theme.css');
  assert.equal((html.match(/premium-workstation\.css\?v=20260818-v4/g) || []).length, 1);
});

test('premium workstation entrypoint composes frozen core and structural v6', () => {
  const entry = read('public/premium-workstation.css');
  const core = read('public/premium-workstation-core.css');
  const v6 = read('public/premium-workstation-v6.css');
  assert.match(entry, /premium-workstation-core\.css\?v=20260818-v4-core/);
  assert.match(entry, /premium-workstation-v6\.css\?v=20260818-v6/);
  assert.match(core, /Auto-Cuan — Premium Workstation V3/);
  assert.match(core, /AUTO-CUAN PREMIUM WORKSTATION V4/);
  assert.match(v6, /AUTO-CUAN PREMIUM WORKSTATION V6/);
});

test('premium workstation keeps a restrained trading UI contract', () => {
  const css = readPremiumCss();
  assert.match(css, /--pw-bg:\s*#06090e/);
  assert.match(css, /--pw-accent:\s*#2dd4a3/);
  assert.match(css, /\.landing-gradient-text[\s\S]*background:\s*none\s*!important/);
  assert.match(css, /\.dashboard-hero::before/);
  assert.match(css, /font-variant-numeric:\s*tabular-nums/);
  assert.match(css, /@media \(max-width: 767px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test('premium workstation CSS is presentation-only', () => {
  const css = readPremiumCss();
  assert.doesNotMatch(css, /fetch\s*\(/i);
  assert.doesNotMatch(css, /supabase/i);
  assert.doesNotMatch(css, /telegram/i);
  assert.doesNotMatch(css, /daytrade_score|swing_score|entry_price|stop_loss|take_profit/i);
  assert.doesNotMatch(css, /addEventListener|setInterval|setTimeout|onclick\s*=/i);
});

test('premium workstation assets are cacheable while API no-store remains intact', () => {
  const config = JSON.parse(read('vercel.json'));
  const api = (config.headers || []).find((row) => row.source === '/api/(.*)');
  const entry = (config.headers || []).find((row) => row.source === '/premium-workstation.css');
  const core = (config.headers || []).find((row) => row.source === '/premium-workstation-core.css');
  const v6 = (config.headers || []).find((row) => row.source === '/premium-workstation-v6.css');
  assert.ok(api, 'API cache rule missing');
  assert.ok(entry, 'premium workstation entrypoint cache rule missing');
  assert.ok(core, 'premium workstation core cache rule missing');
  assert.ok(v6, 'premium workstation v6 cache rule missing');
  const apiCache = api.headers.find((h) => h.key.toLowerCase() === 'cache-control').value;
  const entryCache = entry.headers.find((h) => h.key.toLowerCase() === 'cache-control').value;
  const coreCache = core.headers.find((h) => h.key.toLowerCase() === 'cache-control').value;
  const v6Cache = v6.headers.find((h) => h.key.toLowerCase() === 'cache-control').value;
  assert.match(apiCache, /no-store/);
  assert.match(entryCache, /public/);
  assert.match(entryCache, /must-revalidate/);
  assert.match(coreCache, /public/);
  assert.match(v6Cache, /public/);
});

test('premium workstation V3 locks workstation hierarchy and rendering ergonomics', () => {
  const css = readPremiumCss();
  assert.match(css, /Auto-Cuan — Premium Workstation V3/);
  assert.match(css, /#page-dashboard \.market-band-grid[\s\S]*grid-template-columns/);
  assert.match(css, /#rankingTableWrap th:first-child[\s\S]*position:\s*sticky/);
  assert.match(css, /#screenerContent \.scr-filter-grid::before/);
  assert.match(css, /#page-analisis > div:first-child[\s\S]*position:\s*sticky/);
  assert.match(css, /\.landing-section[\s\S]*content-visibility:\s*auto/);
  assert.match(css, /@media \(prefers-contrast: more\)/);
});

test('premium workstation v4 adds product-grade semantics and trust without behavior', () => {
  const html = read('public/index.html');
  const css = readPremiumCss();
  assert.match(html, /rel="canonical" href="https:\/\/autocuan\.web\.id\/"/);
  assert.match(html, /property="og:title" content="Auto-Cuan \| IDX Stock Radar"/);
  assert.match(html, /class="landing-trust-rail"/);
  assert.match(html, /Keputusan & eksekusi manual/);
  assert.match(html, /id="ihsgSummaryCard" class="market-band-grid" role="group"/);
  assert.match(html, /class="radar-panel lg:col-span-3 panel" aria-label="Top 5 Radar"/);
  assert.match(html, /id="dashboardMonitorUpdated"[^>]*aria-live="polite"/);
  assert.match(css, /AUTO-CUAN PREMIUM WORKSTATION V4/);
  assert.match(css, /\.landing-trust-rail/);
});

test('premium workstation v6 upgrades hierarchy without changing application semantics', () => {
  const css = read('public/premium-workstation-v6.css');
  assert.match(css, /--pw-page-wide:\s*1420px/);
  assert.match(css, /\.dashboard-radar-grid[\s\S]*grid-template-columns:\s*minmax\(0, 1\.9fr\)/);
  assert.match(css, /#screenerContent \.scr-filter-grid[\s\S]*position:\s*sticky/);
  assert.match(css, /#dtCardGrid,[\s\S]*minmax\(330px, 1fr\)/);
  assert.match(css, /#page-analisis > div:first-child[\s\S]*var\(--pw-command-top\)/);
  assert.match(css, /#analisisFollowUp[\s\S]*position:\s*sticky/);
  assert.match(css, /content-visibility:\s*auto/);
  assert.match(css, /scroll-snap-type:\s*x proximity/);
  assert.match(css, /@media \(max-width: 767px\)/);
  assert.match(css, /@media \(prefers-contrast: more\)/);
});
