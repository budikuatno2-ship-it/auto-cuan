#!/usr/bin/env node
'use strict';
// FASE 20 probe: extract the SPA navigation contract (navigateTo, page keys, query params)
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const lines = html.split('\n');

function sliceFn(name) {
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp('function\\s+' + name + '\\s*\\(').test(lines[i])) {
      const start = i;
      let depth = 0, end = i, started = false;
      for (let j = i; j < Math.min(lines.length, i + 400); j++) {
        for (const ch of lines[j]) {
          if (ch === '{') { depth++; started = true; }
          else if (ch === '}') { depth--; }
        }
        if (started && depth === 0) { end = j; break; }
      }
      return { name, startLine: start + 1, endLine: end + 1, text: lines.slice(start, end + 1).join('\n') };
    }
  }
  return null;
}

const targets = ['navigateTo', 'setRoute', 'showPage', 'openPortfolioTab', 'switchAnalisisTab', 'switchScreenerType', 'toggleSektorView', 'showGroupDetail', 'switchAdminTab', 'showAdminTab', 'openPatternTab', 'applyPremiumAccessUi'];
const found = {};
for (const t of targets) {
  const r = sliceFn(t);
  if (r) found[t] = r;
}

const outPath = path.join(ROOT, 'tools', 'fase20-nav-probe.json');
fs.writeFileSync(outPath, JSON.stringify(found, null, 2));

for (const [k, v] of Object.entries(found)) {
  console.log('==== ' + k + ' (lines ' + v.startLine + '-' + v.endLine + ') ====');
  console.log(v.text.split('\n').slice(0, 60).join('\n'));
  console.log('');
}
console.log('Wrote', outPath);
