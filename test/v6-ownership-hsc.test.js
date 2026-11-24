'use strict';

/**
 * test/v6-ownership-hsc.test.js
 * ============================================================================
 * Comprehensive Unit and Regression Test Suite for Subtask E (Ownership & HSC)
 * Covers:
 * 1. Parser & Validator Indonesian Numbers, Percentages, and Tickers
 * 2. Ownership CSV & JSON ingestion preview and validation (REQ-39)
 * 3. HSC Status CSV & JSON ingestion preview and validation (REQ-39)
 * 4. Free Float Reconciliation IDX vs KSEI (REQ-20)
 * 5. HSC State Neutrality: Unknown is null / "— / Belum dievaluasi" (REQ-21, REQ-22)
 * 6. Free float < 15% does not force HSC flag (REQ-21, REQ-22)
 * 7. Shareholder roster complete details (shares, %, controller, as_of, source) (REQ-38)
 * 8. Atomic Backup, Rollback, and Audit Chaining (REQ-39)
 * 9. API /api/struktur-pasar endpoint behavior and single ticker query
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const adminOwnership = require('../lib/admin-ownership-import');
const strukturPasarApi = require('../api/struktur-pasar');

test('V6-OWNERSHIP-1: Indonesian number parsing handles various formats cleanly', () => {
  assert.equal(adminOwnership.parseIndonesianNumber('1.234.567'), 1234567);
  assert.equal(adminOwnership.parseIndonesianNumber('1.234.567,89'), 1234567.89);
  assert.equal(adminOwnership.parseIndonesianNumber('41,82%'), 41.82);
  assert.equal(adminOwnership.parseIndonesianNumber('22.33%'), 22.33);
  assert.equal(adminOwnership.parseIndonesianNumber('0,32'), 0.32);
  assert.equal(adminOwnership.parseIndonesianNumber('-'), null);
  assert.equal(adminOwnership.parseIndonesianNumber('—'), null);
  assert.equal(adminOwnership.parseIndonesianNumber(''), null);
  assert.equal(adminOwnership.parseIndonesianNumber(null), null);
});

test('V6-OWNERSHIP-2: HSC boolean parsing is fail-closed (unknown returns null, not false)', () => {
  assert.equal(adminOwnership.parseHscBoolean('true'), true);
  assert.equal(adminOwnership.parseHscBoolean('1'), true);
  assert.equal(adminOwnership.parseHscBoolean('ya'), true);
  assert.equal(adminOwnership.parseHscBoolean('HSC'), true);
  assert.equal(adminOwnership.parseHscBoolean('aktif'), true);

  assert.equal(adminOwnership.parseHscBoolean('false'), false);
  assert.equal(adminOwnership.parseHscBoolean('0'), false);
  assert.equal(adminOwnership.parseHscBoolean('tidak'), false);
  assert.equal(adminOwnership.parseHscBoolean('clear'), false);

  // Crucial invariant for REQ-21 & REQ-22:
  assert.equal(adminOwnership.parseHscBoolean(''), null);
  assert.equal(adminOwnership.parseHscBoolean('-'), null);
  assert.equal(adminOwnership.parseHscBoolean('unknown'), null);
  assert.equal(adminOwnership.parseHscBoolean('belum evaluasi'), null);
  assert.equal(adminOwnership.parseHscBoolean(null), null);
  assert.equal(adminOwnership.parseHscBoolean(undefined), null);
});

test('V6-OWNERSHIP-3: Ownership CSV parser validates headers and produces structured records', () => {
  const csvData = `ticker, investor_name, shares, percentage, category, is_controller, as_of, source, free_float_ksei, free_float_idx
BBCA, "PT DWIMURIA INVESTAMA ANDALAN", 67729950000, "54,94%", Corporate, 1, 2026-09-30, KSEI, "41,82%", "41,82%"
BBCA, "PUBLIK / MASYARAKAT", 51520000000, "41,82%", Publik, 0, 2026-09-30, KSEI, "41,82%", "41,82%"
BREN, "PT BARITO PACIFIC TBK", 86513000000, "64,67%", Corporate, Ya, 2026-09-30, KSEI, "11,73%", "12,50%"`;

  const parsed = adminOwnership.parseAndValidateOwnership(csvData, 'csv');
  assert.equal(parsed.validRows, 3);
  assert.equal(parsed.invalidRows, 0);
  assert.equal(parsed.tickers.length, 2); // BBCA and BREN

  const bbca = parsed.parsedData.find(p => p.ticker === 'BBCA');
  assert.ok(bbca);
  assert.equal(bbca.freeFloatKsei, 41.82);
  assert.equal(bbca.freeFloatIdx, 41.82);
  assert.equal(bbca.investors.length, 2);
  assert.equal(bbca.investors[0].totalHoldingShare, 67729950000);
  assert.equal(bbca.investors[0].percentage, 54.94);
  assert.equal(bbca.investors[0].isController, true);

  const bren = parsed.parsedData.find(p => p.ticker === 'BREN');
  assert.ok(bren);
  assert.equal(bren.freeFloatKsei, 11.73);
  assert.equal(bren.freeFloatIdx, 12.50);
});

test('V6-OWNERSHIP-4: Ownership JSON parser catches invalid percentages and duplicate tickers', () => {
  const invalidJson = JSON.stringify([
    {
      ticker: 'TEST1',
      freeFloat: 25.0,
      investors: [
        { name: 'Holder A', percentage: 150.0 } // Invalid > 100%
      ]
    },
    {
      ticker: 'TEST2',
      freeFloat: 30.0,
      investors: [
        { name: 'Holder B', percentage: 20.0 }
      ]
    },
    {
      ticker: 'TEST2', // Duplicate
      freeFloat: 30.0,
      investors: []
    }
  ]);

  const parsed = adminOwnership.parseAndValidateOwnership(invalidJson, 'json');
  assert.equal(parsed.validRows, 1); // Only TEST2 first instance is valid
  assert.equal(parsed.invalidRows, 2);
  assert.ok(parsed.errors.some(e => e.error.includes('persentase tidak valid')));
  assert.ok(parsed.errors.some(e => e.error.includes('duplikat')));
});

test('V6-OWNERSHIP-5: HSC list parser supports reconciliation fields and null status', () => {
  const hscCsv = `ticker, hsc_flag, hsc_source, hsc_as_of, free_float_idx, free_float_ksei, note
BREN, 1, "IDX Peng-001/2026", 2026-09-30, 11.73, 11.73, "Masuk daftar pantauan konsentrasi tinggi"
BBCA, 0, "IDX Evaluasi", 2026-09-30, 41.82, 41.82, "Normal"
BRPT, -, -, -, 22.33, 22.33, "Belum dievaluasi bursa"`;

  const parsed = adminOwnership.parseAndValidateHscList(hscCsv, 'csv');
  assert.equal(parsed.validRows, 3);
  assert.equal(parsed.invalidRows, 0);

  const bren = parsed.parsedData.find(d => d.ticker === 'BREN');
  assert.equal(bren.hsc_flag, true);
  assert.equal(bren.free_float_idx, 11.73);

  const bbca = parsed.parsedData.find(d => d.ticker === 'BBCA');
  assert.equal(bbca.hsc_flag, false);

  const brpt = parsed.parsedData.find(d => d.ticker === 'BRPT');
  assert.equal(brpt.hsc_flag, null, 'Unknown HSC must be null');
});

test('V6-OWNERSHIP-6: api/struktur-pasar returns accurate roster, reconciliation and neutral HSC', async () => {
  const result = await strukturPasarApi();
  assert.ok(result.success);
  assert.ok(Array.isArray(result.universe));
  assert.ok(result.universe.length >= 900);

  // Check BBCA
  const bbca = result.universe.find(u => u.ticker === 'BBCA');
  assert.ok(bbca);
  assert.equal(bbca.freeFloat, 41.82);
  assert.equal(bbca.free_float_ksei, 41.82);
  assert.ok(Array.isArray(bbca.investors));
  assert.ok(bbca.investors.length >= 3);
  assert.equal(bbca.investors[0].name, 'PT DWIMURIA INVESTAMA ANDALAN');
  assert.equal(bbca.investors[0].percentage, 54.94);
  assert.equal(bbca.investors[0].is_controller, true);

  // Check BRPT (Free float 22.33%)
  const brpt = result.universe.find(u => u.ticker === 'BRPT');
  assert.ok(brpt);
  assert.equal(brpt.freeFloat, 22.33);
  assert.equal(brpt.investors[0].name, 'PRAJOGO PANGESTU');
  assert.equal(brpt.investors[0].percentage, 71.37);

  // Check MSKY (has manual override)
  const msky = result.universe.find(u => u.ticker === 'MSKY');
  assert.ok(msky);
  assert.equal(msky.free_float_idx, 40.5);

  // Test single ticker query
  const singleReq = { query: { ticker: 'BBCA' } };
  const singleRes = {
    statusCode: 200,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { return payload; }
  };
  const singleData = await strukturPasarApi(singleReq, singleRes);
  assert.equal(singleData.ticker, 'BBCA');
  assert.ok(Array.isArray(singleData.roster));
  assert.ok(singleData.roster.length > 0);
  assert.ok(singleData.free_float_reconciliation);
  assert.equal(singleData.free_float_reconciliation.free_float_ksei, 41.82);
});

test('V6-OWNERSHIP-7: Low free float < 15% does not automatically set HSC=true', async () => {
  const result = await strukturPasarApi();
  const lowFfList = result.universe.filter(u => u.freeFloat != null && u.freeFloat < 15);
  assert.ok(lowFfList.length > 0, 'Must have low free float items');

  // Verify that not all low free float stocks are forced into hsc_flag = true
  const hasUnknownOrFalse = lowFfList.some(u => u.hsc_flag !== true);
  assert.ok(hasUnknownOrFalse, 'Stocks with low free float must not be blindly forced to HSC=true without evaluation');
});

test('V6-OWNERSHIP-9: single-dot "1.234" is a decimal (1.234), never a thousand separator inflated to 1234', () => {
  assert.equal(adminOwnership.parseIndonesianNumber('1.234'), 1.234);
  assert.equal(adminOwnership.parseIndonesianNumber('41.82'), 41.82);
  assert.equal(adminOwnership.parseIndonesianNumber('22.33'), 22.33);
  // Multiple dots remain thousand separators.
  assert.equal(adminOwnership.parseIndonesianNumber('1.234.567'), 1234567);
});

test('V6-OWNERSHIP-10: parseBooleanStrict never lets "false"/"0" become true', () => {
  assert.equal(adminOwnership.parseBooleanStrict('false'), false);
  assert.equal(adminOwnership.parseBooleanStrict('0'), false);
  assert.equal(adminOwnership.parseBooleanStrict('tidak'), false);
  assert.equal(adminOwnership.parseBooleanStrict(true), true);
  assert.equal(adminOwnership.parseBooleanStrict('true'), true);
  assert.equal(adminOwnership.parseBooleanStrict('1'), true);
  // Boolean('false') === true is exactly the bug this guards against.
  assert.equal(Boolean('false'), true);
  assert.equal(adminOwnership.parseBooleanStrict('false'), false);
});

test('V6-OWNERSHIP-11: HSC true without source/as_of does not fabricate official provenance', () => {
  const hscJson = JSON.stringify([
    { ticker: 'ZZZZ', hsc_flag: true } // no hsc_source / hsc_as_of
  ]);
  const parsed = adminOwnership.parseAndValidateHscList(hscJson, 'json');
  const row = parsed.parsedData.find((d) => d.ticker === 'ZZZZ');
  assert.equal(row.hsc_flag, true);
  assert.equal(row.hsc_source, null, 'must not stamp a fabricated official source');
  assert.equal(row.hsc_as_of, null, 'must not stamp a fabricated official date');
});

test('V6-OWNERSHIP-12: roster investor order is preserved (ticker A then B, no swap)', () => {
  const csv = `ticker, investor_name, percentage, as_of, source\n` +
    `AAAA, "Holder A1", "40%", 2026-09-30, KSEI\n` +
    `AAAA, "Holder A2", "30%", 2026-09-30, KSEI\n` +
    `BBBB, "Holder B1", "60%", 2026-09-30, KSEI`;
  const parsed = adminOwnership.parseAndValidateOwnership(csv, 'csv');
  const aaaa = parsed.parsedData.find((p) => p.ticker === 'AAAA');
  const bbbb = parsed.parsedData.find((p) => p.ticker === 'BBBB');
  assert.deepEqual(aaaa.investors.map((i) => i.investorName), ['Holder A1', 'Holder A2']);
  assert.deepEqual(bbbb.investors.map((i) => i.investorName), ['Holder B1']);
});

test('V6-OWNERSHIP-13: free float unknown stays null (never coerced to 0/false)', () => {
  const csv = `ticker, investor_name, percentage, free_float_ksei, free_float_idx\n` +
    `CCCC, "Holder C", "10%", -, -`;
  const parsed = adminOwnership.parseAndValidateOwnership(csv, 'csv');
  const cccc = parsed.parsedData.find((p) => p.ticker === 'CCCC');
  assert.equal(cccc.freeFloatKsei, null);
  assert.equal(cccc.freeFloatIdx, null);
});

test('V6-OWNERSHIP-8: Backup, Rollback, and Audit logging mechanism operates safely', () => {
  const backup = adminOwnership.createBackup('unit-test-actor');
  assert.ok(backup.backupId.startsWith('backup_'));
  assert.ok(fs.existsSync(backup.backupFile));

  const backups = adminOwnership.listBackups();
  assert.ok(backups.length > 0);
  assert.equal(backups[0].backupId, backup.backupId);

  // Test rollback to the fresh backup
  const rollbackResult = adminOwnership.rollbackToBackup(backup.backupId, 'unit-test-rollback');
  assert.ok(rollbackResult.success);
  assert.equal(rollbackResult.restoredBackupId, backup.backupId);
  assert.ok(rollbackResult.safetyBackupId);

  // Verify audit log exists
  const auditPath = path.join(__dirname, '..', 'data', 'security', 'ownership-audit.log.jsonl');
  assert.ok(fs.existsSync(auditPath));
  const logContent = fs.readFileSync(auditPath, 'utf8');
  assert.ok(logContent.includes('ROLLBACK_OWNERSHIP_DATASET'));
});
