'use strict';

// Production build gate for the Auto-Cuan website.
//
// Historical note: this script used to REWRITE production files at build time
// (string-patching index.html, the AI router, and the portfolio runtime).
// Every one of those hotfixes is now baked directly into the source files, so
// this script is a pure validator: it writes nothing, is idempotent by
// construction, and fails the build with a precise message when a guarded
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

// --- 1. JavaScript syntax -----------------------------------------------
const SYNTAX_CHECKED = [
  'public/website-approved-access.js',
  'public/admin-user-delete-enhancement.js',
  'public/ai-chat-renderer.js',
  'public/portfolio-ai-runtime-v2.js',
  'public/portfolio-planner-v1.js',
  'public/stock-analysis-ai.js',
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

// Every inline script in the main page must parse.
const index = read('public/index.html');
let inlineCount = 0;
for (const match of index.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
  if (!match[1].trim()) continue;
  inlineCount += 1;
  new vm.Script(match[1], { filename: 'public/index.html <script> #' + inlineCount });
}
assertOk(inlineCount > 0, 'no inline scripts found in public/index.html');

// --- 2. Vercel function budget ------------------------------------------
const apiFiles = fs.readdirSync(path.join(ROOT, 'api')).filter(function (name) { return name.endsWith('.js'); });
assertOk(apiFiles.length === 12, 'Vercel API function count changed: expected 12, got ' + apiFiles.length);

// --- 3. Subscription stays hidden ----------------------------------------
assertOk(!/onclick="openSubscriptionPage\(\)"/.test(index), 'Subscription entry point is visible again.');
assertOk(!/onclick="navigateTo\('subscription'\)"/.test(index), 'Subscription nav button is visible again.');
assertOk(!index.includes('tersedia pada tahap berikutnya'), 'Unfinished subscription phase wording returned.');

// --- 4. Approval-based website access ------------------------------------
assertOk(!index.includes("if (isPremiumFeaturePage(page) && !hasConfirmedPremiumAccess()) {"),
  'Legacy premium navigation gate is active again.');
assertOk(!index.includes('if (!allowed && isPremiumFeaturePage(currentPage)) {'),
  'Legacy premium current-page gate is active again.');
assertOk(index.includes('function isDeniedWebsiteAccess()'),
  'Definitive-deny helper for website access is missing.');
assertOk(index.includes("body:JSON.stringify({action:'portfolio_access'})"),
  'Website access no longer checks the approval-based endpoint.');
assertOk(!index.includes("fetch('/api/login-user?action=premium-access-status'"),
  'Website access is coupled to subscription entitlement again.');

// --- 5. Startup watchdog cannot bounce a signed-in view -------------------
assertOk(!index.includes("setTimeout(function() { if (document.getElementById('initialLoader')) renderStartupFallback(); }, 4500);"),
  'Unguarded startup watchdog returned.');
assertOk(index.includes("var loader=document.getElementById('initialLoader'); if (loader && !loader.classList.contains('hidden')) renderStartupFallback();"),
  'Guarded startup watchdog is missing.');
assertOk(index.includes('if (activeView) return;'),
  'renderStartupFallback no longer preserves the active view.');

// --- 6. Runtime scripts included exactly once -----------------------------
[
  '/website-approved-access.js?v=',
  '/admin-user-delete-enhancement.js?v=',
  '/ai-chat-renderer.js?v=',
  '/stock-analysis-ai.js?v='
].forEach(function (src) {
  const count = countOccurrences(index, '<script src="' + src);
  assertOk(count === 1, src + ' must be included exactly once in index.html (found ' + count + ')');
});

// --- 7. Renderer and observers --------------------------------------------
const renderer = read('public/ai-chat-renderer.js');
assertOk(!/characterData\s*:\s*true/.test(renderer), 'AI renderer characterData feedback loop returned.');
assertOk(renderer.includes("el.classList.contains('ai-rich-text') && !el.hasAttribute('data-ai-raw')"),
  'AI renderer no longer preserves pre-rendered content.');
assertOk(!/characterData\s*:\s*true/.test(index), 'index.html observes characterData it rewrites.');
assertOk(!index.includes('document.write('), 'document.write returned to index.html.');

// --- 8. Portfolio page ------------------------------------------------------
const portfolio = read('public/portfolio-planner.html');
assertOk(portfolio.includes('.ai-shell{display:grid;grid-template-columns:1fr;'),
  'Portfolio AI layout is not vertical.');
assertOk(!/\.ai-messages\{[^}]*overflow\s*:\s*auto/.test(portfolio),
  'Portfolio chat regained a nested scrollbar.');
assertOk(portfolio.includes('var ACCESS_TIMEOUT_MS=9000'),
  'Portfolio access check lost its bounded timeout.');
assertOk(portfolio.includes("$('retryAccess').onclick=checkAccess"),
  'Portfolio access failure lost its retry button.');
assertOk(!portfolio.includes('document.write('), 'document.write returned to the portfolio page.');

const portfolioRuntime = read('public/portfolio-ai-runtime-v2.js');
assertOk(portfolioRuntime.includes('previous.role !== row.role'),
  'Portfolio chat duplicate cleanup is missing.');
assertOk(portfolioRuntime.includes('if (!text || state.sending) return;'),
  'Portfolio AI send lock is missing.');

// --- 9. Routing and dead files ---------------------------------------------
const vercel = JSON.parse(read('vercel.json'));
const dashboardRewrite = (vercel.rewrites || []).find(function (row) { return row.source === '/dashboard'; });
assertOk(dashboardRewrite && dashboardRewrite.destination === '/index.html',
  '/dashboard must rewrite directly to /index.html.');
assertOk(!JSON.stringify(vercel).includes('dashboard-loader'),
  'vercel.json references dashboard-loader again.');

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
