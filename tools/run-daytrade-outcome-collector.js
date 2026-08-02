#!/usr/bin/env node
'use strict';

// Manual-only B0.5 collector. Intentionally not imported by any scheduler,
// production route, notification path, database integration, or runtime runner.
const collector = require('../lib/daytrade-outcome-collector');

if (require.main === module) {
  collector.runCollector(collector.parseArgs(process.argv))
    .then(summary => process.stdout.write(JSON.stringify(summary) + '\n'))
    .catch(error => {
      process.stderr.write(JSON.stringify(collector.failureOutput(error)) + '\n');
      process.exitCode = 1;
    });
}
