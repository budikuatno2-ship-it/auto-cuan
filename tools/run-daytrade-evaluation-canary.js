#!/usr/bin/env node
'use strict';

// Manual, VPS-local evaluation canary. This file is intentionally not wired to
// cron, the production runner, an API action, Supabase, Telegram, or retention.
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const engine = require('../lib/daytrade-screener-engine');
const ohlcv = require('../lib/daytrade-ohlcv-cache');
const adapter = require('../lib/daytrade-evaluation-adapter');
const { normalizeEvaluationRecord } = require('../lib/screener-evaluation-contract');
const { createLocalEvaluationLogger } = require('../lib/screener-evaluation-logger');
const { marketDate } = require('../lib/screener-evaluation-retention');

const MAX_TICKERS = 5;
const ALLOWED_BOARDS = new Set(['UTAMA', 'PENGEMBANGAN']);
const SAMPLE_SLOTS = new Set(['OPENING', 'MID_SESSION', 'CLOSING']);
const REPOSITORY_ROOT = path.resolve(__dirname, '..');

class CanaryError extends Error {
  constructor(code, detail) { super(code + (detail ? ' ' + detail : '')); this.code = code; }
}

function parseArgs(argv) {
  const options = { execute: false, marketDayConfirmed: false, sampleSlot: null, tickers: null, evaluationRoot: null };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--execute') options.execute = true;
    else if (arg === '--market-day-confirmed') options.marketDayConfirmed = true;
    else if (arg === '--tickers' || arg === '--evaluation-root' || arg === '--sample-slot') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new TypeError(arg + ' requires a value');
      const value = argv[++i];
      if (arg === '--tickers') options.tickers = value.split(',').map(value => {
        const parts = value.trim().toUpperCase().split(':');
        return parts.length === 2 ? { ticker: parts[0], board: parts[1] } : { ticker: parts[0], board: null };
      });
      else if (arg === '--evaluation-root') options.evaluationRoot = value;
      else options.sampleSlot = value;
    } else throw new TypeError('unknown option: ' + arg);
  }
  return options;
}

function validateOptions(options) {
  if (!options.execute) throw new Error('refusing to run without explicit --execute acknowledgement');
  if (!options.marketDayConfirmed) throw new Error('refusing to run without explicit --market-day-confirmed acknowledgement');
  if (!SAMPLE_SLOTS.has(options.sampleSlot)) throw new TypeError('--sample-slot must be OPENING, MID_SESSION, or CLOSING');
  if (typeof options.evaluationRoot !== 'string' || !path.isAbsolute(options.evaluationRoot)) throw new TypeError('--evaluation-root must be a caller-supplied absolute path');
  if (!Array.isArray(options.tickers) || options.tickers.length < 1) throw new TypeError('--tickers requires 1 to 5 comma-separated tickers');
  if (options.tickers.length > MAX_TICKERS) throw new RangeError('maximum 5 tickers');
  if (new Set(options.tickers.map(item => item.ticker)).size !== options.tickers.length) throw new TypeError('tickers must be unique');
  if (options.tickers.some(item => !item || !/^[A-Z0-9.-]{1,20}$/.test(item.ticker || '') || !ALLOWED_BOARDS.has(item.board))) throw new TypeError('each ticker requires an allowed board (UTAMA or PENGEMBANGAN)');
  assertSafeEvaluationRoot(options.evaluationRoot);
  return options;
}

function jakartaWeekday(now) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jakarta', weekday: 'short' }).format(now);
}

