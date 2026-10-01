'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { canonicalJson, normalizeEvaluationRecord } = require('./screener-evaluation-contract');
const { marketDate } = require('./screener-evaluation-retention');
const {
  normalizePolicy,
  normalizeOutcomeRecord,
  policyHash,
  initialRecordDigest,
  finalizationKey
} = require('./daytrade-outcome-contract');
const {
  VERSION: OUTCOME_EVALUATOR_VERSION,
  evaluateDayTradeOutcome
} = require('./daytrade-outcome-evaluator');
const {
  preflightOutcomeTree,
  createOutcomeLogger
} = require('./daytrade-outcome-logger');

const MAX_TICKERS = 5;
const MAX_POLICY_BYTES = 64 * 1024;
const MAX_PROVIDER_BARS = 5000;
const SAMPLE_SLOTS = new Set(['OPENING', 'MID_SESSION', 'CLOSING']);
const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const COVERAGE_VERSION = 'manual-outcome-collector-continuous-bars-v1';
const YAHOO_INTERVALS = new Map([
  [60_000, '1m'],
  [120_000, '2m'],
  [300_000, '5m'],
  [900_000, '15m'],
  [1_800_000, '30m'],
  [3_600_000, '60m']
]);
const OBSERVATION_KEYS = ['ticker', 'start_at', 'end_at', 'open', 'high', 'low', 'close', 'provenance', 'source_as_of'];

class CollectorError extends Error {
  constructor(code, summary) {
    super(code);
    this.code = code;
    if (summary) this.summary = summary;
  }
}

function exactObject(value, keys, name) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join('\0') !== keys.slice().sort().join('\0')) {
    throw new TypeError(name + ' must contain exact keys');
  }
}

function normalizeTicker(value) {
  const ticker = String(value || '').trim().toUpperCase().replace(/\.JK$/, '');
  if (!/^[A-Z0-9.-]{1,20}$/.test(ticker)) throw new TypeError('ticker is invalid');
  return ticker;
}

function parseArgs(argv) {
  const options = {
    execute: false,
    marketDayConfirmed: false,
    continuousSegmentConfirmed: false,
    evaluationRoot: null,
    marketDate: null,
    scheduledSlot: null,
    tickers: [],
    horizonEnd: null,
    intervalMs: null,
    policyFile: null
  };
  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--execute') options.execute = true;
    else if (arg === '--market-day-confirmed') options.marketDayConfirmed = true;
    else if (arg === '--continuous-segment-confirmed') options.continuousSegmentConfirmed = true;
    else if (['--evaluation-root', '--market-date', '--scheduled-slot', '--ticker', '--horizon-end', '--interval-ms', '--policy-file'].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new TypeError(arg + ' requires a value');
      if (arg === '--evaluation-root') options.evaluationRoot = value;
      else if (arg === '--market-date') options.marketDate = value;
      else if (arg === '--scheduled-slot') options.scheduledSlot = value;
      else if (arg === '--ticker') options.tickers.push(value);
      else if (arg === '--horizon-end') options.horizonEnd = value;
      else if (arg === '--interval-ms') options.intervalMs = Number(value);
      else options.policyFile = value;
    } else {
      throw new TypeError('unknown option: ' + arg);
    }
  }
  return options;
}

function isWithin(parent, target) {
  return target === parent || target.startsWith(parent + path.sep);
}

function assertNoSymlinkComponents(absolute) {
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new CollectorError('UNSAFE_SYMLINK_PATH');
    }
  }
}

