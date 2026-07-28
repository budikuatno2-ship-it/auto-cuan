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
  'public/ai-chat-renderer.js',
  'public/portfolio-ai-runtime-v2.js',
  'public/portfolio-planner-v1.js',
  'public/portfolio-command-center-model.js',
  'public/portfolio-command-center.js',
  'public/portfolio-position-scenarios.js',
  'public/stock-analysis-ai.js',
  'public/ui-stability-fix.js',
  'public/pattern-stable-runtime.js',
  'public/assets/fca-stocks.js',
  'lib/context-ai-router-v4.js',
  'lib/context-ai-router-v5.js',
  'lib/analyze-legacy.js',
  'api/admin-users.js',
  'api/analyze.js',
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

// --- 3. Subscription stays hidden ----------------------------------------
assertOk(!/onclick="openSubscriptionPage\(\)"/.test(index), 'Subscription entry point is visible again.');
assertOk(!/onclick="navigateTo\('subscription'\)"/.test(index), 'Subscription nav button is visible again.');
assertOk(!index.includes('tersedia pada tahap berikutnya'), 'Unfinished subscription phase wording returned.');

// --- 4. Approval-based website access ------------------------------------
assertOk(!index.includes("if (isPremiumFeaturePage(page) && !hasConfirmedPremiumAccess()) {"), 'Legacy premium navigation gate is active again.');
assertOk(!index.includes('if (!allowed && isPremiumFeaturePage(currentPage)) {'), 'Legacy premium current-page gate is active again.');
assertOk(index.includes('function isDeniedWebsiteAccess()'), 'Definitive-deny helper for website access is missing.');
assertOk(index.includes("body:JSON.stringify({action:'portfolio_access'})"), 'Website access no longer checks the approval-based endpoint.');
assertOk(!index.includes("fetch('/api/login-user?action=premium-access-status'"), 'Website access is coupled to subscription entitlement again.');

// --- 5. Startup watchdog --------------------------------------------------
assertOk(!index.includes("setTimeout(function() { if (document.getElementById('initialLoader')) renderStartupFallback(); }, 4500);"), 'Unguarded startup watchdog returned.');
assertOk(index.includes("var loader=document.getElementById('initialLoader'); if (loader && !loader.classList.contains('hidden')) renderStartupFallback();"), 'Guarded startup watchdog is missing.');
assertOk(index.includes('if (activeView) return;'), 'renderStartupFallback no longer preserves the active view.');

// --- 6. Runtime scripts included exactly once ----------------------------
[
  '/website-approved-access.js?v=',
  '/admin-user-delete-enhancement.js?v=',
  '/ai-chat-renderer.js?v=',
  '/stock-analysis-ai.js?v='
].forEach(function (src) {
  const count = countOccurrences(index, '<script src="' + src);
  assertOk(count === 1, src + ' must be included exactly once in index.html (found ' + count + ')');
});

// --- 7. Renderer and observers -------------------------------------------
const renderer = read('public/ai-chat-renderer.js');
assertOk(!/characterData\s*:\s*true/.test(renderer), 'AI renderer characterData feedback loop returned.');
assertOk(renderer.includes("el.classList.contains('ai-rich-text') && !el.hasAttribute('data-ai-raw')"), 'AI renderer no longer preserves pre-rendered content.');
assertOk(!/characterData\s*:\s*true/.test(index), 'index.html observes characterData it rewrites.');
assertOk(!index.includes('document.write('), 'document.write returned to index.html.');

// --- 8. Portfolio fallback and Command Center ----------------------------
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
const stability = read('public/ui-stability-fix.js');
const patternStable = read('public/pattern-stable-runtime.js');
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
assertOk(!commandHtml.includes('document.write(') && !legacyCommandHtml.includes('document.write(') && !commandUi.includes('document.write(') && !commandScenarios.includes('document.write(') && !stability.includes('document.write('), 'document.write returned to Command Center.');

const portfolioRuntime = read('public/portfolio-ai-runtime-v2.js');
assertOk(portfolioRuntime.includes('previous.role !== row.role'), 'Portfolio chat duplicate cleanup is missing.');
assertOk(portfolioRuntime.includes('if (!text || state.sending) return;'), 'Portfolio AI send lock is missing.');

// --- 9. Stable Pattern runtime --------------------------------------------
const fcaLoader = read('public/assets/fca-stocks.js');
assertOk(fcaLoader.includes('/ui-stability-fix.js?v=20260728-ui-stability-v1'), 'Shared UI stability runtime loader is missing.');
assertOk(fcaLoader.includes('/pattern-stable-runtime.js?v=20260728-pattern-stable-v1'), 'Stable Pattern runtime loader is missing.');
assertOk(!fcaLoader.includes('/pattern-radar.js'), 'The duplicate Pattern Radar runtime is still loaded.');
assertOk(patternStable.includes('action=screener') && patternStable.includes('action=nk-screener-results') && patternStable.includes('action=daytrade-screener'), 'Pattern Radar no longer reads all three latest screener sources.');
assertOk(stability.includes("type: 'line'"), 'Pattern map reliable line-chart renderer is missing.');
assertOk(!patternStable.includes('MAX_SCAN') && !patternStable.includes('FALLBACK_TICKERS'), 'Pattern fixed cap or fallback universe returned.');
assertOk(patternStable.includes("root.location.pathname === '/pattern'"), 'Direct Pattern route bootstrap is missing.');
assertOk(patternStable.includes('PatternMap.validateCandidate'), 'Pattern renderer no longer validates server geometry.');

// --- 10. Routing and dead files -------------------------------------------
const vercel = JSON.parse(read('vercel.json'));
const dashboardRewrite = (vercel.rewrites || []).find(function (row) { return row.source === '/dashboard'; });
const patternRewrite = (vercel.rewrites || []).find(function (row) { return row.source === '/pattern'; });
const portfolioRewrite = (vercel.rewrites || []).find(function (row) { return row.source === '/portfolio-planner'; });
assertOk(dashboardRewrite && dashboardRewrite.destination === '/index.html', '/dashboard must rewrite directly to /index.html.');
assertOk(patternRewrite && patternRewrite.destination === '/index.html', '/pattern must rewrite directly to /index.html.');
assertOk(portfolioRewrite && portfolioRewrite.destination === '/portfolio-command-center-v2.html', '/portfolio-planner must open Command Center v2.');
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