function failEvidence() { throw new CanaryError('EXISTING_EVIDENCE_UNVERIFIABLE'); }
function regularDirectory(directory) {
  return fs.existsSync(directory) && !fs.lstatSync(directory).isSymbolicLink() && fs.statSync(directory).isDirectory();
}
function protocolFiles(root, name) {
  const protocolRoot = path.join(root, name);
  if (!fs.existsSync(protocolRoot)) return [];
  if (!regularDirectory(protocolRoot)) failEvidence();
  const files = []; const stack = [protocolRoot];
  while (stack.length) {
    const directory = stack.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) failEvidence();
      if (entry.isDirectory()) stack.push(target);
      else if (entry.isFile()) files.push(target);
      else failEvidence();
    }
  }
  return files;
}
function inspectFinalizedEvidence(root, date, slot) {
  if (!fs.existsSync(root)) return { duplicate: false, finalizedSamples: 0 };
  try {
    if (!regularDirectory(root)) failEvidence();
    const rawRoot = path.join(root, 'raw');
    const rawFiles = protocolFiles(root, 'raw');
    const manifestFiles = protocolFiles(root, 'manifests');
    const quarantineFiles = protocolFiles(root, 'quarantine');
    if (quarantineFiles.length || rawFiles.some(file => file.endsWith('.open.jsonl.gz'))) failEvidence();
    if (rawFiles.some(file => !file.endsWith('.jsonl.gz')) || manifestFiles.some(file => !file.endsWith('.manifest.json'))) failEvidence();
    const finalizedRaw = new Set(rawFiles.map(file => path.resolve(file)));
    const claimedRaw = new Set(); let duplicate = false; let finalizedSamples = 0;
    for (const manifestFile of manifestFiles) {
        const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        const keys = ['schema_version', 'strategy', 'run_id', 'relative_path', 'byte_size', 'record_count', 'first_timestamp', 'last_timestamp', 'sha256', 'finalized_at'];
        if (!manifest || Object.keys(manifest).sort().join() !== keys.sort().join() || manifest.schema_version !== 1 || manifest.strategy !== 'DAY_TRADE' ||
          typeof manifest.run_id !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(manifest.run_id) ||
          typeof manifest.relative_path !== 'string' || path.isAbsolute(manifest.relative_path) ||
          manifest.relative_path.split(/[\\/]/).includes('..') || !Number.isInteger(manifest.record_count) || manifest.record_count < 1 ||
          !Number.isInteger(manifest.byte_size) || manifest.byte_size < 1 || !/^[a-f0-9]{64}$/.test(manifest.sha256 || '') ||
          typeof manifest.first_timestamp !== 'string' || typeof manifest.last_timestamp !== 'string' || !Number.isFinite(Date.parse(manifest.finalized_at))) failEvidence();
        const rawFile = path.resolve(root, manifest.relative_path);
        const match = manifest.relative_path.replaceAll('\\', '/').match(/^raw\/(\d{4}-\d{2}-\d{2})\/day-trade\/([^/]+\.jsonl\.gz)$/);
        if (!match || rawFile === path.resolve(rawRoot) || !rawFile.startsWith(path.resolve(rawRoot) + path.sep) ||
          path.resolve(manifestFile) !== path.resolve(root, 'manifests', match[1], path.basename(rawFile) + '.manifest.json') ||
          !finalizedRaw.has(rawFile) || claimedRaw.has(rawFile) ||
          !fs.realpathSync.native(rawFile).startsWith(fs.realpathSync.native(rawRoot) + path.sep)) failEvidence();
        claimedRaw.add(rawFile);
        const content = fs.readFileSync(rawFile);
        if (content.length !== manifest.byte_size || crypto.createHash('sha256')['update'](content).digest('hex') !== manifest.sha256) failEvidence();
        const lines = zlib.gunzipSync(content).toString('utf8').trim().split('\n');
        if (lines.length !== manifest.record_count) failEvidence();
        const records = lines.map(line => normalizeEvaluationRecord(JSON.parse(line)));
        if (records.some(record => marketDate(new Date(record.observed_at)) !== match[1])) failEvidence();
        const identityKeys = ['run_id', 'code_sha', 'config_hash', 'run_mode', 'scheduler_source', 'scheduled_slot', 'observed_at'];
        if (records.some(record => record.run_id !== manifest.run_id) || identityKeys.some(key => new Set(records.map(record => record[key])).size !== 1) ||
          new Set(records.map(record => record.ticker)).size !== records.length || manifest.first_timestamp !== records[0].observed_at ||
          manifest.last_timestamp !== records[records.length - 1].observed_at) failEvidence();
        const slots = new Set(records.map(record => record.scheduled_slot));
        if (slots.size !== 1) failEvidence();
        if (records[0].scheduled_slot === null && records.every(record => record.scheduler_source === 'manual_vps_local_canary')) continue;
        if (!SAMPLE_SLOTS.has(records[0].scheduled_slot) || records.some(record => record.scheduler_source !== 'manual_market_day_sample')) failEvidence();
        finalizedSamples++;
        if (match[1] === date && records[0].scheduled_slot === slot) duplicate = true;
    }
    if (claimedRaw.size !== finalizedRaw.size) failEvidence();
    return { duplicate, finalizedSamples };
  } catch (error) {
    if (error instanceof CanaryError) throw error;
    failEvidence();
  }
}

function resolvedPath(target) {
  let existing = target; const suffix = [];
  while (!fs.existsSync(existing)) { suffix.unshift(path.basename(existing)); const parent = path.dirname(existing); if (parent === existing) break; existing = parent; }
  return path.join(fs.realpathSync.native(existing), ...suffix);
}

function isWithin(parent, target) { return target === parent || target.startsWith(parent + path.sep); }
function assertSafeEvaluationRoot(root) {
  const absolute = path.resolve(root);
  if (absolute === path.parse(absolute).root) throw new CanaryError('UNSAFE_EVALUATION_ROOT');
  const realRepository = fs.realpathSync.native(REPOSITORY_ROOT);
  if (isWithin(realRepository, resolvedPath(absolute))) throw new CanaryError('UNSAFE_EVALUATION_ROOT');
  return absolute;
}

