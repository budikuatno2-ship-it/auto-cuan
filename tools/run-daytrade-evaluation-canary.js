#!/usr/bin/env node
'use strict';

// Manual, VPS-local evaluation canary. This file is intentionally not wired to
// cron, the production runner, an API action, Supabase, Telegram, or retention.
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const engine = require('../lib/daytrade-screener-engine');
const ohlcv = require('../lib/daytrade-ohlcv-cache');
const adapter = require('../lib/daytrade-evaluation-adapter');
const { createLocalEvaluationLogger } = require('../lib/screener-evaluation-logger');
const { marketDate } = require('../lib/screener-evaluation-retention');

const MAX_TICKERS = 5;
const ALLOWED_BOARDS = new Set(['UTAMA', 'PENGEMBANGAN']);
const REPOSITORY_ROOT = path.resolve(__dirname, '..');

class CanaryError extends Error {
  constructor(code, detail) { super(code + (detail ? ' ' + detail : '')); this.code = code; }
}

function parseArgs(argv) {
  const options = { execute: false, tickers: null, evaluationRoot: null };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--execute') options.execute = true;
    else if (arg === '--tickers' || arg === '--evaluation-root') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new TypeError(arg + ' requires a value');
      const value = argv[++i];
      if (arg === '--tickers') options.tickers = value.split(',').map(value => {
        const parts = value.trim().toUpperCase().split(':');
        return parts.length === 2 ? { ticker: parts[0], board: parts[1] } : { ticker: parts[0], board: null };
      }).filter(item => item.ticker);
      else options.evaluationRoot = value;
    } else throw new TypeError('unknown option: ' + arg);
  }
  return options;
}

function validateOptions(options) {
  if (!options.execute) throw new Error('refusing to run without explicit --execute acknowledgement');
  if (typeof options.evaluationRoot !== 'string' || !path.isAbsolute(options.evaluationRoot)) throw new TypeError('--evaluation-root must be a caller-supplied absolute path');
  if (!Array.isArray(options.tickers) || options.tickers.length < 1) throw new TypeError('--tickers requires 1 to 5 comma-separated tickers');
  if (options.tickers.length > MAX_TICKERS) throw new RangeError('maximum 5 tickers');
  if (new Set(options.tickers.map(item => item.ticker)).size !== options.tickers.length) throw new TypeError('tickers must be unique');
  if (options.tickers.some(item => !item || !/^[A-Z0-9_-]{1,20}$/.test(item.ticker || '') || !ALLOWED_BOARDS.has(item.board))) throw new TypeError('each ticker requires an allowed board (UTAMA or PENGEMBANGAN)');
  assertSafeEvaluationRoot(options.evaluationRoot);
  return options;
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
  const observedAt = (dependencies.afterCalculationNow ? new Date(dependencies.afterCalculationNow()) : new Date()).toISOString();
  const context = {
    runId,
    runMode,
    batchIndex: 0,
    scheduledSlot: null,
    schedulerSource: 'manual_vps_local_canary',
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
    marketDate: marketDate(now),
    diskAudit: dependencies.diskAudit
  });
  try {
    records.forEach(record => logger.append(record));
    const manifest = logger.finalize();
    return {
      record_count: manifest.record_count,
      compressed_bytes: manifest.byte_size,
      checksum: manifest.sha256,
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

module.exports = { MAX_TICKERS, ALLOWED_BOARDS, REPOSITORY_ROOT, CanaryError, parseArgs, validateOptions, assertSafeEvaluationRoot, verifyCleanCheckout, failureMessage, resolveCodeSha, runCanary };
