'use strict';

// Production build gate for the Auto-Cuan website.
// This validator writes nothing and fails with a precise message when a guarded
// regression returns.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function fail(message) {
  throw new Error('Build validation failed: ' + message);
}

function assertOk(condition, message) {
  if (!condition) fail(message);
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

// --- 1. JavaScript syntax -------------------------------------------------
const SYNTAX_CHECKED = [
  'public/website-approved-access.js',
  'public/admin-user-delete-enhancement.js',
  'public/security-admin-runtime.js',
  'public/ai-chat-renderer.js',
  'public/portfolio-ai-runtime-v2.js',
  'public/portfolio-planner-v1.js',
  'public/portfolio-command-center-model.js',
  'public/portfolio-command-center.js',
  'public/portfolio-position-scenarios.js',
  'public/portfolio-runtime-fix.js',
  'public/stock-analysis-ai.js',
  'public/ui-stability-fix.js',
  'public/pattern-stable-runtime.js',
  'public/pattern-tab-resume-guard.js',
  'public/pattern-map.js',
  'public/mobile-nav.js',
  'public/chart-viewer.js',
  'public/pattern-screener-extension.js',
  'public/assets/fca-stocks.js',
  'lib/security-guard.js',
  'lib/classic-chart-patterns.js',
  'lib/smart-setup-labels.js',
  'lib/context-ai-router-v4.js',
  'lib/context-ai-router-v5.js',
  'lib/analyze-legacy.js',
  'api/login-user.js',
  'api/admin-logs.js',
  'api/admin-users.js',
  'api/analyze.js',
  'api/candles.js',
  'api/sector-hot.js'
];
SYNTAX_CHECKED.forEach(function (file) {
  new vm.Script(read(file), { filename: file });
});

const index = read('public/index.html');
let inlineCount = 0;
for (const match of index.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
  if (!match[1].trim()) continue;
  inlineCount += 1;
  new vm.Script(match[1], { filename: 'public/index.html <script> #' + inlineCount });
}
assertOk(inlineCount > 0, 'no inline scripts found in public/index.html');

// --- 2. Vercel function budget -------------------------------------------
const apiFiles = fs.readdirSync(path.join(ROOT, 'api')).filter(function (name) { return name.endsWith('.js'); });
assertOk(apiFiles.length === 12, 'Vercel API function count changed: expected 12, got ' + apiFiles.length);

// --- 3. Security Phase 1 --------------------------------------------------
const loginApi = read('api/login-user.js');
const adminLogsApi = read('api/admin-logs.js');
const securityGuard = read('lib/security-guard.js');
const securityRuntime = read('public/security-admin-runtime.js');
const securityMigration = read('supabase/security-phase-1-migration.sql');
assertOk(loginApi.includes("require('../lib/security-guard')"), 'Login API no longer imports the security guard.');
assertOk(loginApi.includes('securityGuard.beginLogin') && loginApi.includes('loginGuard.failure(') && loginApi.includes("'bad_password'"), 'Login failure protection is missing.');
assertOk(loginApi.includes('loginGuard.credentialAccepted'), 'Successful credentials no longer clear pair/account failure state.');
assertOk(adminLogsApi.includes('securityGuard.loadSecurityDashboard'), 'Admin logs no longer expose the protected Security Center data.');
assertOk(securityGuard.includes("SECURITY_GUARD_MODE || 'off'"), 'Security guard is not disabled by default.');
assertOk(securityGuard.includes('SECURITY_TELEGRAM_CHAT_ID'), 'Dedicated security alert chat is missing.');
assertOk(!securityGuard.includes("source.SECURITY_TELEGRAM_CHAT_ID || source.TELEGRAM_CHAT_ID"), 'Security alerts can fall back to the recommendation chat.');
assertOk(securityGuard.includes("headers['x-vercel-forwarded-for']"), 'Vercel client IP extraction is missing.');
assertOk(securityRuntime.includes("credentials: 'same-origin'") && securityRuntime.includes("fetch('/api/admin-logs'"), 'Security Center no longer uses the protected admin endpoint.');
assertOk(securityRuntime.includes('function esc(value)') && securityRuntime.includes("'&':'&amp;'"), 'Security Center output escaping is missing.');
assertOk(securityRuntime.includes('esc(item.ip') && securityRuntime.includes('esc(agent)') && securityRuntime.includes('esc(error && error.message'), 'Security Center does not escape every server-controlled display field.');
assertOk(securityMigration.includes('alter table public.security_events enable row level security'), 'Security events RLS is missing.');
assertOk(securityMigration.includes('revoke all on table public.security_events from public, anon, authenticated'), 'Security events are exposed to browser roles.');
['security_login_precheck', 'security_login_record_failure', 'security_login_record_blocked', 'security_login_record_success'].forEach(function (name) {
  assertOk(securityMigration.includes('function public.' + name), name + ' RPC is missing from the migration.');
});

// --- 4. Subscription stays hidden ----------------------------------------
assertOk(!/onclick="openSubscriptionPage\(\)"/.test(index), 'Subscription entry point is visible again.');
assertOk(!/onclick="navigateTo\('subscription'\)"/.test(index), 'Subscription nav button is visible again.');
assertOk(!index.includes('tersedia pada tahap berikutnya'), 'Unfinished subscription phase wording returned.');

// --- 5. Approval-based website access ------------------------------------
assertOk(!index.includes("if (isPremiumFeaturePage(page) && !hasConfirmedPremiumAccess()) {"), 'Legacy premium navigation gate is active again.');
assertOk(!index.includes('if (!allowed && isPremiumFeaturePage(currentPage)) {'), 'Legacy premium current-page gate is active again.');
assertOk(index.includes('function isDeniedWebsiteAccess()'), 'Definitive-deny helper for website access is missing.');
assertOk(index.includes("body:JSON.stringify({action:'portfolio_access'})"), 'Website access no longer checks the approval-based endpoint.');
assertOk(!index.includes("fetch('/api/login-user?action=premium-access-status'"), 'Website access is coupled to subscription entitlement again.');

// --- 6. Startup watchdog --------------------------------------------------
assertOk(!index.includes("setTimeout(function() { if (document.getElementById('initialLoader')) renderStartupFallback(); }, 4500);"), 'Unguarded startup watchdog returned.');
assertOk(index.includes("var loader=document.getElementById('initialLoader'); if (loader && !loader.classList.contains('hidden')) renderStartupFallback();"), 'Guarded startup watchdog is missing.');
assertOk(index.includes('if (activeView) return;'), 'renderStartupFallback no longer preserves the active view.');

// --- 7. Runtime scripts included exactly once ----------------------------
[
  '/website-approved-access.js?v=',
  '/admin-user-delete-enhancement.js?v=',
  '/ai-chat-renderer.js?v=',
  '/stock-analysis-ai.js?v='
].forEach(function (src) {
  const count = countOccurrences(index, '<script src="' + src);
  assertOk(count === 1, src + ' must be included exactly once in index.html (found ' + count + ')');
});

// --- 8. Renderer and observers -------------------------------------------
const renderer = read('public/ai-chat-renderer.js');
assertOk(!/characterData\s*:\s*true/.test(renderer), 'AI renderer characterData feedback loop returned.');
assertOk(renderer.includes("el.classList.contains('ai-rich-text') && !el.hasAttribute('data-ai-raw')"), 'AI renderer no longer preserves pre-rendered content.');
assertOk(!/characterData\s*:\s*true/.test(index), 'index.html observes characterData it rewrites.');
assertOk(!index.includes('document.write('), 'document.write returned to index.html.');

// --- 9. Portfolio fallback and Command Center ----------------------------
const portfolioFallback = read('public/portfolio-planner.html');
assertOk(portfolioFallback.includes('.ai-shell{display:grid;grid-template-columns:1fr;'), 'Portfolio fallback AI layout is not vertical.');
assertOk(portfolioFallback.includes('var ACCESS_TIMEOUT_MS=9000'), 'Portfolio fallback access check lost its bounded timeout.');
assertOk(portfolioFallback.includes("$('retryAccess').onclick=checkAccess"), 'Portfolio fallback access failure lost its retry button.');
assertOk(!portfolioFallback.includes('document.write('), 'document.write returned to the portfolio fallback.');

const commandHtml = read('public/portfolio-command-center-v2.html');
const legacyCommandHtml = read('public/portfolio-command-center.html');
const commandCss = read('public/portfolio-command-center.css');
const commandUi = read('public/portfolio-command-center.js');
const commandModel = read('public/portfolio-command-center-model.js');
const commandScenarios = read('public/portfolio-position-scenarios.js');
const portfolioFix = read('public/portfolio-runtime-fix.js');
const stability = read('public/ui-stability-fix.js');
const patternStable = read('public/pattern-stable-runtime.js');
const patternExtension = read('public/pattern-screener-extension.js');
let commandInlineCount = 0;
for (const match of commandHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
  if (!match[1].trim()) continue;
  commandInlineCount += 1;
  new vm.Script(match[1], { filename: 'public/portfolio-command-center-v2.html <script> #' + commandInlineCount });
}
assertOk(commandInlineCount === 1, 'Portfolio v2 loader must contain exactly one inline bootstrap script.');
assertOk(commandHtml.includes('Portfolio Command Center'), 'Portfolio Command Center v2 loader is missing.');
assertOk(commandHtml.includes("fetch('/portfolio-command-center.html?v="), 'Portfolio v2 no longer hydrates the audited Command Center markup.');
assertOk(commandHtml.includes('/ui-stability-fix.js?v='), 'Portfolio UI stability runtime is missing from the v2 loader.');
assertOk(commandHtml.includes('/portfolio-runtime-fix.js?v=20260728-portfolio-runtime-fix-v1'), 'Portfolio delete repair runtime is missing from the v2 loader.');
assertOk(legacyCommandHtml.includes('Budget-to-Stock Planner'), 'Budget-to-Stock Planner is missing.');
assertOk(legacyCommandHtml.includes('Skenario Posisi'), 'Position scenarios are missing.');
assertOk(legacyCommandHtml.includes('id="exportJournal" class="hidden"'), 'Journal export control is visible again.');
assertOk(!/>Pengingat Harga</.test(legacyCommandHtml), 'The obsolete visible price-alert tab returned.');
assertOk(countOccurrences(stability, 'class="tab-icon"') >= 1 && ['today:', 'planner:', 'watch:', 'risk:', 'scenarios:', 'journal:', 'ai:'].every(function (key) { return stability.includes(key); }), 'Portfolio segmented navigation icon set is incomplete.');
assertOk(stability.includes('PORTFOLIO COPILOT'), 'Portfolio AI premium heading is missing.');
assertOk(commandUi.includes('var ACCESS_TIMEOUT_MS = 9000'), 'Command Center access timeout is missing.');
assertOk(commandUi.includes("action: 'portfolio_access'"), 'Command Center no longer uses server-verified portfolio access.');
assertOk(commandModel.includes('averageDownDecision'), 'Average-down decision guard is missing.');
assertOk(commandScenarios.includes('formatMoneyInput'), 'Rupiah input formatting is missing.');
assertOk(commandScenarios.includes('event.stopImmediatePropagation()'), 'The old generic average-down handler is not overridden.');
assertOk(commandScenarios.includes('action=screener') && commandScenarios.includes('action=nk-screener-results') && commandScenarios.includes('action=daytrade-screener'), 'Budget matching no longer reads the latest screeners.');
assertOk(commandCss.includes('.check-row input{width:auto;min-height:auto}'), 'Portfolio checkbox sizing regressed.');
assertOk(commandCss.includes('@media (prefers-reduced-motion: reduce)'), 'Reduced-motion support is missing.');
assertOk(stability.includes('pruneStandaloneArtifacts'), 'Standalone UI artifact cleanup is missing.');
assertOk(portfolioFix.includes('function stableLegacyId'), 'Legacy Portfolio ID migration is missing.');
assertOk(portfolioFix.includes("doc.addEventListener('click'") && portfolioFix.includes('event.stopImmediatePropagation()'), 'Portfolio delete repair no longer intercepts the broken handler.');
assertOk(portfolioFix.includes('legacyFallback = !planId && requestedTicker && planTicker === requestedTicker'), 'Legacy ticker fallback deletion is missing.');
assertOk(portfolioFix.includes('^0\\s+perubahan\\s+dicatat'), 'Empty snapshot toast cleanup is missing.');
assertOk(!/sendTelegram|telegramNotifier|supabase\.from|createOrder|broker-order/i.test(portfolioFix), 'Portfolio repair crossed a protected boundary.');
assertOk(!commandHtml.includes('document.write(') && !legacyCommandHtml.includes('document.write(') && !commandUi.includes('document.write(') && !commandScenarios.includes('document.write(') && !stability.includes('document.write(') && !portfolioFix.includes('document.write('), 'document.write returned to Command Center.');

const portfolioRuntime = read('public/portfolio-ai-runtime-v2.js');
assertOk(portfolioRuntime.includes('previous.role !== row.role'), 'Portfolio chat duplicate cleanup is missing.');
assertOk(portfolioRuntime.includes('if (!text || state.sending) return;'), 'Portfolio AI send lock is missing.');

// --- 9b. Front-end delivery: no render-blocking third-party compiler -------
// The Tailwind Play CDN shipped ~400KB of JavaScript that compiled CSS in the
// browser on every load, and blocking that host cost the app its entire layout.
// The generated sheet must stay in place, and every utility class the rendered
// DOM uses must exist in it.
const indexHtml = read('public/index.html');
const tailwindCss = read('public/tailwind-build.css');
assertOk(!/cdn\.tailwindcss\.com/.test(indexHtml), 'The Tailwind Play CDN is loaded again.');
assertOk(/<link[^>]+href="\/tailwind-build\.css/.test(indexHtml), 'The generated Tailwind stylesheet is not linked.');
assertOk(tailwindCss.length > 20000, 'public/tailwind-build.css looks truncated; regenerate it.');
// Every class literal in the shipped markup and scripts must resolve to a rule.
// Escapes are dropped first so ".bg-emerald-500\/10" can be matched literally.
const flatCss = tailwindCss.replace(/\\(.)/g, '$1');
function cssDefines(name) {
  let idx = flatCss.indexOf('.' + name);
  while (idx >= 0) {
    const next = flatCss[idx + name.length + 1];
    if (!next || !/[\w-]/.test(next)) return true;
    idx = flatCss.indexOf('.' + name, idx + 1);
  }
  return false;
}
['flex', 'grid', 'hidden', 'border', 'rounded-xl', 'text-left', 'text-right', 'text-center',
 'bg-dark-800/60', 'border-dark-600/30', 'text-emerald-400', 'sm:grid-cols-2', 'lg:grid-cols-3']
  .forEach(function (name) {
    assertOk(cssDefines(name), 'Tailwind utility "' + name + '" is missing from public/tailwind-build.css; regenerate it.');
  });

// jsPDF is ~350KB for an export most sessions never use. It must stay behind an
// explicit call rather than running three CDN attempts at parse time.
const marketFeatureRuntime = read('public/market-feature-runtime.js');
const frontendRuntime = indexHtml + '\n' + marketFeatureRuntime;
assertOk(indexHtml.includes('/market-feature-runtime.js'), 'Market feature runtime is missing from the entry page.');
assertOk(indexHtml.includes('window.loadPdfLibrary'), 'On-demand PDF loader is missing.');
assertOk(!/loadScript\(jspdfUrls, 0, function\(ok1\) \{\s*\n\s*if \(!ok1\)/.test(indexHtml) || indexHtml.indexOf('window.loadPdfLibrary') < indexHtml.indexOf('jspdfUrls, 0'), 'PDF libraries are fetched at page load again.');
assertOk(marketFeatureRuntime.includes('_ensureJsPdf') && marketFeatureRuntime.includes('window.loadPdfLibrary().then'), 'PDF export no longer triggers its own library load.');

// The in-page spacing self-test shipped ~4KB of fixtures to every visitor and
// asserted on textContent, which drops the <br> separators it was checking for.
assertOk(!/selfTestSpacing|Auto-Cuan DOM-Test FAIL/.test(indexHtml), 'The in-page spacing self-test returned; it belongs in test/ai-technical-spacing.test.js.');

// --- 10. Stable Pattern runtime, classic detector, and Swing ranking ------
const fcaLoader = read('public/assets/fca-stocks.js');
const classicPatterns = read('lib/classic-chart-patterns.js');
const smartSetups = read('lib/smart-setup-labels.js');
const candlesApi = read('api/candles.js');
assertOk(fcaLoader.includes('/security-admin-runtime.js?v=20260729-security-admin-v1'), 'Security Center runtime loader is missing.');
assertOk(fcaLoader.includes('/ui-stability-fix.js?v=20260802-ui-stability-v2'), 'Shared UI stability runtime loader is missing.');
assertOk(fcaLoader.includes('/pattern-stable-runtime.js?v=20260813-pattern-stable-v6'), 'Stable Pattern v6 runtime loader is missing.');
assertOk(fcaLoader.includes('/pattern-screener-extension.js?v=20260813-pattern-screener-v7'), 'Screener Pattern v7 extension loader is missing.');
assertOk(fcaLoader.includes('/pattern-visual.js?v=20260813-pattern-visual-v1'), 'Local Pattern SVG renderer loader is missing.');
assertOk(fcaLoader.includes('/pattern-direction-safety.js?v=20260813-pattern-direction-safety-v2'), 'Pattern safety model loader is missing.');
// Pattern's modules are libraries with a boot loop, not sequential patches, so
// they must stay parallel: chaining them again puts four serial round trips back
// in front of Pattern's first render.
assertOk(!/pattern-stable-runtime\.js[^]*?function \(\) \{\s*\n\s*append\('\/pattern-screener-extension/.test(fcaLoader), 'Pattern runtimes are chained serially again.');
assertOk(!fcaLoader.includes('/pattern-radar.js'), 'The duplicate Pattern Radar runtime is still loaded.');
assertOk(patternStable.includes('action=screener') && patternStable.includes('action=nk-screener-results') && patternStable.includes('action=daytrade-screener'), 'Pattern Radar no longer reads all three latest screener sources.');
const patternVisual = read('public/pattern-visual.js');
const patternSafety = read('public/pattern-direction-safety.js');
// The Pattern figure must stay local. Sending the ticker, its close series and
// the admin-only geometry to a third-party image service is both a data-egress
// and an availability problem: on a network that blocks it, the one visual the
// feature exists for silently fails.
const stripComments = text => text.replace(/^\s*\/\/.*$/gm, '');
assertOk(['public/pattern-stable-runtime.js', 'public/pattern-visual.js', 'public/pattern-map.js', 'public/ui-stability-fix.js', 'public/index.html']
  .every(function (file) { return !/quickchart/i.test(stripComments(read(file))); }),
  'Pattern figures are fetched from a third-party image service again.');
assertOk(patternVisual.includes('function buildPatternSvg'), 'Local Pattern SVG builder is missing.');
assertOk(!/fetch\(|XMLHttpRequest/.test(stripComments(patternVisual)), 'The Pattern SVG builder must stay pure.');
// The safety model must never go back to reading rendered text: that is what
// produced both the idle MutationObserver loop and the rounded-string verdicts.
assertOk(!/MutationObserver|querySelectorAll/.test(stripComments(patternSafety)), 'Pattern safety scrapes the DOM again.');
assertOk(patternSafety.includes('function evaluateRow'), 'Pattern safety model entry point is missing.');
assertOk(patternStable.includes('Safety.evaluateRow') && patternStable.includes('Safety.statusRank'), 'Pattern cards no longer render their verdict from the safety model.');
assertOk(!patternStable.includes('MAX_SCAN') && !patternStable.includes('FALLBACK_TICKERS'), 'Pattern fixed cap or fallback universe returned.');
assertOk(patternStable.includes("root.location.pathname === '/pattern'"), 'Direct Pattern route bootstrap is missing.');
assertOk(patternStable.includes('PatternMap.validateCandidate'), 'ABCD renderer no longer validates server geometry.');
assertOk(patternStable.includes('classicPatterns') && patternStable.includes('data-classic-only'), 'Classic Pattern Radar rendering is missing.');
assertOk(patternStable.includes('function figureHtml') && patternStable.includes('Visual.buildPatternSvg'), 'Classic Pattern inline visual is missing.');
assertOk(patternStable.includes('sessionStorage.setItem(cacheKey()') && patternStable.includes('sessionStorage.getItem(cacheKey()'), 'Pattern session cache is missing.');
assertOk(patternStable.includes('if (!hydrateCache()) scan(false)'), 'Pattern re-entry no longer restores the cached result before scanning.');
assertOk(patternStable.includes('state.rows = results.filter(Boolean)') && !/state\.rows\.push\(row\);\s*render\(\)/.test(patternStable), 'Pattern scanning redraws the grid for every ticker again.');
assertOk(patternExtension.includes('smart_setup_labels') && patternExtension.includes('primary_smart_setup'), 'Pattern Radar no longer reads official Screener setup fields.');
assertOk(patternExtension.includes('classic_chart_patterns') && patternExtension.includes('primary_classic_pattern'), 'Pattern Radar no longer reads official classic pattern fields.');
assertOk(patternExtension.includes('labelText') && !patternExtension.includes("String(label == null ? '' : label).trim()"), 'Object setup-label normalization regressed.');
assertOk(patternExtension.includes('action=screener') && patternExtension.includes('action=nk-screener-results') && patternExtension.includes('action=daytrade-screener'), 'Screener Pattern extension no longer reads all three existing sources.');
assertOk(patternExtension.includes("querySelectorAll('[data-screener-only=\"1\"]')") && !patternExtension.includes('setupOnlyCardHtml'), 'Screener-only cards can return to Pattern Radar.');
assertOk(patternExtension.includes("return String(value == null ? '' : value).trim() === 'Technical Chart';"), 'The dead Technical Chart control is not removed unconditionally.');
assertOk(patternExtension.includes('isRedundantChartControl') && patternExtension.includes('isStandaloneArtifact'), 'Chart duplicate or global artifact cleanup is missing.');
assertOk(!/sendTelegram|telegramNotifier|supabase\.from|createOrder|DAYTRADE_INTRADAY_SCORE_ENABLED/i.test(patternExtension), 'Screener Pattern extension touched a protected runtime.');

// --- 10b. Pattern mobile visibility, resolution, and mobile navigation ----
const patternMap = read('public/pattern-map.js');
const resumeGuard = read('public/pattern-tab-resume-guard.js');
const mobileNav = read('public/mobile-nav.js');
const uiTheme = read('public/ui-theme.css');
// The runtime Pattern page must never carry data-premium-page again: the
// approval gate hid AND inerted it during its loading/unavailable states, which
// is what made Pattern vanish or go dead to touch on mobile.
assertOk(!/setAttribute\(\s*'data-premium-page'/.test(patternStable), 'Pattern page is premium-gated again; the mobile hide/inert race returns.');
assertOk(patternStable.includes('function setPageVisible'), 'Pattern visibility no longer moves hidden, inert, and aria-hidden together.');
assertOk(resumeGuard.includes('function revealPatternPage') && resumeGuard.includes('page.removeAttribute(\'aria-hidden\')'), 'Pattern resume no longer clears inert/aria-hidden.');
// Resolution no longer matters for the card figure: an SVG is resolution
// independent, so there is no raster spec to pick per viewport.
assertOk(patternStable.includes('function svgDataUri'), 'Pattern fullscreen fallback image is missing.');
// The figure is inline SVG, so there is no bitmap to pin a pixel ratio to and
// no PNG blob to keep alive for a download link.
assertOk(!/devicePixelRatio/.test(patternStable), 'Pattern Radar is rendering a raster image again.');
assertOk(!/createObjectURL|revokeObjectURL/.test(patternStable), 'Pattern Radar is holding image blob URLs again.');
assertOk(fcaLoader.includes('/mobile-nav.js?v='), 'Mobile bottom navigation runtime is not loaded.');
assertOk(mobileNav.includes('function buildNavModel') && mobileNav.includes("querySelectorAll('.nav-btn[data-page]')"), 'Mobile navigation no longer mirrors #mainNav.');
assertOk(!/navigateTo\s*=|function navigateTo/.test(mobileNav), 'Mobile navigation must delegate to the existing buttons, never redefine navigateTo.');
assertOk(mobileNav.includes("doc.getElementById('dashboardScreen')") && mobileNav.includes('function shellVisible'), 'Mobile navigation can leak onto the landing, blocked, or maintenance screen.');

// --- 10c. Floating launcher, shared chart viewer, and mobile viewport -----
const chartViewer = read('public/chart-viewer.js');
// A floating control reserves no layout space. Padding <body> for a fixed bar is
// what shrank the 100vh body content box below the 100vh shell and left a dead
// band containing the footer at the foot of every page.
assertOk(!/body\.has-mobile-nav/.test(uiTheme) && !/has-mobile-nav/.test(mobileNav), 'The body padding-bottom nav hack returned; the mobile dead band comes back with it.');
assertOk(uiTheme.includes('@supports (height: 100dvh)') && uiTheme.includes('min-height: 100vh'), 'Dynamic viewport height is missing or lost its vh fallback.');
assertOk(mobileNav.includes('function snapPosition') && mobileNav.includes('function panelPlacement'), 'Launcher edge-snapping or popover placement is missing.');
assertOk(mobileNav.includes('DRAG_THRESHOLD') && mobileNav.includes('pointerdown'), 'Launcher drag handling is missing.');
assertOk(uiTheme.includes('.ac-launcher') && uiTheme.includes('.ac-navpanel'), 'Floating launcher styles are missing.');
assertOk(!uiTheme.includes('.ac-mobilenav-item'), 'The replaced bottom-bar styles are still shipped.');
assertOk(fcaLoader.includes('/chart-viewer.js?v='), 'Shared chart viewer is not loaded.');
// The viewer must reuse the Chart page renderer rather than fork a second engine.
assertOk(chartViewer.includes('root.renderLightweightChart(') && chartViewer.includes("variant: 'fullscreen'"), 'Chart viewer no longer reuses the Chart page renderer.');
assertOk(chartViewer.includes('function lockScroll') && chartViewer.includes('data-ac-scroll-locked'), 'Chart viewer scroll lock is missing.');
assertOk(chartViewer.includes('clampPan') && chartViewer.includes('pointermove'), 'Chart viewer pinch/pan fallback is missing.');
assertOk(!/fetch\(|supabase|telegram|navigateTo\s*=/i.test(chartViewer), 'Chart viewer crossed a protected boundary.');
assertOk(frontendRuntime.includes('function openChartPageFullscreen()') && frontendRuntime.includes('openChartPageFullscreen()'), 'Chart page fullscreen entry point is missing.');
assertOk(frontendRuntime.includes("if (variant === 'fullscreen')"), 'chartDims lost its fullscreen variant.');
assertOk(patternStable.includes('data-ps-zoom') && patternStable.includes('root.openChartViewer'), 'Pattern cards can no longer open the shared viewer.');
assertOk(patternStable.includes('function viewerPriceLines') && patternStable.includes('function viewerMarkers'), 'Pattern geometry is no longer passed to the viewer.');
const patternHeaders = (JSON.parse(read('vercel.json')).headers || []).map(function (row) { return row.source; });
assertOk(patternHeaders.indexOf('/chart-viewer.js') >= 0, 'Chart viewer lost its no-store header.');
assertOk(!/sendTelegram|telegramNotifier|supabase|fetch\(/i.test(mobileNav), 'Mobile navigation crossed a protected boundary.');
assertOk(index.includes('<link rel="stylesheet" href="/ui-theme.css?v='), 'Theme layer stylesheet is not linked.');
assertOk(index.indexOf('/ui-theme.css') > index.indexOf('</style>'), 'Theme layer must load after the inline styles it overrides.');
assertOk(uiTheme.includes('env(safe-area-inset-bottom'), 'Safe-area handling is missing from the theme layer.');
const themeHeader = (JSON.parse(read('vercel.json')).headers || []).find(function (row) { return row.source === '/ui-theme.css'; });
const navHeader = (JSON.parse(read('vercel.json')).headers || []).find(function (row) { return row.source === '/mobile-nav.js'; });
assertOk(themeHeader && navHeader, 'New frontend assets lost their no-store headers.');

[
  'ASCENDING_TRIANGLE','DESCENDING_TRIANGLE','SYMMETRICAL_TRIANGLE',
  'BULL_FLAG','BEAR_FLAG','BULL_PENNANT','BEAR_PENNANT',
  'CUP_AND_HANDLE','INVERTED_CUP_AND_HANDLE','RISING_WEDGE','FALLING_WEDGE',
  'HEAD_AND_SHOULDERS','INVERSE_HEAD_AND_SHOULDERS','DOUBLE_TOP','DOUBLE_BOTTOM','GAP_UP','GAP_DOWN'
].forEach(function (marker) { assertOk(classicPatterns.includes(marker), 'Classic detector missing ' + marker); });
assertOk(classicPatterns.includes('MAX_SCORE_ADJUSTMENT = 4') && classicPatterns.includes('MIN_SCORE_ADJUSTMENT = -4'), 'Classic pattern score bounds changed.');
assertOk(!/sendTelegram|telegramNotifier|supabase|createOrder|action_label\s*=/.test(classicPatterns), 'Classic detector crossed a protected boundary.');
assertOk(smartSetups.includes('MAX_SWING_PATTERN_SCORE_ADJUSTMENT = 5'), 'Swing positive pattern cap is not +5.');
assertOk(smartSetups.includes('MIN_SWING_PATTERN_SCORE_ADJUSTMENT = -4'), 'Swing negative pattern cap is not -4.');
assertOk(smartSetups.includes('if (!row || !isSwingCandidate(row, context)) return row;'), 'Pattern adjustment is no longer Swing-only.');
assertOk(smartSetups.includes('if (row.swing_pattern_score_version === SWING_PATTERN_SCORE_VERSION) return row;'), 'Swing pattern score idempotency guard is missing.');
assertOk(smartSetups.includes('var adjustment = blocked ? 0'), 'Safety-blocked pattern adjustment is no longer forced to zero.');
assertOk(!/action_label\s*=|final_status\s*=|signal_action\s*=|sendTelegram|telegramNotifier|supabase\.from/.test(smartSetups), 'Pattern scoring changed action/status or protected systems.');
assertOk(candlesApi.includes("require('../lib/classic-chart-patterns').detectClassicChartPatterns"), 'Candles API no longer computes classic patterns from T-1 candles.');
assertOk(candlesApi.includes('delete publicData.classicPatterns') && candlesApi.includes('delete publicData.classic_pattern_meta'), 'Classic patterns are no longer admin-only.');
assertOk(candlesApi.includes('candles.slice(-90)'), 'Classic detector no longer uses a bounded T-1 window.');

// --- 11. Routing and dead files ------------------------------------------
const vercel = JSON.parse(read('vercel.json'));
const dashboardRewrite = (vercel.rewrites || []).find(function (row) { return row.source === '/dashboard'; });
const patternRewrite = (vercel.rewrites || []).find(function (row) { return row.source === '/pattern'; });
const portfolioRewrite = (vercel.rewrites || []).find(function (row) { return row.source === '/portfolio-planner'; });
const portfolioFixHeader = (vercel.headers || []).find(function (row) { return row.source === '/portfolio-runtime-fix.js'; });
const securityHeader = (vercel.headers || []).find(function (row) { return row.source === '/security-admin-runtime.js'; });
assertOk(dashboardRewrite && dashboardRewrite.destination === '/index.html', '/dashboard must rewrite directly to /index.html.');
assertOk(patternRewrite && patternRewrite.destination === '/index.html', '/pattern must rewrite directly to /index.html.');
assertOk(portfolioRewrite && portfolioRewrite.destination === '/portfolio-command-center-v2.html', '/portfolio-planner must open Command Center v2.');
assertOk(portfolioFixHeader, 'Portfolio runtime repair lost its no-store header.');
assertOk(securityHeader, 'Security Center runtime lost its no-store header.');
assertOk(!JSON.stringify(vercel).includes('dashboard-loader'), 'vercel.json references dashboard-loader again.');

[
  'public/dashboard-loader.html',
  'public/dashboard-approved-access-guard.js',
  'public/dashboard-approved-enhancements.js',
  'public/admin-delete-user.js',
  'public/dashboard-responsive-fixes.css',
  'public/portfolio-ai-recovery.js',
  'public/portfolio-enhancements.js',
  'public/portfolio-enhancements.css',
  'public/portfolio-decision-center-v1.html'
].forEach(function (file) {
  assertOk(!fs.existsSync(path.join(ROOT, file)), 'Obsolete runtime patch file returned: ' + file);
});
assertOk(!index.includes('dashboard-loader'), 'index.html references dashboard-loader again.');

console.log('Production website validation passed (' + SYNTAX_CHECKED.length + ' files syntax-checked, ' + apiFiles.length + ' API functions).');
