#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name === 'vendor' || e.name === 'assets') continue; walk(fp, out); }
    else if (/\.(html|js)$/.test(e.name)) out.push(fp);
  }
  return out;
}
const files = walk(path.join(__dirname, '..', 'public'), []);
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  if (s.includes('type="module"') || s.includes("type='module'") || s.includes('type=module')) {
    console.log('MODULE in ' + path.relative(path.join(__dirname, '..'), f));
  }
}
console.log('done files=' + files.length);
