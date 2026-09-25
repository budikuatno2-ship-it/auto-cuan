'use strict';
// One-shot helper: register the 4 PR #760 test files into curated-build-tests.json
// so the full regression suite actually runs them (F-012/F-095 gate).
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const file = path.join(ROOT, 'tools', 'curated-build-tests.json');
const list = JSON.parse(fs.readFileSync(file, 'utf8'));

const missing = [
  'test/ai-provider.test.js',
  'test/bandarmologi-flow.test.js',
  'test/screener-runner.test.js',
  'test/telegram-gatekeeper.test.js'
];

let added = 0;
for (const entry of missing) {
  if (!list.includes(entry)) {
    list.push(entry);
    added++;
  }
}

// Keep the list sorted for stable diffs.
list.sort();

fs.writeFileSync(file, JSON.stringify(list, null, 2) + '\n', 'utf8');
console.log('ADDED=' + added);
console.log('TOTAL=' + list.length);
for (const entry of missing) {
  console.log((list.includes(entry) ? 'OK   ' : 'MISS ') + entry);
}
