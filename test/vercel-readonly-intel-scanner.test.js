const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Vercel Serverless Read-Only Guard: getBandarmologiIntel loads precomputed index without crashing', async () => {
  const intelService = require('../lib/bandarmologi-intel-service');

  // Ensure getBandarmologiIntel succeeds without crashing
  const intelResult = await intelService.getBandarmologiIntel();
  assert.equal(intelResult.success, true, 'Result should have success: true');
  assert.ok(intelResult.indexes, 'Result should have indexes object');
  assert.ok(intelResult.summary, 'Result should have summary object');

  // Verify all 5 market scanner categories are present as arrays. Detection
  // counts are data-dependent (the committed index may legitimately be empty),
  // so assert the shape, not a non-zero count.
  assert.ok(Array.isArray(intelResult.indexes.harga_di_bawah_modal_bandar), 'harga_di_bawah_modal_bandar index array exists');
  assert.ok(Array.isArray(intelResult.indexes.silent_foreign_accumulation), 'silent_foreign_accumulation index array exists');
  assert.ok(Array.isArray(intelResult.indexes.ritel_cutloss_bandar_nampung), 'ritel_cutloss_bandar_nampung index array exists');
  assert.ok(Array.isArray(intelResult.indexes.distribusi_ke_ritel), 'distribusi_ke_ritel index array exists');
  assert.ok(Array.isArray(intelResult.indexes.cr3_massive), 'cr3_massive index array exists');

  assert.equal(typeof intelResult.summary.harga_di_bawah_modal_bandar_count, 'number', 'summary count must be a number');
});

test('Vercel Serverless Simulation: safeWriteJson & computeAndSaveIntel gracefully handle EROFS / ENOENT', () => {
  const intelService = require('../lib/bandarmologi-intel-service');
  const originalMkdirSync = fs.mkdirSync;
  const originalWriteFileSync = fs.writeFileSync;

  // Hygiene fix: computeAndSaveIntel writes FOUR files (latest/catalog plus the
  // _7d variants), but only two used to be backed up — so running this test
  // silently clobbered committed index data. Redirect every output location to
  // a temp dir instead, which also keeps the original EROFS intent intact.
  // The temp path must still contain the literal "arjum-data" segment, otherwise
  // the EROFS interceptor below would stop matching and the test would silently
  // stop exercising the read-only path it exists to protect.
  const isolatedRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'autocuan-vercel-'));
  const isolatedIndexDir = path.join(isolatedRoot, 'intel-indexes');
  const isolatedArjumDir = path.join(isolatedRoot, 'arjum-data', 'bandarmologi-intel');
  fs.mkdirSync(isolatedIndexDir, { recursive: true });
  fs.mkdirSync(isolatedArjumDir, { recursive: true });
  const previousIndexDir = process.env.INTEL_INDEX_DIR;
  const previousArjumDir = process.env.ARJUM_DATA_DIR;
  process.env.INTEL_INDEX_DIR = isolatedIndexDir;
  process.env.ARJUM_DATA_DIR = isolatedArjumDir;

  const latestFile = null;
  const catalogFile = null;
  const backupLatest = null;
  const backupCatalog = null;

  let simulatedVercelReadOnly = true;

  try {
    // Intercept fs.mkdirSync and fs.writeFileSync to throw EROFS when targeting /var/task or data/
    fs.mkdirSync = function (dirPath, opts) {
      if (simulatedVercelReadOnly && String(dirPath).includes('arjum-data')) {
        const err = new Error("EROFS: read-only file system, mkdir '/var/task/data/arjum-data/bandarmologi-intel'");
        err.code = 'EROFS';
        throw err;
      }
      return originalMkdirSync.call(fs, dirPath, opts);
    };

    fs.writeFileSync = function (filePath, data, opts) {
      if (simulatedVercelReadOnly && String(filePath).includes('arjum-data')) {
        const err = new Error("EROFS: read-only file system, open '/var/task/data/arjum-data/bandarmologi-intel/latest.json'");
        err.code = 'EROFS';
        throw err;
      }
      return originalWriteFileSync.call(fs, filePath, data, opts);
    };

    // Attempting computeAndSaveIntel on limited subset must NOT throw uncaught EROFS
    assert.doesNotThrow(() => {
      const res = intelService.computeAndSaveIntel({ tickers: ['BBCA', 'ASII'] });
      assert.ok(res);
      assert.ok(res.indexes);
    }, 'Must not throw EROFS error during computeAndSaveIntel');

  } finally {
    fs.mkdirSync = originalMkdirSync;
    fs.writeFileSync = originalWriteFileSync;
    if (previousIndexDir === undefined) delete process.env.INTEL_INDEX_DIR;
    else process.env.INTEL_INDEX_DIR = previousIndexDir;
    if (previousArjumDir === undefined) delete process.env.ARJUM_DATA_DIR;
    else process.env.ARJUM_DATA_DIR = previousArjumDir;
    try { fs.rmSync(isolatedIndexDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(isolatedArjumDir, { recursive: true, force: true }); } catch (_) {}
  }
});
