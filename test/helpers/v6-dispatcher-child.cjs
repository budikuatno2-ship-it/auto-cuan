'use strict';
// Invoked only by the isolated dispatcher test; no repository runtime paths.
const fs = require('node:fs');
const path = require('node:path');
const { createDispatcher } = require('../../lib/v6-scheduler-dispatcher.cjs');
const { createAdapters } = require('../../lib/v6-scheduler-adapters.cjs');
const config = JSON.parse(fs.readFileSync(process.argv[2]));
const real = createAdapters(config.adapterOptions);
const registry = { ...real, run: async (job, ctx) => {
  fs.appendFileSync(path.join(config.adapterOptions.outputDir, '..', 'invocations.jsonl'), JSON.stringify({ job, pid: process.pid }) + '\n');
  if (config.delay) await new Promise((resolve) => setTimeout(resolve, config.delay));
  return real.run(job, ctx);
} };
createDispatcher({ ...config, adapters: registry, now: () => new Date(config.instant) }).cycle().then((result) => process.stdout.write(JSON.stringify(result))).catch((err) => { process.stderr.write(err.message); process.exitCode = 1; });
