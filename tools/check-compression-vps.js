'use strict';

/**
 * Fase 1B: Compression benchmark on a copy in data/_staging/compress-test/
 * Samples: 3 liquid (BBCA, BBRI, BMRI) + 3 quiet (ALDO, BIKA, CITY) x 1 month x all/F
 * Formats compared: raw JSON, gzip per file, zstd per file, monthly-archive gz, sqlite
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SRC_ALL = '/home/ubuntu/auto-cuan/data/arjum-data/broker-summary';
const SRC_F = '/home/ubuntu/auto-cuan/data/arjum-data/broker-summary-F';
const STAGING = '/home/ubuntu/auto-cuan/data/_staging/compress-test';

const LIQUID = ['BBCA', 'BBRI', 'BMRI'];
const QUIET = ['ALDO', 'BIKA', 'CITY'];
const TICKERS = [...LIQUID, ...QUIET];

// Build a list of 21 trading dates in September 2026 (approx one month)
const MONTH_DATES = [
  '2026-09-01','2026-09-02','2026-09-03','2026-09-04','2026-09-07','2026-09-08','2026-09-09','2026-09-10',
  '2026-09-11','2026-09-14','2026-09-15','2026-09-16','2026-09-17','2026-09-18','2026-09-21','2026-09-22',
  '2026-09-23','2026-09-24','2026-09-25','2026-09-28','2026-09-29'
];

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {}
}

function human(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(2) + ' MB';
}

async function main() {
  rmrf(STAGING);

  // ── Setup raw copies ──────────────────────────────────────────────────
  const rawDir = path.join(STAGING, 'raw');
  fs.mkdirSync(rawDir, { recursive: true });

  const rawFiles = [];
  for (const tk of TICKERS) {
    for (const flow of ['all', 'F']) {
      const srcDir = flow === 'all' ? path.join(SRC_ALL, tk) : path.join(SRC_F, tk);
      if (!fs.existsSync(srcDir)) continue;
      const dstDir = path.join(rawDir, flow, tk);
      fs.mkdirSync(dstDir, { recursive: true });
      for (const d of MONTH_DATES) {
        const srcFile = path.join(srcDir, d + '.json');
        if (!fs.existsSync(srcFile)) continue;
        const dstFile = path.join(dstDir, d + '.json');
        fs.copyFileSync(srcFile, dstFile);
        rawFiles.push({ ticker: tk, flow, date: d, raw: dstFile });
      }
    }
  }

  const rawSize = rawFiles.reduce((a, r) => a + fs.statSync(r.raw).size, 0);

  // ── 4KB block waste estimation ────────────────────────────────────────
  const BLOCK = 4096;
  let blockAllocated = 0;
  for (const r of rawFiles) {
    const sz = fs.statSync(r.raw).size;
    blockAllocated += Math.ceil(sz / BLOCK) * BLOCK;
  }
  const blockWaste = blockAllocated - rawSize;

  // ── GZIP per file ─────────────────────────────────────────────────────
  let gzipSize = 0;
  let gzipCount = 0;
  for (const r of rawFiles) {
    const buf = fs.readFileSync(r.raw);
    const gz = zlib.gzipSync(buf, { level: 6 });
    gzipSize += gz.length;
    gzipCount++;
  }

  // ── Brotli per file ───────────────────────────────────────────────────
  let brotliSize = 0;
  for (const r of rawFiles) {
    const buf = fs.readFileSync(r.raw);
    const br = zlib.brotliCompressSync(buf, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 }
    });
    brotliSize += br.length;
  }

  // ── Monthly archive .json.gz (one per ticker per flow) ────────────────
  let monthlyGzSize = 0;
  let monthlyGzFiles = 0;
  for (const tk of TICKERS) {
    for (const flow of ['all', 'F']) {
      const bucket = rawFiles.filter(r => r.ticker === tk && r.flow === flow);
      if (bucket.length === 0) continue;
      const merged = {};
      for (const r of bucket) {
        merged[r.date] = JSON.parse(fs.readFileSync(r.raw, 'utf8'));
      }
      const json = JSON.stringify(merged);
      const gz = zlib.gzipSync(Buffer.from(json), { level: 6 });
      monthlyGzSize += gz.length;
      monthlyGzFiles++;
    }
  }

  // ── Read timing test: 1 day vs 20 days ────────────────────────────────
  const sampleTicker = 'BBCA';
  const sampleDay = MONTH_DATES[10];

  // Raw read 1 day
  let t0 = process.hrtime.bigint();
  const rawDayPath = path.join(rawDir, 'all', sampleTicker, sampleDay + '.json');
  if (fs.existsSync(rawDayPath)) {
    JSON.parse(fs.readFileSync(rawDayPath, 'utf8'));
  }
  const raw1dNs = Number(process.hrtime.bigint() - t0);

  // Raw read 20 days
  t0 = process.hrtime.bigint();
  for (const d of MONTH_DATES) {
    const p = path.join(rawDir, 'all', sampleTicker, d + '.json');
    if (fs.existsSync(p)) JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  const raw20dNs = Number(process.hrtime.bigint() - t0);

  // Gzip read 20 days (simulated: read raw + gunzip)
  t0 = process.hrtime.bigint();
  for (const d of MONTH_DATES) {
    const p = path.join(rawDir, 'all', sampleTicker, d + '.json');
    if (fs.existsSync(p)) {
      const gz = zlib.gzipSync(fs.readFileSync(p), { level: 6 });
      JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
    }
  }
  const gzip20dNs = Number(process.hrtime.bigint() - t0);

  // Monthly-gz read 20 days
  const monthlyBucket = rawFiles.filter(r => r.ticker === sampleTicker && r.flow === 'all');
  const monthlyMerged = {};
  for (const r of monthlyBucket) {
    monthlyMerged[r.date] = JSON.parse(fs.readFileSync(r.raw, 'utf8'));
  }
  const monthlyJson = JSON.stringify(monthlyMerged);
  const monthlyGz = zlib.gzipSync(Buffer.from(monthlyJson), { level: 6 });
  t0 = process.hrtime.bigint();
  const decompressed = JSON.parse(zlib.gunzipSync(monthlyGz).toString('utf8'));
  for (const d of MONTH_DATES) {
    if (decompressed[d]) { /* read one day */ }
  }
  const monthly20dNs = Number(process.hrtime.bigint() - t0);

  // ── Write JSON report ─────────────────────────────────────────────────
  const report = {
    sample: {
      tickers: TICKERS,
      liquid: LIQUID,
      quiet: QUIET,
      flows: ['all', 'F'],
      month_dates: MONTH_DATES,
      file_count: rawFiles.length
    },
    raw: {
      total_bytes: rawSize,
      file_count: rawFiles.length,
      avg_file_bytes: Math.round(rawSize / Math.max(1, rawFiles.length)),
      block_4096_allocated: blockAllocated,
      block_4096_waste: blockWaste,
      block_waste_pct: Number(((blockWaste / Math.max(1, blockAllocated)) * 100).toFixed(2))
    },
    gzip_per_file: {
      total_bytes: gzipSize,
      ratio_vs_raw: Number((gzipSize / Math.max(1, rawSize)).toFixed(4)),
      file_count: gzipCount
    },
    brotli_per_file: {
      total_bytes: brotliSize,
      ratio_vs_raw: Number((brotliSize / Math.max(1, rawSize)).toFixed(4))
    },
    monthly_gz: {
      total_bytes: monthlyGzSize,
      file_count: monthlyGzFiles,
      ratio_vs_raw: Number((monthlyGzSize / Math.max(1, rawSize)).toFixed(4))
    },
    read_timing_ns: {
      raw_1day: raw1dNs,
      raw_20days: raw20dNs,
      gzip_20days: gzip20dNs,
      monthly_gz_20days: monthly20dNs
    },
    notes: [
      'sqlite benchmark deferred: zstd CLI and better-sqlite3 are not guaranteed on the VPS; gzip/brotli results are sufficient to compare.'
    ]
  };

  fs.writeFileSync(path.join(STAGING, 'compression_report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
