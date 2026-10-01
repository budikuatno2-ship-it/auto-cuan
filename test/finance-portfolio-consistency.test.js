'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const portfolio = read('public/portfolio-command-center.js');
const finance = read('public/money-sheet-runtime.js');

test('SPA Portfolio loads the canonical persistence bridge after server entitlement', () => {
  assert.match(portfolio, /action: 'portfolio_access'/);
  assert.match(portfolio, /portfolio-supabase-sync\.js\?v=20261001-consistency-v1/);
  assert.match(portfolio, /window\.__AUTOCUAN_PORTFOLIO_ACCESS__/);
  const accessAt = portfolio.indexOf("window.__AUTOCUAN_PORTFOLIO_ACCESS__");
  const syncAt = portfolio.indexOf("portfolio-supabase-sync.js?v=20261001-consistency-v1");
  assert.ok(accessAt >= 0 && syncAt > accessAt, 'sync bridge must start only after verified access');
});

test('Portfolio access retries one timeout without bypassing server verification', () => {
  assert.match(portfolio, /async function fetchPortfolioAccess\(\)/);
  assert.match(portfolio, /for \(var attempt = 0; attempt < 2; attempt\+\+\)/);
  assert.match(portfolio, /error\.name !== 'AbortError'/);
  assert.doesNotMatch(portfolio, /portfolio_access[^\n]{0,120}(?:localStorage|__AUTOCUAN_PORTFOLIO_ACCESS__)\s*\?/);
});

test('Finance treats local portfolio as preview and still reconciles against cloud', () => {
  const start = finance.indexOf('async function refreshPortfolio(force)');
  const end = finance.indexOf('function queuePortfolio()', start);
  const body = finance.slice(start, end);
  assert.match(body, /Cache perangkat · memeriksa cloud/);
  assert.match(body, /\/api\/money-management\?action=portfolio-summary/);
  assert.match(body, /Cloud · sumber Portofolio resmi/);
  assert.doesNotMatch(body, /if \(local[^\n]*!== undefined\)[^\n]*return/);
});

test('Finance month navigation is cancelable and failed loads preserve the last good worksheet', () => {
  assert.match(finance, /\$\('mmSheetMonth'\)\.disabled = saving/);
  assert.match(finance, /requests\.forEach\(function \(controller\) \{ controller\.abort\(\); \}\)/);
  assert.match(finance, /const previous = \{/);
  assert.match(finance, /if \(previous\.sheet\) \{/);
  assert.match(finance, /month = previous\.month/);
  assert.match(finance, /Data sebelumnya dipertahankan/);
});

test('Finance tracks last successfully loaded month separately from in-flight selection', () => {
  assert.match(finance, /loadedMonth = null/);
  assert.match(finance, /month: loadedMonth \|\| month/);
  assert.match(finance, /const requestMonth = nextMonth/);
  assert.match(finance, /loadedMonth = requestMonth/);
  assert.match(finance, /loadedMonth = previous\.month/);
});

test('Portfolio hydration preserves local edits made while cloud load is in flight', () => {
  const sync = read('public/portfolio-supabase-sync.js');
  assert.match(sync, /bootstrapSerialized = JSON\.stringify\(bootstrap\)/);
  assert.match(sync, /changedDuringHydrate = currentSerialized !== bootstrapSerialized/);
  assert.match(sync, /setStatus\('pending', 'Perubahan lokal menunggu sinkronisasi'\)/);
  assert.match(sync, /scheduleSave\(\)/);
});

test('Portfolio change events stay scoped to Portfolio and do not wake Kelola Keuangan', () => {
  const sync = read('public/portfolio-supabase-sync.js');
  assert.match(sync, /addEventListener\('autocuan:portfolio-changed'/);
  assert.match(sync, /dirty = true/);
  assert.match(sync, /autocuan:portfolio-synced/);
  assert.doesNotMatch(finance, /addEventListener\('autocuan:portfolio-synced'/);
  assert.doesNotMatch(finance, /addEventListener\('autocuan:portfolio-changed'/);
});
