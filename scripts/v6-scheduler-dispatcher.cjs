'use strict';

const fs = require('node:fs');
const { createDispatcher } = require('../lib/v6-scheduler-dispatcher.cjs');
function createV6Dispatcher(options) { return createDispatcher(options); }
if (require.main === module) {
  // No default runtime paths or loop: this is a dormant, single-cycle entry.
  // A deployment/cutover and verified source ingestion remain separate work.
  const configPath = process.argv[2];
  if (!configPath) { process.stderr.write('Explicit local configuration required; no dispatcher activated.\n'); process.exitCode = 2; }
  else {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.localOnly !== true || config.adapterOptions?.realm !== 'OFFLINE') throw new Error('Only explicit OFFLINE local execution is supported by this entry');
      if (config.now) { const instant = new Date(config.now); config.now = () => instant; }
      createDispatcher(config).cycle().then((result) => process.stdout.write(JSON.stringify(result, null, 2) + '\n')).catch(() => { process.stderr.write('Dispatcher failed closed.\n'); process.exitCode = 1; });
    } catch (_) { process.stderr.write('Invalid local dispatcher configuration.\n'); process.exitCode = 1; }
  }
}
module.exports = { createV6Dispatcher };
