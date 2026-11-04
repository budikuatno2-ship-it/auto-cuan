#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const lines = html.split('\n');

const fns = ['selectFinancialTicker', 'loadChartPage', 'openAccountCenter', 'openAccountSubscription',
  'switchAdminTab', 'switchAnalisisSubTab', 'openNewAdminNoteDrawer', 'switchAnalisisTab',
  'setBandarSection', 'renderPortfolioView', 'loadPortfolio', 'refreshFinancialData',
  'selectMarketStructureTicker', 'loadMarketStructure', 'loadInsiderNetwork', 'loadRanking'];

console.log('=== FUNCTION PRESENCE ===');
for (const f of fns) {
  const re = new RegExp('function\\s+' + f + '\\s*\\(|' + f + '\\s*:\\s*function');
  console.log(f.padEnd(30) + (re.test(html) ? 'DEFINED' : 'MISSING'));
}

console.log('');
console.log('=== ACCOUNT CENTER STRUCTURE ===');
for (let i = 0; i < lines.length; i++) {
  const s = lines[i];
  if (/accountCenter|account-center|acTab|acctTab|tabProfile|tabSubscription/i.test(s) && s.length < 260) {
    console.log((i + 1) + ': ' + s.trim().slice(0, 190));
  }
}

console.log('');
console.log('=== FINANCIAL TICKER CHIPS + TABLES ===');
for (let i = 0; i < lines.length; i++) {
  if (/selectFinancialTicker|financialStatementsTable|finPeriodSelect|finReportType/i.test(lines[i]) && lines[i].length < 300) {
    console.log((i + 1) + ': ' + lines[i].trim().slice(0, 190));
  }
}

console.log('');
console.log('=== CHART PAGE STRUCTURE ===');
for (let i = 0; i < lines.length; i++) {
  if (/id="(chartPage|chartContainer|chartWrap|chartCanvas|tvChart|chartEmptyState)"/.test(lines[i])) {
    console.log((i + 1) + ': ' + lines[i].trim().slice(0, 190));
  }
}
