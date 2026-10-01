'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { normalizeEvaluationRecord } = require('./screener-evaluation-contract');
const { auditRetention } = require('./screener-evaluation-retention');

const DEFAULT_ROOT = '/home/ubuntu/auto-cuan-evaluation';

function enabled(env = process.env) { return String(env.EVALUATION_LOGGING_ENABLED || '').toLowerCase() === 'true'; }
function safePart(value) { return String(value).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80); }
function writeAtomic(file, data) {
  const temporary = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
  fs.writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, file);
}

function createLocalEvaluationLogger(options = {}) {
  const env = options.env || process.env;
  if (!enabled(env)) return null;
  const root = options.root || env.EVALUATION_LOG_ROOT || DEFAULT_ROOT;
  if (typeof options.runId !== 'string' || !options.runId || options.runId.length > 128 || !/^[A-Za-z0-9_.-]+$/.test(options.runId)) throw new TypeError('runId is invalid');
  const runId = safePart(options.runId);
  const date = safePart(options.marketDate);
  if (!runId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new TypeError('runId and marketDate are required');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const diskAudit = options.diskAudit || auditRetention({ root });
  if (diskAudit.writes_should_stop) throw new Error('evaluation disk safety threshold reached');
  const directory = path.join(root, 'raw', date, 'day-trade');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stem = runId + '-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
  const openFile = path.join(directory, stem + '.open.jsonl.gz');
  fs.writeFileSync(openFile, Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
  let count = 0; let firstTimestamp = null; let lastTimestamp = null; let finalized = false; let currentFile = openFile;
  return {
    append(record) {
      if (finalized) throw new Error('evaluation file is finalized');
      const normalized = normalizeEvaluationRecord(record);
      const timestamp = normalized.observed_at || normalized.feature_as_of_ts;
      fs.appendFileSync(openFile, zlib.gzipSync(Buffer.from(JSON.stringify(normalized) + '\n')), { mode: 0o600 });
      count++; firstTimestamp = firstTimestamp || timestamp || null; lastTimestamp = timestamp || lastTimestamp;
    },
    finalize() {
      if (finalized) return this.manifest;
      const closedFile = openFile.replace('.open.jsonl.gz', '.jsonl.gz');
      fs.renameSync(openFile, closedFile);
      currentFile = closedFile;
      const content = fs.readFileSync(closedFile);
      const manifest = { schema_version: 1, strategy: 'DAY_TRADE', run_id: options.runId, relative_path: path.relative(root, closedFile), byte_size: content.length, record_count: count, first_timestamp: firstTimestamp, last_timestamp: lastTimestamp, sha256: crypto.createHash('sha256').update(content).digest('hex'), finalized_at: new Date().toISOString() };
      const manifestDir = path.join(root, 'manifests', date);
      fs.mkdirSync(manifestDir, { recursive: true, mode: 0o700 });
      writeAtomic(path.join(manifestDir, path.basename(closedFile) + '.manifest.json'), JSON.stringify(manifest) + '\n');
      finalized = true; this.manifest = manifest; return manifest;
    },
    abort(reason) {
      if (finalized || !fs.existsSync(currentFile)) return null;
      const quarantineDir = path.join(root, 'quarantine', date);
      fs.mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
      const target = path.join(quarantineDir, path.basename(currentFile).replace(/(?:\.open)?\.jsonl\.gz$/, '.invalid.jsonl.gz'));
      fs.renameSync(currentFile, target);
      writeAtomic(target + '.status.json', JSON.stringify({ schema_version: 1, status: 'INVALID', relative_path: path.relative(root, target), reason_code: safePart(reason || 'WRITE_FAILED'), quarantined_at: new Date().toISOString() }) + '\n');
      return target;
    },
    get openFile() { return openFile; }
  };
}

function observeEvaluation(productionValue, options, records) {
  if (!enabled((options && options.env) || process.env)) return productionValue;
  let logger = null;
  try {
    const normalizedRecords = (records || []).map(normalizeEvaluationRecord);
    logger = createLocalEvaluationLogger(options);
    for (const record of normalizedRecords) logger.append(record);
    logger.finalize();
  } catch (error) {
    try { if (logger) logger.abort('WRITE_OR_VALIDATION_FAILED'); } catch (_) { /* fail open */ }
    if (options && typeof options.onError === 'function') options.onError(error);
  }
  return productionValue;
}

module.exports = { DEFAULT_ROOT, enabled, createLocalEvaluationLogger, observeEvaluation };
