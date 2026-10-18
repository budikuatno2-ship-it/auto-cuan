'use strict';

const fs = require('fs');
const path = require('path');

const roots = ['lib', 'tools', 'api', 'docs'];
const results = {
  insiderEndpoints: [],
  insiderQuotaNotes: [],
  massMarketInsiderMentions: []
};

function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const fp = path.join(d, f);
    try {
      if (fs.statSync(fp).isDirectory()) {
        if (['node_modules', '.git', 'data'].includes(f)) continue;
        walk(fp);
      } else if (f.endsWith('.js') || f.endsWith('.md')) {
        const content = fs.readFileSync(fp, 'utf8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const ln = lines[i];
          if (/insider[^"]*\/api|api\/insider|\/api\/insiders|insider-transaction/i.test(ln)) {
            results.insiderEndpoints.push({ file: fp, line: i + 1, code: ln.trim().slice(0, 130) });
          }
          if (/mass|seluruh|market-wide|all.*emiten.*insider|insider.*all.*emiten/i.test(ln) && /insider/i.test(ln)) {
            results.massMarketInsiderMentions.push({ file: fp, line: i + 1, code: ln.trim().slice(0, 130) });
          }
        }
      }
    } catch (_) {}
  }
}

for (const r of roots) {
  if (fs.existsSync(r)) walk(r);
}

// Look at arjum-client insider endpoint
try {
  const ac = fs.readFileSync('lib/arjum-client.js', 'utf8');
  const lines = ac.split('\n');
  const startIdx = lines.findIndex(l => l.includes('async function fetchInsiders'));
  if (startIdx !== -1) {
    console.log('=== fetchInsiders implementation (lines ' + (startIdx + 1) + '-' + Math.min(startIdx + 40, lines.length) + ') ===');
    console.log(lines.slice(startIdx, startIdx + 40).map((l, i) => (startIdx + i + 1) + ': ' + l).join('\n'));
  }
} catch (_) {}

console.log('\n=== Insider endpoints found ===');
console.log('Count:', results.insiderEndpoints.length);
results.insiderEndpoints.slice(0, 25).forEach(r => console.log(`${r.file}:${r.line} ${r.code}`));

console.log('\n=== Mass market insider mentions ===');
console.log('Count:', results.massMarketInsiderMentions.length);
results.massMarketInsiderMentions.slice(0, 10).forEach(r => console.log(`${r.file}:${r.line} ${r.code}`));