function assertExternalPath(target, kind) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) {
    throw new CollectorError(kind === 'directory' ? 'UNSAFE_EVALUATION_ROOT' : 'UNSAFE_POLICY_FILE');
  }
  const absolute = path.resolve(target);
  if (absolute === path.parse(absolute).root) throw new CollectorError('UNSAFE_EVALUATION_ROOT');
  assertNoSymlinkComponents(absolute);
  if (!fs.existsSync(absolute)) throw new CollectorError(kind === 'directory' ? 'EVALUATION_ROOT_MISSING' : 'POLICY_FILE_MISSING');
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) {
    throw new CollectorError(kind === 'directory' ? 'UNSAFE_EVALUATION_ROOT' : 'UNSAFE_POLICY_FILE');
  }
  const repository = fs.realpathSync.native(REPOSITORY_ROOT);
  const real = fs.realpathSync.native(absolute);
  if (isWithin(repository, real)) throw new CollectorError(kind === 'directory' ? 'UNSAFE_EVALUATION_ROOT' : 'UNSAFE_POLICY_FILE');
  return real;
}

function strictUtc(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(name + ' must be a valid UTC timestamp');
  }
  return Date.parse(value);
}

function jakartaWeekday(date) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jakarta', weekday: 'short' }).format(date);
}

function validateOptions(input) {
  const options = { ...input, tickers: Array.isArray(input.tickers) ? input.tickers.map(normalizeTicker) : [] };
  if (!options.execute) throw new CollectorError('EXECUTE_ACK_REQUIRED');
  if (!options.marketDayConfirmed) throw new CollectorError('MARKET_DAY_ACK_REQUIRED');
  if (!options.continuousSegmentConfirmed) throw new CollectorError('CONTINUOUS_SEGMENT_ACK_REQUIRED');
  options.evaluationRoot = assertExternalPath(options.evaluationRoot, 'directory');
  options.policyFile = assertExternalPath(options.policyFile, 'file');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.marketDate || '')) throw new TypeError('market date is invalid');
  if (!SAMPLE_SLOTS.has(options.scheduledSlot)) throw new TypeError('scheduled slot is invalid');
  if (options.tickers.length < 1 || options.tickers.length > MAX_TICKERS) throw new RangeError('ticker count must be between 1 and 5');
  if (new Set(options.tickers).size !== options.tickers.length) throw new TypeError('tickers must be unique');
  strictUtc(options.horizonEnd, 'horizon end');
  if (!Number.isInteger(options.intervalMs) || options.intervalMs < 1) throw new TypeError('interval must be a positive integer');
  if (!YAHOO_INTERVALS.has(options.intervalMs)) throw new TypeError('interval is unsupported by the direct provider');
  const marketDay = new Date(options.marketDate + 'T05:00:00.000Z');
  if (['Sat', 'Sun'].includes(jakartaWeekday(marketDay))) throw new CollectorError('MARKET_DATE_WEEKEND');
  if (marketDate(new Date(options.horizonEnd)) !== options.marketDate) throw new CollectorError('HORIZON_MARKET_DATE_MISMATCH');
  return options;
}

function verifyCleanCheckout() {
  for (const args of [['diff', '--quiet'], ['diff', '--cached', '--quiet']]) {
    const result = childProcess.spawnSync('git', args, { cwd: REPOSITORY_ROOT, stdio: 'ignore' });
    if (result.status !== 0) throw new CollectorError('TRACKED_CHECKOUT_DIRTY');
  }
}

function resolveCodeSha() {
  return childProcess.execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim();
}

function readPolicyFile(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.length < 2 || bytes.length > MAX_POLICY_BYTES) throw new CollectorError('POLICY_FILE_SIZE_INVALID');
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); }
  catch (_) { throw new CollectorError('POLICY_FILE_INVALID'); }
  try { return normalizePolicy(parsed); }
  catch (_) { throw new CollectorError('POLICY_FILE_INVALID'); }
}

function walkFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new CollectorError('INITIAL_EVIDENCE_UNSAFE');
      if (entry.isDirectory()) stack.push(target);
      else if (entry.isFile()) files.push(target);
      else throw new CollectorError('INITIAL_EVIDENCE_UNSAFE');
    }
  }
  return files;
}

