'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const validator = require('../lib/broksum-validator');

test('Validasi arsip broksum: kewajaran terhadap candle & F vs all', async (t) => {
  await t.test('1. File kosong padahal candle bervolume -> tidak wajar', () => {
    const payload = { stock_code: 'TEST', brokers: [], broker_levels: [] };
    const candle = { close: 1000, volume: 5000, value: null };
    const r = validator.validateBroksumAgainstCandle(payload, candle);
    assert.equal(r.valid, false);
    assert.ok(r.flags.includes('empty_broksum_but_candle_has_volume'));
  });

  await t.test('2. Rasio di bawah 0.95 -> tidak wajar (ratio_below_min)', () => {
    // totalBuy 100 juta vs turnover 1000 juta = 0.1 -> di bawah minimum
    const payload = {
      stock_code: 'TEST',
      brokers: [{ broker_code: 'AA', bval: 100000000, sval: 100000000 }]
    };
    const candle = { close: 1000, volume: 1000000, value: 1000000000 };
    const r = validator.validateBroksumAgainstCandle(payload, candle);
    assert.equal(r.valid, false);
    assert.ok(r.flags.includes('ratio_below_min'));
  });

  await t.test('3. Rasio > 1.25 -> peringatan (ratio_above_max, mungkin hari nego)', () => {
    const payload = {
      stock_code: 'TEST',
      brokers: [{ broker_code: 'AA', bval: 2000000000, sval: 2000000000 }]
    };
    const candle = { close: 1000, volume: 1000000, value: 1000000000 };
    const r = validator.validateBroksumAgainstCandle(payload, candle);
    assert.equal(r.valid, false);
    assert.ok(r.flags.includes('ratio_above_max'));
  });

  await t.test('4. Beli != jual lebih dari 0.5% -> tidak wajar', () => {
    const payload = {
      stock_code: 'TEST',
      brokers: [{ broker_code: 'AA', bval: 1000000000, sval: 900000000 }]
    };
    const candle = { close: 1000, volume: 1000000, value: 1000000000 };
    const r = validator.validateBroksumAgainstCandle(payload, candle);
    assert.equal(r.valid, false);
    assert.ok(r.flags.includes('buy_sell_imbalance'));
  });

  await t.test('5. File wajar (ratio ≈ 1, beli = jual) -> valid', () => {
    const payload = {
      stock_code: 'TEST',
      brokers: [
        { broker_code: 'AA', bval: 600000000, sval: 500000000 },
        { broker_code: 'BB', bval: 400000000, sval: 500000000 }
      ]
    };
    const candle = { close: 1000, volume: 1000000, value: 1000000000 };
    const r = validator.validateBroksumAgainstCandle(payload, candle);
    assert.equal(r.valid, true);
  });

  await t.test('6. Payload dengan brokers[] DAN broker_levels[] harus DIGABUNG (bukan hanya brokers[])', () => {
    // brokers[] membawa subset (AA saja), broker_levels[] membawa superset (AA, BB, CC)
    const payload = {
      stock_code: 'TEST',
      brokers: [{ broker_code: 'AA', bval: 400000000, sval: 400000000 }],
      broker_levels: [
        { buy: { broker_code: 'AA', bval: 400000000 }, sell: { broker_code: 'AA', sval: 400000000 } },
        { buy: { broker_code: 'BB', bval: 300000000 }, sell: { broker_code: 'BB', sval: 300000000 } },
        { buy: { broker_code: 'CC', bval: 300000000 }, sell: { broker_code: 'CC', sval: 300000000 } },
        { buy: null, sell: null }
      ]
    };
    const candle = { close: 1000, volume: 1000000, value: 1000000000 };
    const r = validator.validateBroksumAgainstCandle(payload, candle);

    // Total seharusnya 1 miliar (AA + BB + CC), bukan hanya 400 juta
    assert.equal(r.totals.totalBuy, 1000000000);
    assert.equal(r.totals.brokerCount, 3);
    assert.equal(r.ratio, 1);
    assert.equal(r.valid, true);
  });

  await t.test('7. derived no-trade sah bila candle volume 0', () => {
    const payload = { stock_code: 'TEST', flow: 'all', brokers: [], broker_levels: [], derived: 'no-trade' };
    const candle = { close: 100, volume: 0, value: 0 };
    const r = validator.validateBroksumAgainstCandle(payload, candle);
    assert.equal(r.valid, true);
    assert.ok(r.flags.includes('derived_no_trade'));
  });

  await t.test('8. derived no-trade TIDAK sah bila candle punya volume', () => {
    const payload = { stock_code: 'TEST', flow: 'F', brokers: [], derived: 'no-trade' };
    const candle = { close: 100, volume: 5000, value: 500000 };
    const r = validator.validateBroksumAgainstCandle(payload, candle);
    assert.equal(r.valid, false);
    assert.ok(r.flags.includes('no_trade_but_candle_has_volume'));
  });

  await t.test('9. F melebihi all -> tidak wajar (f_buy_exceeds_all)', () => {
    const fPayload = { code: 'TEST', flow: 'F', brokers: [{ broker_code: 'AA', bval: 600000000, sval: 0 }] };
    const allPayload = { stock_code: 'TEST', brokers: [{ broker_code: 'AA', bval: 100000000, sval: 100000000 }] };
    const r = validator.validateForeignAgainstAll(fPayload, allPayload);
    assert.equal(r.valid, false);
    assert.ok(r.flags.includes('foreign_buy_exceeds_all'));
  });

  await t.test('10. F dengan broker tidak ada di all -> tidak wajar', () => {
    const fPayload = { code: 'TEST', flow: 'F', brokers: [{ broker_code: 'ZZ', bval: 1000000, sval: 0 }] };
    const allPayload = { stock_code: 'TEST', brokers: [{ broker_code: 'AA', bval: 100000000, sval: 100000000 }] };
    const r = validator.validateForeignAgainstAll(fPayload, allPayload);
    assert.equal(r.valid, false);
    assert.ok(r.flags.includes('foreign_broker_missing_in_all'));
    assert.equal(r.missingCodes, 1);
  });
});
