'use strict';
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, 'gates', 'gate-C10.js');
let s = fs.readFileSync(p, 'utf8');
const oldBlock = "        const ov = await pg.evaluate(() => {\n          const de = document.documentElement;\n          return { sw: de.scrollWidth, iw: window.innerWidth, diff: de.scrollWidth - window.innerWidth };\n        });\n        const ok = ov.diff === 0;\n        rows.push({ w, ok, diff: ov.diff, sw: ov.sw, iw: ov.iw });";
const newBlock = "        const ov = await pg.evaluate(() => {\n          const de = document.documentElement;\n          const diff = de.scrollWidth - window.innerWidth;\n          return { sw: de.scrollWidth, iw: window.innerWidth, diff, overflow: Math.max(0, diff) };\n        });\n        const ok = ov.overflow === 0;\n        rows.push({ w, ok, diff: ov.diff, overflow: ov.overflow, sw: ov.sw, iw: ov.iw });";
if (!s.includes(oldBlock)) { console.log('pattern missing'); process.exit(1); }
s = s.replace(oldBlock, newBlock);
s = s.split("rows.map((r) => r.w + 'px:diff=' + r.diff + (r.ok ? '' : ':FAIL')).join(' | ')").join("rows.map((r) => r.w + 'px:overflow=' + r.overflow + ' (diff=' + r.diff + ')' + (r.ok ? '' : ':FAIL')).join(' | ')");
s = s.split("a4pass, 'static overflow-clip+scroll+pad760 + live 4 viewport diff0'").join("a4pass, 'static overflow-clip+scroll+pad760 + live 4 viewport overflow0'");
fs.writeFileSync(p, s);
console.log('gate-C10 A4 measurement fixed');
