#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const FILES = [
  'deploy/vps/run-screeners-preflight.sh',
  'deploy/vps/run-screener-dispatch.sh',
  'deploy/vps/run-daily-afternoon-recap.sh',
  'deploy/vps/run-ihsg-candle.sh',
  'deploy/vps/run-lifecycle-evaluator.sh',
  'deploy/vps/run-fastwatcher.sh',
  'deploy/vps/lib/load-env.sh'
];

for (const f of FILES) {
  const p = path.resolve(__dirname, '..', f);
  console.log('══════════ ' + f + ' ══════════');
  if (!fs.existsSync(p)) {
    console.log('(HILANG)');
    console.log('');
    continue;
  }
  const text = fs.readFileSync(p, 'utf8');
  console.log(text.split(/\r?\n/).slice(0, 70).join('\n'));
  console.log('');
}

console.log('══════════ grep catatan-admin ══════════');
const roots = ['deploy', 'tools', 'scripts', 'lib', 'api'];
const hits = [];
for (const root of roots) {
  const dir = path.resolve(__dirname, '..', root);
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.(js|sh|json|md)$/.test(e.name)) continue;
      let t = '';
      try { t = fs.readFileSync(full, 'utf8'); } catch (_) { continue; }
      if (/catatan-admin|catatanAdmin|admin-notes|adminNotes/i.test(t)) {
        hits.push(path.relative(path.resolve(__dirname, '..'), full));
      }
    }
  };
  walk(dir);
}
console.log(hits.slice(0, 60).join('\n') || '(tidak ada)');
