'use strict';

// Production build gate for the Auto-Cuan website.
// This validator is intentionally read-only and idempotent.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
function read(relativePath) { return fs.readFileSync(path.join(ROOT, relativePath), 'utf8'); }
function fail(message) { throw new Error('Build validation failed: ' + message); }
function assertOk(condition, message) { if (!condition) fail(message); }
function countOccurrences(haystack, needle) { return haystack.split(needle).length - 1; }

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
  'lib/context-ai-router-v4.js',
  'lib/context-ai-router-v5.js',
  'lib/analyze-legacy.js',
  'api/admin-users.js',
  'api/analyze.js',
  'api/sector-hot.js'
];
SYNTAX_CHECKED.forEach(function (file) { new vm.Script(read(file), { filename: file }); });

const index = read('public/index.html');
let inlineCount = 0;
for (const match of index.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
  if (!match[1].trim()) continue;
  inlineCount += 1;
  new vm.Script(match[1], { filename: 'public/index.html <script> #' + inlineCount });
}
assertOk(inlineCount > 0, 'no inline scripts found in public/index.html');

const apiFiles = fs.readdirSync(path.join(ROOT, 'api')).filter(function (name) { return name.endsWith('.js'); });
assertOk(apiFiles.length === 12, 'Vercel API function count changed: expected 12, got ' + apiFiles.length);

assertOk(!/onclick="openSubscriptionPage\(\)"/.test(index), 'Subscription entry point is visible again.');
assertOk(!/onclick="navigateTo\('subscription'\)"/.test(index), 'Subscription nav button is visible again.');
assertOk(!index.includes('tersedia pada tahap berikutnya'), 'Unfinished subscription phase wording returned.');

assertOk(!index.includes("if (isPremiumFeaturePage(page) && !hasConfirmedPremiumAccess()) {"), 'Legacy premium navigation gate is active again.');
assertOk(!index.includes('if (!allowed && isPremiumFeaturePage(currentPage)) {'), 'Legacy premium current-page gate is active again.');
assertOk(index.includes('function isDeniedWebsiteAccess()'), 'Definitive-deny helper for website access is missing.');
assertOk(index.includes("body:JSON.stringify({action:'portfolio_access'})"), 'Website access no longer checks the approval-based endpoint.');
assertOk(!index.includes("fetch('/api/login-user?action=premium-access-status'"), 'Website access is coupled to subscription entitlement again.');

assertOk(!index.includes("setTimeout(function() { if (document.getElementById('initialLoader')) renderStartupFallback(); }, 4500);"), 'Unguarded startup watchdog returned.');
assertOk(index.includes("var loader=document.getElementById('initialLoader'); if (loader && !loader.classList.contains('hidden')) renderStartupFallback();"), 'Guarded startup watchdog is missing.');
assertOk(index.includes('if (activeView) return;'), 'renderStartupFallback no longer preserves the active view.');

[
  '/website-approved-access.js?v=',
  '/admin-user-delete-enhancement.js?v=',
  '/ai-chat-renderer.js?v=',
  '/stock-analysis-ai.js?v='
].forEach(function (src) {
  const count = countOccurrences(index, '<script src="' + src);
  assertOk(count === 1, src + ' must be included exactly once in index.html (found ' + count + ')');
});

const renderer = read('public/ai-chat-renderer.js');
assertOk(!/characterData\s*:\s*true/.test(renderer), 'AI renderer characterData feedback loop returned.');
assertOk(renderer.includes("el.classList.contains('ai-rich-text') && !el.hasAttribute('data-ai-raw')"), 'AI renderer no longer preserves pre-rendered content.');
assertOk(!/characterData\s*:\s*true/.test(index), 'index.html observes characterData it rewrites.');
assertOk(!index.includes('document.write('), 'document.write returned to index.html.');

const legacyPortfolio = read('public/portfolio-planner.html');
assertOk(legacyPortfolio.includes('var ACCESS_TIMEOUT_MS=9000'), 'Legacy portfolio fallback lost its bounded access timeout.');
assertOk(legacyPortfolio.includes("$('retryAccess').onclick=checkAccess"), 'Legacy portfolio fallback lost its retry button.');
assertOk(!legacyPortfolio.includes('document.write('), 'document.write returned to the legacy portfolio page.');