function loadInitialRecords(root, date, slot, tickers) {
  const manifestRoot = path.join(root, 'manifests', date);
  if (!fs.existsSync(manifestRoot) || fs.lstatSync(manifestRoot).isSymbolicLink() || !fs.statSync(manifestRoot).isDirectory()) {
    throw new CollectorError('INITIAL_EVIDENCE_MISSING');
  }
  const records = [];
  for (const manifestFile of walkFiles(manifestRoot)) {
    if (!manifestFile.endsWith('.manifest.json')) throw new CollectorError('INITIAL_EVIDENCE_UNSAFE');
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); }
    catch (_) { throw new CollectorError('INITIAL_EVIDENCE_UNSAFE'); }
    const rawFile = path.resolve(root, manifest.relative_path || '');
    let lines;
    try {
      const text = zlib.gunzipSync(fs.readFileSync(rawFile)).toString('utf8');
      if (!text.endsWith('\n') || !text.trim()) throw new Error('invalid');
      lines = text.trim().split('\n');
    } catch (_) {
      throw new CollectorError('INITIAL_EVIDENCE_UNSAFE');
    }
    for (const line of lines) {
      try { records.push(normalizeEvaluationRecord(JSON.parse(line))); }
      catch (_) { throw new CollectorError('INITIAL_EVIDENCE_UNSAFE'); }
    }
  }
  const selected = tickers.map(ticker => {
    const matches = records.filter(record => record.ticker === ticker && record.scheduled_slot === slot && marketDate(new Date(record.observed_at)) === date);
    if (matches.length !== 1) throw new CollectorError(matches.length ? 'INITIAL_EVIDENCE_DUPLICATE' : 'INITIAL_EVIDENCE_MISSING');
    return matches[0];
  });
  const immutable = ['run_id', 'code_sha', 'config_hash', 'run_mode', 'scheduler_source', 'scheduled_slot', 'observed_at'];
  if (immutable.some(key => new Set(selected.map(record => record[key])).size !== 1) ||
      selected.some(record => record.scheduler_source !== 'manual_market_day_sample')) {
    throw new CollectorError('INITIAL_EVIDENCE_MIXED_IDENTITY');
  }
  return selected;
}

function semanticEvaluationKey(link, evaluatorVersion, normalizedPolicyHash, horizonEnd, intervalMs) {
  return crypto.createHash('sha256').update(Buffer.from(canonicalJson({
    initial_record_digest: link.record_digest,
    evaluator_version: evaluatorVersion,
    policy_hash: normalizedPolicyHash,
    horizon_version: 'manual-collector-horizon-v1',
    horizon_start_at: link.observed_at,
    horizon_end_at: horizonEnd,
    coverage_version: COVERAGE_VERSION,
    interval_ms: intervalMs
  }))).digest('hex');
}

function loadExistingSemanticKeys(root) {
  const manifestRoot = path.join(root, 'outcome-manifests');
  if (!fs.existsSync(manifestRoot)) return new Set();
  const keys = new Set();
  for (const manifestFile of walkFiles(manifestRoot)) {
    if (!manifestFile.endsWith('.manifest.json')) throw new CollectorError('OUTCOME_EVIDENCE_UNSAFE');
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); }
    catch (_) { throw new CollectorError('OUTCOME_EVIDENCE_UNSAFE'); }
    const rawFile = path.resolve(root, manifest.relative_path || '');
    let record;
    try {
      const text = zlib.gunzipSync(fs.readFileSync(rawFile)).toString('utf8');
      if (!text.endsWith('\n') || text.trim().split('\n').length !== 1) throw new Error('invalid');
      record = normalizeOutcomeRecord(JSON.parse(text.trim()));
    } catch (_) {
      throw new CollectorError('OUTCOME_EVIDENCE_UNSAFE');
    }
    keys.add(semanticEvaluationKey(
      record.initial_link,
      record.evaluator.version,
      record.evaluator.policy_hash,
      record.horizon.end_at,
      record.coverage.interval_ms
    ));
  }
  return keys;
}

