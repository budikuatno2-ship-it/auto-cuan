'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { once } = require('node:events');
const base = require('./generate-ai-eval-dataset');

function arg(name, fallback) {
  const prefix = '--' + name + '=';
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}
function boundedInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (key === 'id' || key === 'captured_at') continue;
      out[key] = stable(value[key]);
    }
    return out;
  }
  return value;
}
function fingerprint(row) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(row))).digest();
}

class BloomFilter {
  constructor(bitPower, hashes) {
    this.bitPower = bitPower;
    this.bitCount = 2 ** bitPower;
    this.mask = this.bitCount - 1;
    this.bits = Buffer.alloc(this.bitCount >>> 3);
    this.hashes = hashes;
  }
  indices(digest) {
    const first = digest.readUInt32BE(0) >>> 0;
    const second = (digest.readUInt32BE(4) | 1) >>> 0;
    return Array.from({ length: this.hashes }, (_, i) => (first + Math.imul(i, second)) & this.mask);
  }
  hasAndAdd(digest) {
    const indices = this.indices(digest);
    let present = true;
    for (const index of indices) {
      const byte = index >>> 3;
      const mask = 1 << (index & 7);
      if ((this.bits[byte] & mask) === 0) present = false;
    }
    if (!present) {
      for (const index of indices) this.bits[index >>> 3] |= 1 << (index & 7);
    }
    return present;
  }
}

function qualityCheck(row) {
  if (!row || !row.id || !row.task || !row.intent || !row.question || !row.context || !row.expected) return false;
  if (!['stock_analysis_followup', 'portfolio_chat'].includes(row.task)) return false;
  if (String(row.question).trim().length < 8) return false;
  if (!Array.isArray(row.expected.allowed_numbers) || row.expected.allowed_numbers.length === 0) return false;
  if (row.expected.allowed_numbers.some((value) => !Number.isFinite(Number(value)) || Number(value) < 0)) return false;
  if (row.task === 'stock_analysis_followup') return Boolean(row.context.ticker && row.context.analysis_text);
  return Array.isArray(row.context.plans) && row.context.plans.length > 0;
}

async function writeUniqueRows(config) {
  fs.mkdirSync(path.dirname(config.output), { recursive: true });
  const target = fs.createWriteStream(config.output, { flags: 'w' });
  const writer = config.output.endsWith('.gz') ? zlib.createGzip({ level: 9 }) : target;
  if (writer !== target) writer.pipe(target);

  const next = base.rng(config.seed);
  const bloom = new BloomFilter(config.bloomBitPower, config.bloomHashes);
  let attempts = 0;
  let generated = 0;
  let duplicateStreak = 0;
  let duplicatesSkipped = 0;
  let rejectedQuality = 0;

  while (generated < config.maxCases && attempts < config.maxAttempts && duplicateStreak < config.maxDuplicateStreak) {
    const row = base.makeCase(attempts, next, config.stockRatio);
    attempts += 1;
    if (!qualityCheck(row)) {
      rejectedQuality += 1;
      duplicateStreak += 1;
      continue;
    }
    if (bloom.hasAndAdd(fingerprint(row))) {
      duplicatesSkipped += 1;
      duplicateStreak += 1;
      continue;
    }
    duplicateStreak = 0;
    generated += 1;
    row.id = row.task === 'portfolio_chat'
      ? 'ac-portfolio-' + String(generated).padStart(7, '0')
      : 'ac-stock-' + String(generated).padStart(7, '0');
    if (!writer.write(JSON.stringify(row) + '\n', 'utf8')) await once(writer, 'drain');
  }

  writer.end();
  await once(target, 'finish');
  const stoppedReason = generated >= config.maxCases
    ? 'max_unique_cases_reached'
    : duplicateStreak >= config.maxDuplicateStreak
      ? 'quality_variations_exhausted'
      : 'max_attempts_reached';
  return { attempts, generated, duplicatesSkipped, rejectedQuality, stoppedReason };
}

async function main() {
  const maxCases = boundedInt(arg('count', '1000000'), 1000000, 1, 1000000);
  const seed = boundedInt(arg('seed', '20260803'), 20260803, 1, 2147483647);
  const stockRatio = boundedInt(arg('stock-ratio', '60'), 60, 0, 100);
  const output = path.resolve(arg('output', 'tmp/ai-eval-quality-dataset.jsonl.gz'));
  const maxAttemptsDefault = Math.min(maxCases + 250000, maxCases * 3);
  const maxAttempts = boundedInt(arg('max-attempts', String(maxAttemptsDefault)), maxAttemptsDefault, maxCases, 3000000);
  const maxDuplicateStreak = boundedInt(arg('max-duplicate-streak', '50000'), 50000, 100, 250000);
  const config = { maxCases, seed, stockRatio, output, maxAttempts, maxDuplicateStreak, bloomBitPower: 27, bloomHashes: 7 };
  const result = await writeUniqueRows(config);
  process.stdout.write(JSON.stringify({
    success: true,
    requested_max_cases: maxCases,
    generated_unique_cases: result.generated,
    attempts: result.attempts,
    duplicates_skipped: result.duplicatesSkipped,
    rejected_quality: result.rejectedQuality,
    stopped_reason: result.stoppedReason,
    stock_ratio_pct: stockRatio,
    portfolio_ratio_pct: 100 - stockRatio,
    compression: output.endsWith('.gz') ? 'gzip' : 'none',
    quality_first: true,
    output
  }) + '\n');
}

if (require.main === module) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });

module.exports = { BloomFilter, stable, fingerprint, qualityCheck, writeUniqueRows };
