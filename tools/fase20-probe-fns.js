#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const lines = html.split('\n');

function printFn(name, maxLines) {
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp('function\\s+' + name + '\\s*\\(').test(lines[i])) {
      let depth = 0, started = false, end = i;
      for (let j = i; j < Math.min(lines.length, i + 200); j++) {
        for (const ch of lines[j]) { if (ch === '{') { depth++; started = true; } else if (ch === '}') depth--; }
        if (started && depth === 0) { end = j; break; }
      }
      console.log('==== ' + name + ' (' + (i + 1) + '-' + (end + 1) + ') ====');
      console.log(lines.slice(i, Math.min(end + 1, i + (maxLines || 30))).join('\n').slice(0, 2400));
      console.log('');
      return true;
    }
  }
  console.log('==== ' + name + ': NOT FOUND ====\n');
  return false;
}

['switchAnalisisTab', 'switchAnalisisSubTab', 'toggleSektorView', 'showGroupDetail',
 'switchScreenerType'].forEach(n => printFn(n, 26));

console.log('==== portfolio tab fns ====');
const portFns = [];
lines.forEach((s, i) => { if (/function\s+\w*[Pp]ort\w*Tab\w*\s*\(/.test(s)) portFns.push((i + 1) + ': ' + s.trim()); });
console.log(portFns.join('\n') || '(none)');

console.log('');
console.log('==== admin tab fns ====');
const admFns = [];
lines.forEach((s, i) => { if (/function\s+\w*(Admin|admin)\w*(Tab|Panel)\w*\s*\(/.test(s)) admFns.push((i + 1) + ': ' + s.trim()); });
console.log(admFns.join('\n') || '(none)');

console.log('');
console.log('==== chart workstation mode fns ====');
const cwFns = [];
lines.forEach((s, i) => {
  if (/applyPreset|MODE_STRATEGY|chartPreset|switchChartMode|setChartMode/i.test(s) && /function|var MODE|const MODE|applyPreset\s*[:=]/.test(s)) {
    cwFns.push((i + 1) + ': ' + s.trim().slice(0, 160));
  }
});
console.log(cwFns.slice(0, 30).join('\n') || '(none)');

console.log('');
console.log('==== data-admin-tab buttons ====');
const m = html.match(/data-admin-tab="\d+"[\s\S]{0,220}?<\/button>/gi) || [];
m.forEach(x => console.log('  ' + x.replace(/\s+/g, ' ').slice(0, 160)));