const portfolio = read('public/portfolio-command-center.html');
const portfolioModel = read('public/portfolio-command-center-model.js');
const portfolioCommand = read('public/portfolio-command-center.js');
const portfolioScenarios = read('public/portfolio-position-scenarios.js');
const portfolioCss = read('public/portfolio-command-center.css');
assertOk(portfolio.includes('Budget-to-Stock Planner'), 'Budget-to-Stock Planner is missing.');
assertOk(portfolio.includes('Apa yang Berubah?'), 'Portfolio change timeline is missing.');
assertOk(portfolio.includes('Trading Journal'), 'Trading journal is missing.');
assertOk(portfolio.includes('Skenario Posisi'), 'Position scenarios are missing.');
assertOk(!portfolio.includes('>Pengingat Harga<'), 'Unimplemented price-reminder tab is visible again.');
assertOk(!portfolio.includes('>Export JSON<'), 'Journal export control is visible again.');
assertOk(portfolio.includes('id="exportJournal" class="hidden"'), 'Hidden compatibility hook for the journal runtime is missing.');
assertOk(portfolio.includes('id="tickerDrawer"'), 'Ticker Intelligence Drawer is missing.');
assertOk(portfolio.includes('id="page-ai"') && portfolio.includes('id="aiMessages"'), 'Portfolio AI workspace DOM contract is missing.');
assertOk(portfolio.includes('/portfolio-position-scenarios.js?v='), 'Position scenario runtime is not loaded.');
assertOk(portfolioCommand.includes('var ACCESS_TIMEOUT_MS = 9000'), 'Portfolio command center access check lost its bounded timeout.');
assertOk(portfolioCommand.includes("body: JSON.stringify({ action: 'portfolio_access' })"), 'Portfolio command center no longer uses approval-based access.');
assertOk(portfolioCommand.includes("fetch('/api/quote?ticker="), 'Portfolio command center quote refresh is missing.');
assertOk(portfolioModel.includes('function budgetCapacity(input)'), 'Deterministic budget capacity model is missing.');
assertOk(portfolioScenarios.includes('(plan.stop - plan.entry) * shares'), 'Stop-loss scenario math is missing.');
assertOk(portfolioScenarios.includes('(plan.tp1 - plan.entry) * shares'), 'TP1 scenario math is missing.');
assertOk(portfolioScenarios.includes('(plan.tp2 - plan.entry) * shares'), 'TP2 scenario math is missing.');
assertOk(!/fetch\(|telegram|push notification/i.test(portfolioScenarios), 'Position scenarios must remain local-only.');
assertOk(portfolioCss.includes('@media (prefers-reduced-motion: reduce)'), 'Portfolio command center reduced-motion support is missing.');
assertOk(!portfolio.includes('document.write(') && !portfolioCommand.includes('document.write('), 'document.write returned to the portfolio command center.');

const portfolioRuntime = read('public/portfolio-ai-runtime-v2.js');
assertOk(portfolioRuntime.includes('previous.role !== row.role'), 'Portfolio chat duplicate cleanup is missing.');
assertOk(portfolioRuntime.includes('if (!text || state.sending) return;'), 'Portfolio AI send lock is missing.');

const vercel = JSON.parse(read('vercel.json'));
const dashboardRewrite = (vercel.rewrites || []).find(function (row) { return row.source === '/dashboard'; });
assertOk(dashboardRewrite && dashboardRewrite.destination === '/index.html', '/dashboard must rewrite directly to /index.html.');
const portfolioRewrite = (vercel.rewrites || []).find(function (row) { return row.source === '/portfolio-planner'; });
assertOk(portfolioRewrite && portfolioRewrite.destination === '/portfolio-command-center.html', '/portfolio-planner must rewrite to the Portfolio Command Center.');
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
].forEach(function (file) { assertOk(!fs.existsSync(path.join(ROOT, file)), 'Obsolete runtime patch file returned: ' + file); });
assertOk(!index.includes('dashboard-loader'), 'index.html references dashboard-loader again.');

console.log('Production website validation passed (' + SYNTAX_CHECKED.length + ' files syntax-checked, ' + apiFiles.length + ' API functions).');