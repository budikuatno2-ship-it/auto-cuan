'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function extractFunction(signature) {
  const start = html.indexOf(signature);
  assert.ok(start >= 0, `missing ${signature}`);
  const open = html.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < html.length; i += 1) {
    if (html[i] === '{') depth += 1;
    if (html[i] === '}') { depth -= 1; if (depth === 0) return html.slice(start, i + 1); }
  }
  throw new Error(`unbalanced ${signature}`);
}

const pages = ['dashboard', 'analisis', 'sektor', 'screener', 'chart', 'portofolio'];

test('all application routes have page-content shells and no shared vertical centering', () => {
  for (const page of pages) {
    assert.match(html, new RegExp(`<div id="page-${page}" class="page-content(?:[^\"]*)"`), page);
  }
  const css = html.slice(html.indexOf('<style'), html.indexOf('</style>'));
  assert.match(css, /\.page-content \{[^}]*align-self: stretch;[^}]*min-height: 0;/);
  assert.doesNotMatch(css, /\.page-content\s*\{[^}]*?(?:justify-content:\s*(?:center|flex-end)|place-content:\s*center|margin-top:\s*auto)/);
});

test('navigation shows its page shell before starting the page fetch', () => {
  const source = extractFunction('function navigateTo');
  assert.ok(source.indexOf("target.classList.remove('hidden')") < source.indexOf('loadSektorHot()'));
  assert.ok(source.indexOf("target.classList.remove('hidden')") < source.indexOf('loadSwingScreener()'));
  assert.ok(source.indexOf("target.classList.remove('hidden')") < source.indexOf('renderPortfolio()'));
  assert.doesNotMatch(source, /hasConfirmedPremiumAccess|navigateTo\('subscription'\)/);
});

test('page selection hides every other shell synchronously and prevents duplicate initialization', () => {
  const source = extractFunction('function navigateTo');
  const shells = Object.fromEntries(pages.map((page) => [page, {
    classList: { values: new Set(page === 'dashboard' ? [] : ['hidden']), add(...v) { v.forEach(x => this.values.add(x)); }, remove(...v) { v.forEach(x => this.values.delete(x)); }, contains(v) { return this.values.has(v); } }
  }]));
  const gates = { sektorLoginGate: { classList: { add() {}, remove() {} } }, sektorContent: { classList: { add() {}, remove() {} } } };
  const navButtons = pages.map((page) => ({ page, classList: { add() {}, remove() {} }, getAttribute() { return this.page; } }));
  let sectorFetches = 0;
  const document = {
    getElementById(id) { return shells[id.replace('page-', '')] || gates[id] || null; },
    querySelectorAll(selector) { return selector === '.page-content' ? Object.values(shells) : navButtons; },
    querySelector() { return null; }
  };
  const navigateTo = new Function('document', 'window', 'isAdmin', 'isLoggedInUser', 'loadSektorHot', 'loadSwingScreener', 'renderPortfolio', 'loadDashboardTop5Monitor', 'scheduleTop5HistoryLoad', 'startDashboardMonitorAutoRefresh', 'stopDashboardMonitorAutoRefresh', 'clearTop5HistoryLoadTimer', 'loadSubscriptionExperience', 'currentPage', `${source}; return navigateTo;`)(
    document, { scrollTo() {} }, () => false, () => true, () => { sectorFetches += 1; }, () => {}, () => {}, () => {}, () => {}, () => {}, () => {}, () => {}, () => {}, 'dashboard'
  );
  navigateTo('sektor');
  assert.equal(shells.sektor.classList.contains('hidden'), false);
  for (const page of pages.filter(page => page !== 'sektor')) assert.equal(shells[page].classList.contains('hidden'), true, page);
  assert.equal(sectorFetches, 1);
  navigateTo('sektor');
  assert.equal(sectorFetches, 1, 'repeated click must not reinitialize the already-visible page');
});

test('startup has no subscription access request and the watchdog respects a hidden loader', () => {
  const topLevel = extractFunction('function setTopLevelView');
  assert.doesNotMatch(topLevel, /loadPremiumAccess|resetPremiumAccess|subscription/);
  assert.match(html, /var loader = document\.getElementById\('initialLoader'\); if \(loader && !loader\.classList\.contains\('hidden'\)\) renderStartupFallback\(\)/);
  assert.equal(fs.readdirSync(path.join(__dirname, '..', 'api')).filter(file => file.endsWith('.js')).length, 12);
});
