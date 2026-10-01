#!/usr/bin/env node
'use strict';

const observe = require('../lib/daytrade-intraday-observe');

function parseArgs(argv) {
  const args = { limit: observe.DEFAULT_LIMIT, outputDir: observe.DEFAULT_OUTPUT_DIR, cacheDir: observe.DEFAULT_CACHE_DIR, ttlMinutes: observe.DEFAULT_TTL_MINUTES, writeJson: false, noFetch: false, fullUniverse: true };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.writeJson = true;
    else if (a === '--no-fetch') args.noFetch = true;
    else if (a === '--candidate-only') args.fullUniverse = false;
    else if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      args[key] = val;
    }
  }
  args.limit = Number(args.limit);
  args.ttlMinutes = Number(args.ttlMinutes);
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const report = await observe.runObserve(args);
  const paths = await observe.writeReports(report, args);
  console.log(observe.markdownReport(report));
  console.log('Reports written:');
  console.log('- markdown: ' + paths.markdown);
  if (paths.json) console.log('- json: ' + paths.json);
}

if (require.main === module) main().catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; });
module.exports = { parseArgs };
