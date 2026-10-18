'use strict';

const fs = require('fs');
const path = require('path');

const roots = ['lib', 'api', 'tools', 'scripts'];
const patterns = [
  { name: 'broker-summary', regex: /broker-summary/i },
  { name: 'broker-accumulation', regex: /broker-accumulation/i },
  { name: 'insiders', regex: /insiders\b/i },
  { name: 'readLocalBrokerSummary', regex: /readLocalBrokerSummary/ },
  { name: 'readLocalBrokerAccumulation', regex: /readLocalBrokerAccumulation/ },
  { name: 'readLocalInsiders', regex: /readLocalInsiders/ },
  { name: 'readDiskCache', regex: /readDiskCache\s*\(/ },
  { name: 'hasDiskCache', regex: /hasDiskCache\s*\(/ },
  { name: 'listDiskDates', regex: /listDiskDates\s*\(/ }
];

const results = {};
for (const p of patterns) results[p.name] = [];

for (const root of roots) {
  if (!fs.existsSync(root)) continue;
  const walk = (d) => {
    for (const f of fs.readdirSync(d)) {
      const fp = path.join(d, f);
      try {
        if (fs.statSync(fp).isDirectory()) walk(fp);
        else if (f.endsWith('.js')) {
          const content = fs.readFileSync(fp, 'utf8');
          const lines = content.split('\n');
          for (const pat of patterns) {
            for (let i = 0; i < lines.length; i++) {
              if (pat.regex.test(lines[i])) {
                results[pat.name].push({ file: fp, line: i + 1, code: lines[i].trim().slice(0, 110) });
              }
            }
          }
        }
      } catch (_) {}
    }
  };
  walk(root);
}

const summary = {};
for (const k of Object.keys(results)) {
  summary[k] = {
    count: results[k].length,
    uniqueFiles: Array.from(new Set(results[k].map(r => r.file))).length,
    samples: results[k].slice(0, 12)
  };
}

console.log(JSON.stringify(summary, null, 2));
