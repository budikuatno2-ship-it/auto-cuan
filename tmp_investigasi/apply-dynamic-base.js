'use strict';
// One-off codemod: make every bridge URL resolve the base per call.
const fs = require('node:fs');
const p = 'lib/vps-data-fetcher.js';
let s = fs.readFileSync(p, 'utf8');

const literal = '${VPS_DATA_API_BASE}';
const dynamic = '${getVpsDataApiBase()}';
const before = s.split(literal).length - 1;
s = s.split(literal).join(dynamic);
fs.writeFileSync(p, s, 'utf8');

const after = s.split(dynamic).length - 1;
console.log('template occurrences replaced:', before);
console.log('dynamic occurrences now:', after);
console.log('remaining frozen-in-URL:', s.split(literal).length - 1);
