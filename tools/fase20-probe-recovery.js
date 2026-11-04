#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const lines = html.split('\n');

function printFn(name) {
  for (let i = 0; i < lines.length; i++) {
    const re = new RegExp('(?:function\\s+' + name + '\\s*\\()|(?:' + name + '\\s*=\\s*function)');
    if (re.test(lines[i])) {
      let depth = 0, started = false, end = i;
      for (let j = i; j < Math.min(lines.length, i + 120); j++) {
        for (const ch of lines[j]) { if (ch === '{') { depth++; started = true; } else if (ch === '}') depth--; }
        if (started && depth === 0) { end = j; break; }
      }
      console.log('==== ' + name + ' (' + (i + 1) + '-' + (end + 1) + ') ====');
      console.log(lines.slice(i, end + 1).join('\n').slice(0, 3000));
      console.log('');
      return;
    }
  }
  console.log('==== ' + name + ' NOT FOUND ====\n');
}

printFn('openSelfResetModal');
printFn('openResetPasswordModal');

// markup around selfResetModal
for (let i = 0; i < lines.length; i++) {
  if (/id="selfResetModal"/.test(lines[i])) {
    console.log('=== selfResetModal markup (line ' + (i + 1) + ') ===');
    console.log(lines.slice(Math.max(0, i - 3), i + 40).join('\n').slice(0, 3000));
  }
}
