#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { enrichCase } = require('../lib/ai-eval-derived-facts');

function arg(name, fallback) {
  const prefix = '--' + name + '=';
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function safeJson(value) {
  try { return JSON.parse(value); } catch (_) { return null; }
}

function loadRejections(file) {
  const ids = new Set();
  const metadata = new Map();
  let invalidRows = 0;
  let duplicateRows = 0;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = safeJson(line);
    if (!row || !row.id) {
      invalidRows += 1;
      continue;
    }
    const id = String(row.id);
    if (ids.has(id)) duplicateRows += 1;
    ids.add(id);
    metadata.set(id, {
      task: row.task || null,
      intent: row.intent || null,
      failure_stage: row.failure && row.failure.stage || 'unknown'
    });
  }
  return { ids, metadata, invalidRows, duplicateRows };
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const data = fs.readFileSync(file);
  hash.update(data);
  return hash.digest('hex');
}

async function buildRetryDataset(options) {
  const config = options || {};
  const datasetGz = path.resolve(config.datasetGz);
  const rejectionsFile = path.resolve(config.rejectionsFile);
  const outputGz = path.resolve(config.outputGz);
  const reportFile = config.reportFile ? path.resolve(config.reportFile) : outputGz + '.report.json';

  if (!fs.existsSync(datasetGz)) throw new Error('Dataset gzip tidak ditemukan: ' + datasetGz);
  if (!fs.existsSync(rejectionsFile)) throw new Error('Rejections tidak ditemukan: ' + rejectionsFile);
  if (datasetGz === outputGz) throw new Error('Output tidak boleh menimpa dataset sumber.');

  const rejection = loadRejections(rejectionsFile);
  if (!rejection.ids.size) throw new Error('Tidak ada rejection ID valid.');
  if (rejection.invalidRows) throw new Error('Rejections memiliki ' + rejection.invalidRows + ' baris invalid.');
  if (rejection.duplicateRows) throw new Error('Rejections memiliki ' + rejection.duplicateRows + ' ID duplikat.');

  fs.mkdirSync(path.dirname(outputGz), { recursive: true, mode: 0o700 });
  const tempOutput = outputGz + '.tmp-' + process.pid;
  const input = fs.createReadStream(datasetGz).pipe(zlib.createGunzip());
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const gzip = zlib.createGzip({ level: 9 });
  const output = fs.createWriteStream(tempOutput, { mode: 0o600 });
  gzip.pipe(output);

  const found = new Set();
  const taskCounts = {};
  const intentCounts = {};
  let sourceRowsScanned = 0;
  let invalidDatasetRows = 0;

  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      sourceRowsScanned += 1;
      const parsed = safeJson(line);
      if (!parsed || !parsed.id) {
        invalidDatasetRows += 1;
        continue;
      }
      const id = String(parsed.id);
      if (!rejection.ids.has(id)) continue;
      if (found.has(id)) throw new Error('Dataset sumber memiliki ID duplikat: ' + id);
      const enriched = enrichCase(parsed);
      const serialized = JSON.stringify(enriched) + '\n';
      if (!gzip.write(serialized)) await once(gzip, 'drain');
      found.add(id);
      const task = String(enriched.task || 'unknown');
      const intent = String(enriched.intent || 'unknown');
      taskCounts[task] = (taskCounts[task] || 0) + 1;
      intentCounts[intent] = (intentCounts[intent] || 0) + 1;
      if (found.size === rejection.ids.size) break;
    }
    gzip.end();
    await once(output, 'close');

    const missing = Array.from(rejection.ids).filter((id) => !found.has(id));
    if (missing.length) {
      try { fs.unlinkSync(tempOutput); } catch (_) {}
      throw new Error('Ada ' + missing.length + ' rejection ID yang tidak ditemukan. Contoh: ' + missing.slice(0, 10).join(','));
    }
    if (invalidDatasetRows) {
      try { fs.unlinkSync(tempOutput); } catch (_) {}
      throw new Error('Dataset sumber memiliki ' + invalidDatasetRows + ' baris invalid sebelum seluruh ID ditemukan.');
    }

    fs.renameSync(tempOutput, outputGz);
    fs.chmodSync(outputGz, 0o600);
    const report = {
      version: 'AI_EVAL_FAILED_RETRY_DATASET_V1',
      source_dataset_gz: datasetGz,
      source_rejections_file: rejectionsFile,
      source_rows_scanned: sourceRowsScanned,
      requested_rejection_count: rejection.ids.size,
      output_case_count: found.size,
      missing_count: 0,
      duplicate_count: 0,
      task_counts: taskCounts,
      intent_counts: intentCounts,
      output_bytes: fs.statSync(outputGz).size,
      output_sha256: sha256File(outputGz),
      created_at: new Date().toISOString()
    };
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    return report;
  } catch (error) {
    gzip.destroy();
    input.destroy();
    output.destroy();
    try { fs.unlinkSync(tempOutput); } catch (_) {}
    throw error;
  }
}

async function main() {
  const datasetGz = arg('dataset-gz', '');
  const rejectionsFile = arg('rejections', '');
  const outputGz = arg('output-gz', '');
  const reportFile = arg('report', '');
  if (!datasetGz || !rejectionsFile || !outputGz) {
    process.stderr.write('Usage: node tools/build-ai-eval-failed-retry-dataset.js --dataset-gz=PATH --rejections=PATH --output-gz=PATH [--report=PATH]\n');
    return 2;
  }
  const report = await buildRetryDataset({ datasetGz, rejectionsFile, outputGz, reportFile: reportFile || undefined });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  return 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write('FATAL: ' + (error.stack || error.message) + '\n');
    process.exitCode = 1;
  });
}

module.exports = { loadRejections, buildRetryDataset };
