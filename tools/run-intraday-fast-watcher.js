#!/usr/bin/env node
'use strict';
const path = require('node:path');
const watcher = require('../lib/intraday-fast-watcher');
const live = require('../lib/intraday-fast-watcher-live');
function parseArgs(argv) {
const args = {
sampleDate: null,
shortlistFile: null,
observationsFile: null,
scheduledTime: null,
throughTime: null,
stateDir: null,
eventDir: null,
observationRoot: null,
cacheDir: null,
productionLockFile: null,
maxShortlist: watcher.DEFAULT_MAX_SHORTLIST,
concurrency: live.DEFAULT_CONCURRENCY,
timeoutMs: live.DEFAULT_TIMEOUT_MS,
live: false,
dryRun: false,
json: false,
help: false,
mode: 'shadow'
};
for (let index = 2; index < argv.length; index += 1) {
const value = argv[index];
if (value === '--sample-date') args.sampleDate = argv[++index];
else if (value === '--shortlist-file') args.shortlistFile = argv[++index];
else if (value === '--observations-file') args.observationsFile = argv[++index];
else if (value === '--scheduled-time') args.scheduledTime = argv[++index];
else if (value === '--through-time') args.throughTime = argv[++index];
else if (value === '--state-dir') args.stateDir = argv[++index];
else if (value === '--event-dir') args.eventDir = argv[++index];
else if (value === '--observation-root') args.observationRoot = argv[++index];
else if (value === '--cache-dir') args.cacheDir = argv[++index];
else if (value === '--production-lock-file') args.productionLockFile = argv[++index];
else if (value === '--max-shortlist') args.maxShortlist = Number(argv[++index]);
else if (value === '--concurrency') args.concurrency = Number(argv[++index]);
else if (value === '--timeout-ms') args.timeoutMs = Number(argv[++index]);
else if (value === '--live') args.live = true;
else if (value === '--dry-run') args.dryRun = true;
else if (value === '--shadow') args.mode = 'shadow';
else if (value === '--json') args.json = true;
else if (value === '--help' || value === '-h') args.help = true;
else args.invalid = value;
}
return args;
}
const USAGE = `Usage (live shortlist recheck):
node tools/run-intraday-fast-watcher.js \\
--live --sample-date YYYY-MM-DD --scheduled-time HH:MM \\
--shortlist-file PATH [--max-shortlist 20] [--concurrency 4] \\
[--cache-dir PATH] [--production-lock-file PATH] \\
[--state-dir PATH] [--event-dir PATH] [--observation-root PATH] \\
[--dry-run] [--shadow] [--json]
Usage (replay existing observations):
node tools/run-intraday-fast-watcher.js \\
--sample-date YYYY-MM-DD --shortlist-file PATH --observations-file PATH \\
[--through-time HH:MM] [--max-shortlist 20] \\
[--state-dir PATH] [--event-dir PATH] [--dry-run] [--shadow] [--json]
Shadow-only safety:
- no --send mode exists;
- no Telegram call exists;
- live mode re-runs the existing Day Trade engine only for the bounded shortlist;
- it never builds/scans the full universe and never publishes production results.`;
async function main(argv) {
const args = parseArgs(argv || process.argv);
if (args.help) {
process.stdout.write(USAGE + '\n');
return 0;
}
const invalidMax = !Number.isInteger(args.maxShortlist) || args.maxShortlist < 1 || args.maxShortlist > watcher.MAX_SHORTLIST_LIMIT;
const invalidConcurrency = !Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > live.MAX_CONCURRENCY;
const invalidTimeout = !Number.isInteger(args.timeoutMs) || args.timeoutMs < 1000 || args.timeoutMs > 30000;
const missingModeInput = args.live ? !args.scheduledTime : !args.observationsFile;
if (args.invalid || !args.sampleDate || !args.shortlistFile || missingModeInput || invalidMax || invalidConcurrency || invalidTimeout) {
process.stderr.write(USAGE + '\n');
return 2;
}
const common = {
sampleDate: args.sampleDate,
shortlistFile: path.resolve(args.shortlistFile),
stateDir: args.stateDir ? path.resolve(args.stateDir) : null,
eventDir: args.eventDir ? path.resolve(args.eventDir) : null,
maxShortlist: args.maxShortlist,
dryRun: args.dryRun,
mode: args.mode
};
const result = args.live
? await live.runLiveFastWatcher(Object.assign({}, common, {
scheduledTime: args.scheduledTime,
observationRoot: args.observationRoot ? path.resolve(args.observationRoot) : null,
cacheDir: args.cacheDir ? path.resolve(args.cacheDir) : null,
productionLockFile: args.productionLockFile ? path.resolve(args.productionLockFile) : null,
concurrency: args.concurrency,
timeoutMs: args.timeoutMs
}))
: await watcher.runFastWatcher(Object.assign({}, common, {
observationsFile: path.resolve(args.observationsFile),
throughTime: args.throughTime
}));
if (args.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
else process.stdout.write(`Fast watcher: ${result.status}; shortlist=${result.shortlist_count || 0}; events=${result.event_count || 0}; confirmed=${(result.confirmed || []).length}; Telegram=not-called\n`);
return new Set([
'invalid_input', 'blocked_non_shadow_mode', 'shortlist_missing', 'shortlist_invalid',
'observations_missing', 'observations_invalid', 'lock_busy', 'skipped_due_to_production_lock'
]).has(result.status) ? 1 : 0;
}
if (require.main === module) {
main(process.argv)
.then(code => { process.exitCode = code; })
.catch(error => {
process.stderr.write(`FATAL: ${error.message}\n`);
process.exitCode = 1;
});
}
module.exports = { parseArgs, main, USAGE };
