#!/usr/bin/env node
'use strict';

const audit = require('../lib/daytrade-cache-audit');

function parseArgs(argv) {
  const args = { cacheDir: audit.DEFAULT_CACHE_DIR, logsFile: audit.DEFAULT_LOGS_FILE, ttlMinutes: audit.DEFAULT_TTL_MINUTES, writeJson: false, limitSamples: 10 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.writeJson = true;
    else if (a.indexOf('--') === 0) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const val = argv[i + 1] && argv[i + 1].indexOf('--') !== 0 ? argv[++i] : 'true';
      args[key] = val;
    }
  }
  args.ttlMinutes = Number(args.ttlMinutes);
  args.limitSamples = Number(args.limitSamples);
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const date = new Date().toISOString().slice(0, 10);
  const cache = await audit.auditCache(args);
  const logs = await audit.summarizeLogs(args);
  cache.stale_fallback_indications = logs.totals.stale_fallback;
  const report = { date, generated_at: new Date().toISOString(), ttl_minutes: args.ttlMinutes, cache, logs };
  const paths = await audit.writeReports(report, { writeJson: args.writeJson });

  console.log(audit.markdownReport(report));
  console.log('Reports written:');
  console.log('- markdown: ' + paths.markdown);
  if (paths.json) console.log('- json: ' + paths.json);
}

if (require.main === module) {
  main().catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; });
}

module.exports = { parseArgs };
