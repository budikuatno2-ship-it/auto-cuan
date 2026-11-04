#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const p = path.join(ROOT, 'bukti-verifikasi-final', 'fase20', 'tabel-pixel-diff-dan-overflow.json');
const t = JSON.parse(fs.readFileSync(p, 'utf8'));

console.log('== SUMMARY ==');
console.log(JSON.stringify(t.summary, null, 2));

console.log('');
console.log('== CONSOLE ERRORS (non-zero) ==');
for (const pg of t.pages) {
  if (pg.consoleErrors || pg.pageErrors) {
    console.log(pg.shot, 'cErr=' + pg.consoleErrors, 'pErr=' + pg.pageErrors);
    for (const [combo, c] of Object.entries(pg.combos || {})) {
      if (c.consoleErrors) console.log('   ', combo, JSON.stringify(c));
    }
  }
}
for (const ex of t.extras || []) {
  if (ex.consoleErrors || ex.pageErrors) console.log('EXTRA', ex.shot, 'cErr=' + ex.consoleErrors, 'pErr=' + ex.pageErrors);
}

console.log('');
console.log('== PER-PAGE PIXEL DIFF / DELTA Y ==');
for (const pg of t.pages) {
  console.log(String(pg.pixelDiffPct).padStart(7) + '%  deltaY=' + String(pg.deltaYPx).padStart(5) +
    '  ' + pg.shot.padEnd(28) + ' canvas=' + (pg.canvas || '-') +
    ' panel=' + (pg.panel3Kb || '-') + 'KB');
}

console.log('');
console.log('== SPINNER / ERROR BANNER / GATES ==');
for (const pg of t.pages) {
  const flags = [];
  if (pg.spinnerVisibleAny) flags.push('spinner');
  if (pg.errorBannerVisibleAny) flags.push('errorBanner');
  if (pg.maintenanceGateAny) flags.push('maintenanceGate');
  if (pg.serviceStatusGateAny) flags.push('serviceStatusGate');
  if (flags.length) console.log('  ' + pg.shot + ': ' + flags.join(','));
}

console.log('');
console.log('== ACTION RESULTS (extras) ==');
for (const ex of t.extras || []) {
  console.log('  ' + ex.shot.padEnd(32) + ' nonBlank=' + ex.nonBlank + ' kb=' + ex.kb);
}
