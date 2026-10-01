#!/usr/bin/env node
'use strict';

const lib = require('../lib/daytrade-intraday-staged-enable-runbook');

function parseArgs(argv) {
  const args = {
    reportsDir: lib.DEFAULT_REPORTS_DIR,
    gateFile: null,
    policyFile: null,
    aggregateFile: null,
    bundleFile: null,
    writeJson: false
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') {
      args.writeJson = true;
    } else if (a === '--reports-dir' && argv[i + 1]) {
      args.reportsDir = argv[++i];
    } else if (a === '--gate-file' && argv[i + 1]) {
      args.gateFile = argv[++i];
    } else if (a === '--policy-file' && argv[i + 1]) {
      args.policyFile = argv[++i];
    } else if (a === '--aggregate-file' && argv[i + 1]) {
      args.aggregateFile = argv[++i];
    } else if (a === '--bundle-file' && argv[i + 1]) {
      args.bundleFile = argv[++i];
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  console.log('Loading data for staged-enable runbook...');
  console.log('Reports directory:', args.reportsDir);
  if (args.gateFile) console.log('Gate file:', args.gateFile);
  if (args.policyFile) console.log('Policy file:', args.policyFile);
  if (args.aggregateFile) console.log('Aggregate file:', args.aggregateFile);
  if (args.bundleFile) console.log('Bundle file:', args.bundleFile);
  console.log('');

  const { report, paths } = await lib.run(args);

  console.log(lib.markdownReport(report));
  console.log('');
  console.log('Staged-enable runbook report written:');
  console.log('- markdown:', paths.markdown);
  if (paths.json) console.log('- json:', paths.json);
}

if (require.main === module) main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });

module.exports = { parseArgs };