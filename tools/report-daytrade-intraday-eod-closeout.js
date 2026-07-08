#!/usr/bin/env node
'use strict';

const lib = require('../lib/daytrade-intraday-eod-closeout');

async function main() {
  const opts = lib.parseArgs(process.argv);
  const { report, paths } = await lib.run(opts);
  console.log(lib.markdownReport(report));
  console.error(`Wrote ${paths.markdown}`);
  console.error(`Wrote ${paths.json}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack || err);
    process.exitCode = 1;
  });
}

module.exports = lib;
