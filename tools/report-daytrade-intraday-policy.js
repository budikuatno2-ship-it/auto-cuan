#!/usr/bin/env node
'use strict';

const lib = require('../lib/daytrade-intraday-policy');

function parseArgs(argv) {
  const args = {
    reportsDir: lib.DEFAULT_REPORTS_DIR,
    bundleFile: null,
    aggregateFile: null,
    writeJson: false
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') {
      args.writeJson = true;
    } else if (a === '--reports-dir' && argv[i + 1]) {
      args.reportsDir = argv[++i];
    } else if (a === '--bundle-file' && argv[i + 1]) {
      args.bundleFile = argv[++i];
    } else if (a === '--aggregate-file' && argv[i + 1]) {
      args.aggregateFile = argv[++i];
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  console.log('Loading validation data...');
  console.log('Reports directory:', args.reportsDir);
  if (args.bundleFile) console.log('Bundle file:', args.bundleFile);
  if (args.aggregateFile) console.log('Aggregate file:', args.aggregateFile);
  console.log('');

  const { report, paths } = await lib.run(args);

  console.log(lib.markdownReport(report));
  console.log('');
  console.log('Policy report written:');
  console.log('- markdown:', paths.markdown);
  if (paths.json) console.log('- json:', paths.json);
}

if (require.main === module) main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });

module.exports = { parseArgs };