function verifyCleanCheckout() {
  const commands = [['diff', '--quiet'], ['diff', '--cached', '--quiet']];
  for (const args of commands) {
    const result = childProcess.spawnSync('git', args, { cwd: REPOSITORY_ROOT, stdio: 'ignore' });
    if (result.status !== 0) throw new CanaryError('TRACKED_CHECKOUT_DIRTY');
  }
}
function failureMessage(error) { return 'CANARY_FAILED ' + (error instanceof CanaryError ? error.message : 'INTERNAL_ERROR'); }

function resolveCodeSha() {
  return childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

async function runCanary(options, dependencies = {}) {
  validateOptions(options);
  (dependencies.verifyCleanCheckout || verifyCleanCheckout)();
  const now = dependencies.now ? new Date(dependencies.now) : new Date();
  if (!Number.isFinite(now.getTime())) throw new TypeError('now is invalid');
  if (['Sat', 'Sun'].includes(jakartaWeekday(now))) throw new CanaryError('JAKARTA_WEEKEND');
  const currentMarketDate = marketDate(now);
  const evidence = (dependencies.inspectFinalizedEvidence || inspectFinalizedEvidence)(options.evaluationRoot, currentMarketDate, options.sampleSlot);
  if (evidence.duplicate) throw new CanaryError('DUPLICATE_MARKET_DATE_SLOT');
  const codeSha = (dependencies.resolveCodeSha || resolveCodeSha)();
  const runMode = (dependencies.engine || engine).getRunMode(null, now);
  const runId = 'dt-canary-' + now.toISOString().replace(/[^0-9]/g, '').slice(0, 14) + '-' + crypto.randomBytes(4).toString('hex');
  const tickers = options.tickers.map(item => ({ ticker: item.ticker, board: item.board, universe_source: 'manual_canary' }));
  const fetchCandles = dependencies.fetchCandles || ohlcv.fetchYahooCandles;
  const calculation = await (dependencies.engine || engine).runDayTradeBatch(tickers, runMode, {
    fetchCandles,
    noDelay: true,
    captureEvaluationInitial: true
  });
  const resultCount = Array.isArray(calculation.results) ? calculation.results.length : 0;
  const failedCount = Array.isArray(calculation.failed) ? calculation.failed.length : tickers.length;
  if (failedCount !== 0 || resultCount !== tickers.length) {
    throw new CanaryError('CALCULATION_INCOMPLETE', 'requested=' + tickers.length + ' results=' + resultCount + ' failed=' + failedCount);
  }
  const observedDate = dependencies.afterCalculationNow ? new Date(dependencies.afterCalculationNow()) : new Date();
  if (!Number.isFinite(observedDate.getTime())) throw new CanaryError('OBSERVED_TIME_INVALID');
  if (marketDate(observedDate) !== currentMarketDate) throw new CanaryError('MARKET_DATE_CHANGED_DURING_RUN');
  const observedAt = observedDate.toISOString();
  const context = {
    runId,
    runMode,
    batchIndex: 0,
    scheduledSlot: options.sampleSlot,
    schedulerSource: 'manual_market_day_sample',
    codeSha,
    observedAt,
    configuration: (dependencies.engine || engine).getDayTradeEvaluationConfiguration(runMode, { fastMode: false, intradayScoreEnabled: false })
  };

  // Map and validate every record before the logger can create an output file.
  const records = calculation.results.map(candidate => adapter.adaptDayTradeCandidate(candidate, context));
  const logger = (dependencies.createLogger || createLocalEvaluationLogger)({
    root: options.evaluationRoot,
    env: { EVALUATION_LOGGING_ENABLED: 'true' },
    runId,
    marketDate: currentMarketDate,
    diskAudit: dependencies.diskAudit
  });
  try {
    records.forEach(record => logger.append(record));
    const manifest = logger.finalize();
    return {
      record_count: manifest.record_count,
      compressed_bytes: manifest.byte_size,
      checksum: manifest.sha256,
      market_date: currentMarketDate,
      sample_slot: options.sampleSlot,
      omitted_field_provenance: {
        decision_final: 'out_of_scope_later_downgrades_not_captured',
        feature_as_of_ts: 'unavailable_at_initial_classification',
        rvol_seasonal: 'unavailable_no_validated_seasonal_curve'
      }
    };
  } catch (error) {
    try { logger.abort('WRITE_OR_VALIDATION_FAILED'); } catch (_) { /* preserve original failure */ }
    throw error;
  }
}

if (require.main === module) {
  runCanary(parseArgs(process.argv)).then(summary => console.log(JSON.stringify(summary))).catch(error => {
    console.error(failureMessage(error));
    process.exitCode = 1;
  });
}

module.exports = { MAX_TICKERS, ALLOWED_BOARDS, SAMPLE_SLOTS, REPOSITORY_ROOT, CanaryError, parseArgs, validateOptions, assertSafeEvaluationRoot, jakartaWeekday, inspectFinalizedEvidence, verifyCleanCheckout, failureMessage, resolveCodeSha, runCanary };
