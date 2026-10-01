#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { auditRetention } = require('../lib/screener-evaluation-retention');
function parseArgs(argv) {
  const options = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--root') options.root = path.resolve(argv[++i]);
    else if (argv[i] === '--now') options.now = argv[++i];
    else throw new Error('Unknown option: ' + argv[i]);
  }
  if (!options.root) throw new Error('--root is required (the tool never assumes the VPS directory)');
  return options;
}
function main(argv = process.argv) { const report = auditRetention(parseArgs(argv)); process.stdout.write(JSON.stringify(report, null, 2) + '\n'); return report; }
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { parseArgs, main };
