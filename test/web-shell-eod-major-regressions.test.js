'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const index = read('public/index.html');
const analysis = read('public/analisis-saham-runtime.js');
const auth = read('public/auth-v2.js');
const profile = read('lib/account-profile-handler.js');
const legacy = read('lib/reset-password-legacy-handler.js');
const cron = read('deploy/vps/final-schedule.cron');
const eod = read('deploy/vps/run-eod-market-data.sh');
const eodInstaller = read('deploy/vps/install-eod-market-data-cron.sh');
const money = read('public/money-sheet-runtime.js');
const moneyCss = read('public/money-sheet.css');
const landing = read('public/landing-experience.js');
const finalCss = read('public/final-uiux-polish.css');

test('blank Financial and Struktur Pasar destinations are removed and legacy URLs redirect safely', () => {
  assert.doesNotMatch(index, /data-analysis-tab="financial"/);
  assert.doesNotMatch(index, /data-analysis-tab="market-structure"/);
  assert.doesNotMatch(index, /id="tabFinancial"/);
  assert.doesNotMatch(index, /id="tabMarketStructure"/);
  assert.match(analysis, /tabName === 'financial' \|\| tabName === 'market-structure'/);
  assert.match(analysis, /tabName = 'analisis-chart'/);
});

test('SPA partial loader prefers the external current partial over stale embedded fallback', () => {
  const start = index.indexOf('async function loadTabPartial');
  const end = index.indexOf('function initTabScripts', start);
  const loader = index.slice(start, end);
  assert.ok(loader.indexOf('fetch(partialUrl') >= 0);
  assert.ok(loader.indexOf("document.getElementById('tpl-' + tabId)") > loader.indexOf('fetch(partialUrl'));
  assert.match(loader, /cache:'no-cache'/);
});

test('sidebar exposes Subscription and Logout without hiding them behind the profile badge', () => {
  assert.match(index, /class="sidebar-account-actions"/);
  assert.match(index, />Subscription<\/span>/);
  assert.match(index, />Logout<\/span>/);
  assert.match(finalCss, /\.sidebar-account-action/);
});

test('legacy users without Gmail are blocked by mandatory onboarding with server-side exact Gmail update', () => {
  assert.match(legacy, /gmailRequired:/);
  assert.match(legacy, /@gmail\\?\.com|gmail\\?\.com/);
  assert.match(auth, /authV2LegacyGmailModal/);
  assert.match(auth, /account-profile-set-gmail/);
  assert.match(auth, /window\.__AUTOCUAN_GMAIL_ONBOARDING_REQUIRED__/);
  assert.match(profile, /action === 'account-profile-set-gmail'/);
  assert.match(profile, /GMAIL_IN_USE/);
  assert.match(profile, /updateQuery = updateQuery\.is\('email', null\)/);
});

test('research and landing motion use compositor animations and honor reduced motion', () => {
  assert.match(analysis, /function animateWorkspacePanel/);
  assert.match(analysis, /translate3d\(10px,0,0\)/);
  assert.match(analysis, /prefers-reduced-motion: reduce/);
  assert.match(landing, /heroEntrance/);
  assert.match(landing, /landing-hero-copy/);
  assert.match(landing, /fill: 'backwards'/);
});

test('Kelola Keuangan no longer auto-refreshes Portfolio and hides advanced chrome by default', () => {
  assert.doesNotMatch(money, /renderRows\(null, true\); refreshPortfolio\(true\)/);
  assert.doesNotMatch(money, /autocuan:portfolio-changed/);
  assert.match(moneyCss, /#page-money-management \.ms-portfolio/);
  assert.match(moneyCss, /#page-money-management \.ms-edit-toolbar/);
});

test('canonical EOD cron is recurring WIB hourly and owns all requested datasets', () => {
  assert.match(cron, /^CRON_TZ=Asia\/Jakarta$/m);
  assert.match(cron, /^0 18-23 \* \* 1-5 bash \/home\/ubuntu\/auto-cuan\/deploy\/vps\/run-eod-market-data\.sh/m);
  assert.match(cron, /^30 7 \* \* 1-5 \/home\/ubuntu\/auto-cuan\/deploy\/vps\/run-daily-broker-update\.sh --limit 5000 --final/m);
  assert.doesNotMatch(cron, /^[^#\n]*run-daily-broker-update\.sh/m);
  assert.doesNotMatch(cron, /^[^#\n]*run-daily-candles\.sh/m);
  assert.match(eod, /run-daily-broker-update\.sh/);
  assert.match(eod, /run-daily-candles\.sh/);
  assert.match(eod, /--final/);
  assert.match(eod, /export TZ=Asia\/Jakarta/);
  assert.match(eodInstaller, /run-daily-broker-update\\\.sh\|run-daily-candles\\\.sh\|run-eod-market-data\\\.sh/);
  assert.match(eodInstaller, /30 7 \* \* 1-5 .*run-daily-broker-update\.sh --limit 5000 --final/);
});

test('broker marker v2 cannot complete before accumulation and insiders complete', () => {
  const worker = read('tools/run-daily-broker-update.js');
  assert.match(worker, /schema_version: 2/);
  assert.match(worker, /aux_complete_tickers/);
  assert.match(worker, /brokerRemaining === 0 && auxiliaryRemaining === 0/);
  assert.match(worker, /fetchBrokerAccumulation/);
  assert.match(worker, /fetchInsiders/);
});
