#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');

const fns = ['switchAdminTab', 'switchAnalisisSubTab', 'switchAnalisisTab', 'openNewAdminNoteDrawer',
  'selectFinancialTicker', 'refreshFinancialData', 'openAccountCenter', 'openAccountSubscription',
  'loadMarketStructure', 'loadInsiderNetwork', 'loadRanking', 'setBandarSection'];

const files = fs.readdirSync(PUB).filter(f => /\.js$/i.test(f));
const index = {};

for (const f of files) {
  const src = fs.readFileSync(path.join(PUB, f), 'utf8');
  for (const fn of fns) {
    const re = new RegExp('(?:function\\s+' + fn + '\\s*\\()|(?:' + fn + '\\s*[:=]\\s*(?:async\\s*)?function)|(?:window\\.' + fn + '\\s*=)');
    if (re.test(src)) {
      index[fn] = index[fn] || [];
      index[fn].push(f);
    }
  }
}

// Also check index.html inline
const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
for (const fn of fns) {
  const re = new RegExp('(?:function\\s+' + fn + '\\s*\\()');
  if (re.test(html)) {
    index[fn] = index[fn] || [];
    index[fn].push('index.html(inline)');
  }
}

for (const fn of fns) {
  console.log(fn.padEnd(28) + (index[fn] ? index[fn].join(', ') : '(NOT FOUND)'));
}

console.log('');
console.log('=== SCRIPT TAGS in index.html ===');
for (const line of html.split('\n')) {
  if (/<script[^>]*src=/.test(line)) console.log('  ' + line.trim().slice(0, 160));
}