function initialLink(record) {
  return {
    run_id: record.run_id,
    ticker: record.ticker,
    market_date: marketDate(new Date(record.observed_at)),
    scheduled_slot: record.scheduled_slot,
    observed_at: record.observed_at,
    code_sha: record.code_sha,
    config_hash: record.config_hash,
    record_digest: initialRecordDigest(record)
  };
}

function validateProviderBars(value, request, evidenceAsOf) {
  if (!Array.isArray(value) || value.length > MAX_PROVIDER_BARS) throw new CollectorError('PROVIDER_RESPONSE_INVALID');
  const start = Date.parse(request.startAt);
  const end = Date.parse(request.endAt);
  let previousEnd = start;
  return value.map((bar, index) => {
    try { exactObject(bar, OBSERVATION_KEYS, 'observation'); }
    catch (_) { throw new CollectorError('PROVIDER_RESPONSE_INVALID'); }
    if (bar.ticker !== request.ticker) throw new CollectorError('PROVIDER_MIXED_TICKER');
    const barStart = strictUtc(bar.start_at, 'bar start');
    const barEnd = strictUtc(bar.end_at, 'bar end');
    const sourceAsOf = strictUtc(bar.source_as_of, 'source as-of');
    if (barStart < start || barEnd > end || barEnd <= barStart) throw new CollectorError('PROVIDER_OBSERVATION_OUT_OF_RANGE');
    if (barStart < previousEnd) throw new CollectorError('PROVIDER_OBSERVATION_ORDER_INVALID');
    previousEnd = barEnd;
    if (sourceAsOf < barEnd || sourceAsOf > Date.parse(evidenceAsOf)) throw new CollectorError('PROVIDER_SOURCE_AS_OF_INVALID');
    for (const key of ['open', 'high', 'low', 'close']) {
      if (typeof bar[key] !== 'number' || !Number.isFinite(bar[key]) || bar[key] <= 0) throw new CollectorError('PROVIDER_RESPONSE_INVALID');
    }
    if (bar.low > Math.min(bar.open, bar.close, bar.high) || bar.high < Math.max(bar.open, bar.close, bar.low)) {
      throw new CollectorError('PROVIDER_RESPONSE_INVALID');
    }
    if (typeof bar.provenance !== 'string' || !bar.provenance || bar.provenance.length > 256) throw new CollectorError('PROVIDER_RESPONSE_INVALID');
    return { ...bar, _index: index };
  }).map(({ _index, ...bar }) => bar);
}

async function fetchYahooIntradayBars(request) {
  const interval = YAHOO_INTERVALS.get(request.intervalMs);
  if (!interval) throw new CollectorError('PROVIDER_INTERVAL_UNSUPPORTED');
  const symbol = encodeURIComponent(request.ticker + '.JK');
  const period1 = Math.floor(Date.parse(request.startAt) / 1000);
  const period2 = Math.ceil(Date.parse(request.endAt) / 1000) + 1;
  const url = 'https://query2.finance.yahoo.com/v8/finance/chart/' + symbol +
    '?period1=' + period1 + '&period2=' + period2 + '&interval=' + interval + '&includePrePost=false&events=div%2Csplits';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!response.ok) throw new CollectorError('PROVIDER_HTTP_FAILURE');
    const payload = await response.json();
    const result = payload && payload.chart && payload.chart.result && payload.chart.result[0];
    const quote = result && result.indicators && result.indicators.quote && result.indicators.quote[0];
    if (!result || !quote) throw new CollectorError('PROVIDER_RESPONSE_INVALID');
    const fetchedAt = new Date().toISOString();
    const timestamps = result.timestamp || [];
    const bars = [];
    for (let index = 0; index < timestamps.length; index++) {
      const startMs = Number(timestamps[index]) * 1000;
      const endMs = startMs + request.intervalMs;
      const open = Number(quote.open && quote.open[index]);
      const high = Number(quote.high && quote.high[index]);
      const low = Number(quote.low && quote.low[index]);
      const close = Number(quote.close && quote.close[index]);
      if (![startMs, open, high, low, close].every(Number.isFinite)) continue;
      if (startMs < Date.parse(request.startAt) || endMs > Date.parse(request.endAt)) continue;
      bars.push({
        ticker: request.ticker,
        start_at: new Date(startMs).toISOString(),
        end_at: new Date(endMs).toISOString(),
        open,
        high,
        low,
        close,
        provenance: 'yahoo_chart_intraday_direct_v1',
        source_as_of: fetchedAt
      });
    }
    return bars;
  } finally {
    clearTimeout(timer);
  }
}

