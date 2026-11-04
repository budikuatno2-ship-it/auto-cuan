#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'public', 'account-center-v1.js'), 'utf8');
const lines = src.split('\n');

// print tab button markup (data-ac-tab)
for (let i = 0; i < lines.length; i++) {
  if (/data-ac-tab/.test(lines[i])) {
    console.log((i + 1) + ': ' + lines[i].trim().slice(0, 300));
  }
}

console.log('');
console.log('=== openAccountCenter / openAccountSubscription window exports ===');
for (let i = 0; i < lines.length; i++) {
  if (/window\.(openAccountCenter|openAccountSubscription|closeAccountCenter)\s*=/.test(lines[i])) {
    console.log((i + 1) + ': ' + lines[i].trim().slice(0, 200));
  }
}

console.log('');
console.log('=== switchTab function ===');
for (let i = 0; i < lines.length; i++) {
  if (/function switchTab\s*\(/.test(lines[i])) {
    console.log(lines.slice(i, Math.min(i + 22, lines.length)).join('\n').slice(0, 1400));
    break;
  }
}

console.log('');
console.log('=== tabs array / TAB definitions ===');
for (let i = 0; i < lines.length; i++) {
  if (/TAB|tabs\s*=|icon:|label:/.test(lines[i]) && i < 260) {
    console.log((i + 1) + ': ' + lines[i].trim().slice(0, 200));
  }
}
