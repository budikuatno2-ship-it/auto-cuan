#!/usr/bin/env node
'use strict';

const lib = require('../lib/daytrade-intraday-provider-cache-quality');

function parseArgs(argv) {
  const args = { reportsDir: lib.DEFAULT_REPORTS_DIR, days: 5, samples: undefined, writeJson: false, includeSessionArchives: true };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.writeJson = true;
    else if (a === '--no-session-archives') args.includeSessionArchives = false;
    else if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      args[key] = key === 'days' || key === 'samples' ? Number(val) : val;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const samples = await lib.loadSamples(args);
  const report = lib.buildProviderCacheQualityReport(samples, args);
  const paths = await lib.writeReports(report, args);
  console.log(lib.markdownReport(report));
  console.log('Provider/cache quality report written:');
  console.log('- markdown: ' + paths.markdown);
  if (paths.json) console.log('- json: ' + paths.json);
}

if (require.main === module) main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
module.exports = { parseArgs };
