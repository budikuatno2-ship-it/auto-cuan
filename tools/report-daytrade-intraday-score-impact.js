#!/usr/bin/env node
'use strict';

const impact = require('../lib/daytrade-intraday-score-impact');

function parseArgs(argv) {
  const args = { outputDir: impact.DEFAULT_OUTPUT_DIR, limit: impact.DEFAULT_LIMIT, productionSource: 'supabase', writeJson: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.writeJson = true;
    else if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      args[key] = val;
    }
  }
  args.limit = Number(args.limit || impact.DEFAULT_LIMIT);
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const report = await impact.runSimulation(args);
  const paths = await impact.writeReports(report, args);
  console.log(impact.markdownReport(report));
  console.log('Reports written:');
  console.log('- markdown: ' + paths.markdown);
  if (paths.json) console.log('- json: ' + paths.json);
}

if (require.main === module) main().catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; });
module.exports = { parseArgs };
