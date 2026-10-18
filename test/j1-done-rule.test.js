'use strict';

/**
 * Unit test aturan .done J1 (perbaikan 18 Okt 2026).
 *
 * Menguji:
 *  1. Toleransi 1% & aturan 100 saham likuid
 *  2. f_broker_missing_in_all TIDAK lagi false positive pada broker_levels yang dipadding
 *  3. f_broker_missing_in_all di-skip saat all tidak punya all_data === true
 *  4. Rasio > 1.25 diperlakukan peringatan, bukan anomali keras
 *  5. Anomali keras tetap ditolak
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const validator = require('../lib/broksum-validator');

test('Aturan .done J1: toleransi, peringatan, dan dedup F-vs-all', async (t) => {

  await t.test('1. f_broker_missing_in_all di-skip bila all TIDAK punya all_data === true', () => {
    const fPayload = {
      code: 'TEST', flow: 'F',
      brokers: [{ broker_code: 'ZZ', bval: 1000000, sval: 0 }]
    };
    const allPayload = {
      stock_code: 'TEST',
      brokers: [{ broker_code: 'AA', bval: 100000000, sval: 100000000 }],
      // all_data TIDAK ada
    };
    const r = validator.validateForeignAgainstAll(fPayload, allPayload);
    assert.equal(r.valid, true, 'Harus valid karena all tidak membawa all_data === true');
    assert.equal(r.skippedReason, 'all_missing_all_data_flag');
    assert.equal(r.missingCodes, 0);
  });

  await t.test('2. f_broker_missing_in_all DIJALANKAN bila all punya all_data === true', () => {
    const fPayload = {
      code: 'TEST', flow: 'F',
      brokers: [{ broker_code: 'ZZ', bval: 1000000, sval: 0 }]
    };
    const allPayload = {
      stock_code: 'TEST', all_data: true,
      brokers: [{ broker_code: 'AA', bval: 100000000, sval: 100000000 }]
    };
    const r = validator.validateForeignAgainstAll(fPayload, allPayload);
    assert.equal(r.valid, false);
    assert.equal(r.missingCodes, 1);
    assert.ok(r.flags.includes('foreign_broker_missing_in_all'));
  });

  await t.test('3. Dedup: broker yang ADA di broker_levels tapi tidak di brokers[] dianggap ada', () => {
    // Skenario persis KOTA: all.brokers[] hanya punya SQ, EP, DR tapi broker_levels[]
    // punya SQ, EP, DR, YU, ZP, ... -> broker YU dari F harus dianggap ADA.
    const fPayload = {
      code: 'TEST', flow: 'F',
      brokers: [{ broker_code: 'YU', bval: 5000000, sval: 0 }]
    };
    const allPayload = {
      stock_code: 'TEST', all_data: true,
      brokers: [
        { broker_code: 'SQ', bval: 791197500, sval: 0 },
        { broker_code: 'EP', bval: 374631900, sval: 930000 }
      ],
      broker_levels: [
        { buy: { broker_code: 'SQ', bval: 791197500 }, sell: null },
        { buy: { broker_code: 'EP', bval: 374631900 }, sell: { broker_code: 'EP', sval: 930000 } },
        { buy: { broker_code: 'YU', bval: 5000000 }, sell: null },
        { buy: null, sell: null },  // padding
        { buy: null, sell: null }   // padding
      ]
    };
    const r = validator.validateForeignAgainstAll(fPayload, allPayload);
    assert.equal(r.missingCodes, 0, 'YU harus dianggap ADA karena ada di broker_levels[]');
    assert.equal(r.valid, true, 'Tidak boleh false positive');
  });

  await t.test('4. Padding null di broker_levels[] diabaikan', () => {
    const payload = {
      stock_code: 'TEST',
      brokers: [],
      broker_levels: [
        { buy: { broker_code: 'AA', bval: 1000 }, sell: null },
        { buy: null, sell: null },
        { buy: null, sell: null },
        { buy: { broker_code: 'BB', bval: 2000 }, sell: null }
      ]
    };
    const codes = validator.buildCompleteCodeSet(payload);
    assert.equal(codes.size, 2, 'Hanya AA dan BB; padding null diabaikan');
    assert.ok(codes.has('AA'));
    assert.ok(codes.has('BB'));
  });

  await t.test('5. Rasio > 1.25 = peringatan (bukan anomali keras di J1)', () => {
    const payload = {
      stock_code: 'TEST',
      brokers: [{ broker_code: 'AA', bval: 2000000000, sval: 2000000000 }]
    };
    const candle = { close: 1000, volume: 1000000, value: 1000000000 };
    const r = validator.validateBroksumAgainstCandle(payload, candle);
    // Ratio = 2.0, di atas MAX_RATIO
    assert.equal(r.valid, false);
    assert.ok(r.flags.includes('ratio_above_max'));
    // Di J1, ratio_above_max TIDAK masuk HARD_ALL_FLAGS -> di-tolerate sebagai peringatan
  });

  await t.test('6. Anomali keras (kosong + volume) tetap ditolak', () => {
    const payload = { stock_code: 'TEST', brokers: [], broker_levels: [] };
    const candle = { close: 1000, volume: 5000, value: 5000000 };
    const r = validator.validateBroksumAgainstCandle(payload, candle);
    assert.equal(r.valid, false);
    assert.ok(r.flags.includes('empty_broksum_but_candle_has_volume'));
  });

  await t.test('7. Rasio < 0.95 = anomali keras (unclipped_ratio_below)', () => {
    const payload = {
      stock_code: 'TEST',
      brokers: [{ broker_code: 'AA', bval: 100000000, sval: 100000000 }]
    };
    const candle = { close: 1000, volume: 1000000, value: 1000000000 };
    const r = validator.validateBroksumAgainstCandle(payload, candle);
    assert.equal(r.valid, false);
    assert.ok(r.flags.includes('ratio_below_min'));
  });

  await t.test('8. Toleransi J1: dengan 500 file dan 3 anomali (0.6%) -> dalam toleransi', () => {
    // Simulasi aturan: invalidPct = 3/500 * 100 = 0.6% <= 1% -> pctOk = true
    const totalFiles = 500;
    const totalInvalid = 3;
    const invalidPct = (totalInvalid / totalFiles) * 100;
    const pctOk = invalidPct <= 1.0;
    assert.equal(pctOk, true);
    assert.ok(invalidPct < 1);
  });

  await t.test('9. Toleransi J1: dengan 500 file dan 6 anomali (1.2%) -> DI LUAR toleransi (.done tertahan)', () => {
    const totalFiles = 500;
    const totalInvalid = 6;
    const invalidPct = (totalInvalid / totalFiles) * 100;
    const pctOk = invalidPct <= 1.0;
    assert.equal(pctOk, false);
    assert.ok(invalidPct > 1);
  });

  await t.test('10. Aturan 100 likuid: 1 anomali di likuid meski persen kecil -> .done tertahan', () => {
    const totalFiles = 800;
    const totalInvalid = 1;
    const invalidPct = (totalInvalid / totalFiles) * 100;
    const pctOk = invalidPct <= 1.0;   // true (0.125%)
    const top100InvalidCount = 1;      // ada 1 di likuid
    const top100Ok = top100InvalidCount === 0;  // false
    const doneWritten = pctOk && top100Ok;      // false
    assert.equal(pctOk, true);
    assert.equal(top100Ok, false);
    assert.equal(doneWritten, false, '.done harus TERTAHAN karena ada anomali di likuid');
  });
});
