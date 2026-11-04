#!/usr/bin/env node
'use strict';
// FASE 20 probe: URL->page routing, admin detection, premium gating, bandarmologi sections
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const lines = html.split('\n');

function showLines(re, label, max) {
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) hits.push((i + 1) + ': ' + lines[i].trim().slice(0, 220));
  }
  console.log('=== ' + label + ' (' + hits.length + ') ===');
  console.log(hits.slice(0, max || 60).join('\n'));
  console.log('');
}

showLines(/searchParams\.get\(\s*['"]page['"]\s*\)/, 'page query param');
showLines(/searchParams\.get\(\s*['"]tab['"]\s*\)/, 'tab query param');
showLines(/function isAdmin\s*\(/, 'isAdmin def');
showLines(/function hasConfirmedPremiumAccess\s*\(/, 'hasConfirmedPremiumAccess def');
showLines(/function isPremiumFeaturePage\s*\(/, 'isPremiumFeaturePage def');
showLines(/BANDAR_SECTION_TABS/, 'BANDAR_SECTION_TABS');
showLines(/function initFromUrl|function resolveInitial|function bootRoute|function applyInitialRoute/, 'boot route fn');

// print isAdmin body
function printFn(name) {
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp('function\\s+' + name + '\\s*\\(').test(lines[i])) {
      let depth = 0, started = false, end = i;
      for (let j = i; j < Math.min(lines.length, i + 80); j++) {
        for (const ch of lines[j]) { if (ch === '{') { depth++; started = true; } else if (ch === '}') depth--; }
        if (started && depth === 0) { end = j; break; }
      }
      console.log('=== fn ' + name + ' (lines ' + (i + 1) + '-' + (end + 1) + ') ===');
      console.log(lines.slice(i, end + 1).join('\n').slice(0, 3000));
      console.log('');
      return;
    }
  }
  console.log('=== fn ' + name + ': NOT FOUND ===\n');
}

printFn('isAdmin');
printFn('hasConfirmedPremiumAccess');
printFn('isPremiumFeaturePage');
printFn('isDeniedWebsiteAccess');
