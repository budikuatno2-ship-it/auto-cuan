#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');

for (const f of ['account-center-v1.js', 'account-center-lazy-loader-v1.js']) {
  const p = path.join(PUB, f);
  if (!fs.existsSync(p)) { console.log(f + ': MISSING'); continue; }
  const src = fs.readFileSync(p, 'utf8');
  console.log('==== ' + f + ' (' + src.length + ' bytes) ====');
  const lines = src.split('\n');
  lines.forEach((s, i) => {
    if (/data-ac-tab|acTab|tab-|panel|SECTIONS|section/i.test(s) && s.length < 220) {
      console.log((i + 1) + ': ' + s.trim().slice(0, 170));
    }
  });
  console.log('');
}

// Also find account center markup in index.html
const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
console.log('==== index.html account center markup ====');
html.split('\n').forEach((s, i) => {
  if (/id="acAccountCenter"|data-account-section|ac-section|accTab|acct-/.test(s) && s.length < 260) {
    console.log((i + 1) + ': ' + s.trim().slice(0, 200));
  }
});
