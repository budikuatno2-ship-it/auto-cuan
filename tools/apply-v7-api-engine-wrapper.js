'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const file = path.join(__dirname, '..', 'api', 'sector-hot.js');
const oldLine = "const dtEngine = require('../lib/daytrade-screener-engine');";
const newLine = "const dtEngine = require('../lib/daytrade-screener-engine-v7');";
const source = fs.readFileSync(file, 'utf8');
const oldCount = source.split(oldLine).length - 1;
const newCount = source.split(newLine).length - 1;

if (oldCount === 0 && newCount === 1) {
  new vm.Script(source, { filename: 'api/sector-hot.js' });
  process.stdout.write('V7_API_ENGINE_ROUTER=ALREADY_APPLIED\n');
  process.exit(0);
}
if (oldCount !== 1 || newCount !== 0) {
  throw new Error(`Unexpected engine require counts: old=${oldCount}, new=${newCount}`);
}
const updated = source.replace(oldLine, newLine);
if (updated.split(newLine).length - 1 !== 1) throw new Error('V7 engine require replacement failed.');
new vm.Script(updated, { filename: 'api/sector-hot.js' });
fs.writeFileSync(file, updated);
process.stdout.write('V7_API_ENGINE_ROUTER=APPLIED\n');
