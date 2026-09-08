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

  // Verify all 5 market scanner categories are populated in pre-computed index
  assert.ok(Array.isArray(intelResult.indexes.harga_di_bawah_modal_bandar), 'harga_di_bawah_modal_bandar index array exists');
  assert.ok(Array.isArray(intelResult.indexes.silent_foreign_accumulation), 'silent_foreign_accumulation index array exists');
  assert.ok(Array.isArray(intelResult.indexes.ritel_cutloss_bandar_nampung), 'ritel_cutloss_bandar_nampung index array exists');
  assert.ok(Array.isArray(intelResult.indexes.distribusi_ke_ritel), 'distribusi_ke_ritel index array exists');
  assert.ok(Array.isArray(intelResult.indexes.cr3_massive), 'cr3_massive index array exists');

  assert.ok(intelResult.indexes.harga_di_bawah_modal_bandar.length > 0, 'harga_di_bawah_modal_bandar should have detections');
  assert.ok(intelResult.summary.harga_di_bawah_modal_bandar_count > 0, 'summary count should match');
});

test('Vercel Serverless Simulation: safeWriteJson & computeAndSaveIntel gracefully handle EROFS / ENOENT', () => {
  const intelService = require('../lib/bandarmologi-intel-service');
  const originalMkdirSync = fs.mkdirSync;
  const originalWriteFileSync = fs.writeFileSync;

  const latestFile = path.join(__dirname, '..', 'data', 'bandarmologi-intel-indexes', 'latest.json');
  const catalogFile = path.join(__dirname, '..', 'data', 'bandarmologi-intel-indexes', 'catalog.json');
  const backupLatest = fs.existsSync(latestFile) ? fs.readFileSync(latestFile, 'utf8') : null;
  const backupCatalog = fs.existsSync(catalogFile) ? fs.readFileSync(catalogFile, 'utf8') : null;

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
    if (backupLatest) fs.writeFileSync(latestFile, backupLatest, 'utf8');
    if (backupCatalog) fs.writeFileSync(catalogFile, backupCatalog, 'utf8');
  }
});
