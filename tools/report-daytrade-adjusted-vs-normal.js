#!/usr/bin/env node
'use strict';

const reportLib = require('../lib/daytrade-adjusted-vs-normal-report');

function parseArgs(argv) {
  const args = { logsFile: reportLib.DEFAULT_LOGS_FILE, outputDir: reportLib.DEFAULT_OUTPUT_DIR, writeJson: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.writeJson = true;
    else if (a === '--latest-normal' || a === '--latest-adjusted') args[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = true;
    else if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      args[key] = val;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const inputs = await reportLib.loadInputs(args);
  const report = reportLib.buildReport(inputs.normal, inputs.adjusted, inputs.sources, args);
  const paths = await reportLib.writeReports(report, args);
  console.log(reportLib.markdownReport(report));
  console.log('Reports written:');
  console.log('- markdown: ' + paths.markdown);
  if (paths.json) console.log('- json: ' + paths.json);
}

if (require.main === module) main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
module.exports = { parseArgs };