function safeFailureSummary(options, finalized, prepared, code) {
  const done = new Set(finalized);
  return {
    schema_version: 1,
    error: code,
    market_date: options.marketDate,
    scheduled_slot: options.scheduledSlot,
    requested_count: options.tickers.length,
    finalized_count: finalized.length,
    results: prepared.map(item => ({
      ticker: item.initial.ticker,
      outcome: item.record.touches.outcome,
      finalization_status: done.has(item.initial.ticker) ? 'FINALIZED' : 'NOT_FINALIZED'
    }))
  };
}

async function runCollector(input, dependencies = {}) {
  const options = validateOptions(input);
  (dependencies.verifyCleanCheckout || verifyCleanCheckout)();
  const started = dependencies.now ? new Date(dependencies.now) : new Date();
  if (!Number.isFinite(started.getTime())) throw new TypeError('now is invalid');
  if (['Sat', 'Sun'].includes(jakartaWeekday(started))) throw new CollectorError('JAKARTA_WEEKEND');
  if (Date.parse(options.horizonEnd) > started.getTime()) throw new CollectorError('HORIZON_NOT_COMPLETE');

  const collectorCodeSha = (dependencies.resolveCodeSha || resolveCodeSha)();
  const policy = (dependencies.readPolicyFile || readPolicyFile)(options.policyFile);
  const normalizedPolicyHash = policyHash(policy);
  const firstAudit = (dependencies.preflightOutcomeTree || preflightOutcomeTree)({ root: options.evaluationRoot });
  const initials = (dependencies.loadInitialRecords || loadInitialRecords)(
    options.evaluationRoot,
    options.marketDate,
    options.scheduledSlot,
    options.tickers
  );
  if (initials.some(record => Date.parse(record.observed_at) >= Date.parse(options.horizonEnd))) {
    throw new CollectorError('HORIZON_NOT_AFTER_INITIAL');
  }
  const existingSemanticKeys = (dependencies.loadExistingSemanticKeys || loadExistingSemanticKeys)(options.evaluationRoot);
  const candidateSemanticKeys = initials.map(record => semanticEvaluationKey(
    initialLink(record),
    OUTCOME_EVALUATOR_VERSION,
    normalizedPolicyHash,
    options.horizonEnd,
    options.intervalMs
  ));
  if (candidateSemanticKeys.some(key => existingSemanticKeys.has(key))) {
    throw new CollectorError('DUPLICATE_FINALIZATION');
  }

  const fetchBars = dependencies.fetchBars || fetchYahooIntradayBars;
  const rawResponses = await Promise.all(initials.map(initial => fetchBars({
    ticker: initial.ticker,
    startAt: initial.observed_at,
    endAt: options.horizonEnd,
    intervalMs: options.intervalMs
  })));

  const afterFetch = dependencies.afterFetchNow ? new Date(dependencies.afterFetchNow()) : new Date();
  if (!Number.isFinite(afterFetch.getTime()) || afterFetch.getTime() < Date.parse(options.horizonEnd)) {
    throw new CollectorError('EVIDENCE_BOUNDARY_INVALID');
  }
  const evidenceAsOf = afterFetch.toISOString();
  const completion = dependencies.completedAt ? new Date(dependencies.completedAt) : afterFetch;
  if (!Number.isFinite(completion.getTime()) || completion.getTime() < afterFetch.getTime()) {
    throw new CollectorError('COMPLETION_TIME_INVALID');
  }
  const completedAt = completion.toISOString();

  const prepared = initials.map((initial, index) => {
    const bars = validateProviderBars(rawResponses[index], {
      ticker: initial.ticker,
      startAt: initial.observed_at,
      endAt: options.horizonEnd
    }, evidenceAsOf);
    const record = (dependencies.evaluateDayTradeOutcome || evaluateDayTradeOutcome)({
      initial,
      observations: bars,
      coverage: {
        version: COVERAGE_VERSION,
        interval_ms: options.intervalMs,
        start_at: initial.observed_at,
        end_at: options.horizonEnd,
        complete: true,
        provenance: 'manual_collector_declared_exact_intraday_response'
      },
      policy,
      horizon: {
        version: 'manual-collector-horizon-v1',
        end_at: options.horizonEnd
      },
      evidence_as_of: evidenceAsOf,
      completed_at: completedAt
    });
    return { initial, record };
  });

  const keys = prepared.map(item => item.record.evaluator.finalization_key);
  if (new Set(keys).size !== keys.length) throw new CollectorError('BATCH_FINALIZATION_KEY_COLLISION');
  if (keys.some(key => firstAudit.finalization_keys.has(key))) throw new CollectorError('DUPLICATE_FINALIZATION');
  const finalAudit = (dependencies.preflightOutcomeTree || preflightOutcomeTree)({ root: options.evaluationRoot });
  if (keys.some(key => finalAudit.finalization_keys.has(key))) throw new CollectorError('DUPLICATE_FINALIZATION');

  const finalized = [];
  try {
    for (const item of prepared) {
      (dependencies.createOutcomeLogger || createOutcomeLogger)({ root: options.evaluationRoot, record: item.record });
      finalized.push(item.initial.ticker);
    }
  } catch (_) {
    throw new CollectorError('FINALIZATION_PARTIAL', safeFailureSummary(options, finalized, prepared, 'FINALIZATION_PARTIAL'));
  }

  return {
    schema_version: 1,
    market_date: options.marketDate,
    scheduled_slot: options.scheduledSlot,
    requested_count: options.tickers.length,
    resolved_initial_count: initials.length,
    finalized_count: finalized.length,
    unresolved_count: prepared.filter(item => item.record.touches.outcome === 'UNRESOLVED').length,
    code_sha: initials[0].code_sha,
    collector_code_sha: collectorCodeSha,
    policy_hash: normalizedPolicyHash,
    results: prepared.map(item => ({
      ticker: item.initial.ticker,
      entry_state: item.record.entry.state,
      outcome: item.record.touches.outcome,
      finalization_status: 'FINALIZED'
    }))
  };
}

function failureOutput(error) {
  if (error && error.summary) return error.summary;
  return { schema_version: 1, error: error instanceof CollectorError ? error.code : 'INTERNAL_ERROR' };
}

module.exports = {
  MAX_TICKERS,
  SAMPLE_SLOTS,
  REPOSITORY_ROOT,
  COVERAGE_VERSION,
  YAHOO_INTERVALS,
  CollectorError,
  parseArgs,
  normalizeTicker,
  validateOptions,
  verifyCleanCheckout,
  resolveCodeSha,
  readPolicyFile,
  loadInitialRecords,
  semanticEvaluationKey,
  loadExistingSemanticKeys,
  initialLink,
  validateProviderBars,
  fetchYahooIntradayBars,
  runCollector,
  failureOutput,
  OUTCOME_EVALUATOR_VERSION,
  finalizationKey,
  crypto
};
