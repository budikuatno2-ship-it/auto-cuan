'use strict';
var fs = require('fs');
var p = 'tools/verify-fase17.js';
var code = fs.readFileSync('tools/capture-wave10-evidence.js','utf8');
code = code.replace(/Wave10-Evidence/g,'Fase17');
code = code.replace(/wave10-/g,'fase17-');
code = code.replace(/OUT_DIRS[\s\S]*?saveScreenshot/g,'OUT_DIR');
code = code.replace(/const OUT_DIR = [\s\S]*?}\n\n/,
  'var OUT_DIR = path.join(ROOT_DIR, \"bukti-verifikasi-final\", \"fase17\");\n' +
  'if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });\n\n');
fs.writeFileSync(p, code, 'utf8');
console.log('Written verify-fase17.js (interim)');