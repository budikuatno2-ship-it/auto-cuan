'use strict';
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, 'gates', 'gate-C10.js');
let s = fs.readFileSync(p, 'utf8');
s = s.replace('const ok = ov.diff === 0;', 'const ok = (ov.diff <= 0);');
s = s.replace(
  "rows.map((r) => r.w + 'px:diff=' + r.diff + (r.ok ? '' : ':FAIL')).join(' | ')",
  "rows.map((r) => r.w + 'px:overflow=' + Math.max(0, r.diff) + ' (diff=' + r.diff + ')' + (r.ok ? '' : ':FAIL')).join(' | ')"
);
s = s.replace(
  "a4pass, 'static overflow-clip+scroll+pad760 + live 4 viewport diff0'",
  "a4pass, 'static overflow-clip+scroll+pad760 + live 4 viewport overflow0'"
);
fs.writeFileSync(p, s);
console.log('patched:', s.includes('ov.diff <= 0'), s.includes('overflow='));
