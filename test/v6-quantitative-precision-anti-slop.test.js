'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { InstitutionalMath, QuantitativePrecisionEngine } = require('../lib/quantitative-precision-engine');
const chatApi = require('../api/ai/chat');

test('Rule 2 - Anti-Slop: Blacklist strings are sanitized to [DATA_REQUIRED: Gunakan metrik kuantitatif]', () => {
  const dirtyOutputs = [
    'Saham ini sangat menjanjikan dengan prospek cerah di masa depan',
    'Potensi cuan luar biasa, segera serok sebelum terbang to the moon',
    'Kondisi pasar saat ini agak kurang bersahabat dan galau',
    'Bandar terlihat sedang memainkan harga secara misterius',
    'Tampaknya candle membentuk pola bullish yang cantik'
  ];

  for (const dirty of dirtyOutputs) {
    const clean = QuantitativePrecisionEngine.sanitizeLLMResponse(dirty);
    assert.ok(clean.includes('[DATA_REQUIRED: Gunakan metrik kuantitatif]'), `Failed on: ${dirty} -> ${clean}`);
    assert.equal(/sangat menjanjikan/i.test(clean), false);
    assert.equal(/potensi cuan/i.test(clean), false);
    assert.equal(/to the moon/i.test(clean), false);
    assert.equal(/pasar galau/i.test(clean), false);
    assert.equal(/bandar misterius/i.test(clean), false);
    assert.equal(/candle cantik/i.test(clean), false);
  }
});

test('Rule 2 - Anti-Slop: Data deficient token format [DATA_DEFICIENT: Parameter <name> tidak tersedia]', () => {
  const token = QuantitativePrecisionEngine.dataDeficientToken('foreign_flow');
  assert.equal(token, '[DATA_DEFICIENT: Parameter foreign_flow tidak tersedia]');
});

test('Rule 2 - IEEE-754 Safe Decimal Arithmetic: Eliminates floating point artifacts', () => {
  // Classic IEEE-754: 0.1 + 0.2 === 0.30000000000000004
  const sum = 0.1 + 0.2;
  assert.notEqual(sum, 0.3); // standard JS exhibits artifact
  const safeSum = InstitutionalMath.safeDecimal(sum, 1);
  assert.equal(safeSum, 0.3); // SafeDecimal eliminates artifact

  // Percentage formatting
  assert.equal(InstitutionalMath.formatPercent(1.4), '+1.40%');
  assert.equal(InstitutionalMath.formatPercent(-0.842), '-0.84%');
  assert.equal(InstitutionalMath.formatPercent(0), '0.00%');
  assert.equal(InstitutionalMath.formatPercent(null), '0.00%');

  // IDR formatting
  assert.equal(InstitutionalMath.formatIDR(14200000000), 'Rp 14.20 B');
  assert.equal(InstitutionalMath.formatIDR(14200000), 'Rp 14.20 M');
  assert.equal(InstitutionalMath.formatIDR(8100000000000), 'Rp 8.10 T');
  assert.equal(InstitutionalMath.formatIDR(2500000000), 'Rp 2.50 B');
  assert.equal(InstitutionalMath.formatIDR(5425), 'Rp 5.425');

  // Lots conversion
  assert.equal(InstitutionalMath.sharesToLots(1500), 15);
  assert.equal(InstitutionalMath.sharesToLots(1580), 15);
  assert.equal(InstitutionalMath.lotsToShares(15), 1500);
});

test('Rule 2 - VWAP and Orderbook Imbalance calculations', () => {
  const trades = [
    { price: 1000, volume: 100 },
    { price: 1050, volume: 200 },
    { price: 950, volume: 100 }
  ];
  // Total Value = 100,000 + 210,000 + 95,000 = 405,000
  // Total Volume = 400
  // VWAP = 405,000 / 400 = 1012.50
  const vwap = InstitutionalMath.calculateVWAP(trades);
  assert.equal(vwap, 1012.5);

  // Orderbook Imbalance
  // Bid = 600 lots, Offer = 400 lots -> (600 - 400) / 1000 = +0.2000
  const imbalance = InstitutionalMath.calculateOrderbookImbalance(600, 400);
  assert.equal(imbalance, 0.2);

  // Equal bids and offers
  assert.equal(InstitutionalMath.calculateOrderbookImbalance(500, 500), 0);
});

test('Rule 2 - Bandarmologi CR3, CR5, and HHI quantitative metrics', () => {
  const brokers = [
    { broker: 'YU', netValue: 35000000 },
    { broker: 'CC', netValue: 25000000 },
    { broker: 'AK', netValue: 15000000 },
    { broker: 'ZP', netValue: 10000000 },
    { broker: 'PD', netValue: 10000000 },
    { broker: 'NI', netValue: 5000000 }
  ];
  // Total = 100,000,000
  // Top 3 = 35 + 25 + 15 = 75M -> 75.00%
  // Top 5 = 35 + 25 + 15 + 10 + 10 = 95M -> 95.00%
  const cr3 = InstitutionalMath.calculateCR3(brokers);
  const cr5 = InstitutionalMath.calculateCR5(brokers);
  assert.equal(cr3, 75.0);
  assert.equal(cr5, 95.0);

  // HHI: shares = [0.35, 0.25, 0.15, 0.10, 0.10, 0.05]
  // HHI = 35^2 + 25^2 + 15^2 + 10^2 + 10^2 + 5^2
  //     = 1225 + 625 + 225 + 100 + 100 + 25 = 2300
  const hhi = InstitutionalMath.calculateHerfindahlHirschmanIndex([0.35, 0.25, 0.15, 0.10, 0.10, 0.05]);
  assert.equal(hhi, 2300);
});

test('Rule 2 - Screener quantitative output validator', () => {
  // Valid row
  const valid = QuantitativePrecisionEngine.validateScreenerOutput({
    ticker: 'BBRI',
    lastPrice: 5425,
    volume: 12500000,
    changePercent: 1.40
  });
  assert.equal(valid.isValid, true);
  assert.equal(valid.errors.length, 0);

  // Invalid row: invalid price, negative volume, NaN percent
  const invalid = QuantitativePrecisionEngine.validateScreenerOutput({
    ticker: 'BAD',
    lastPrice: -10,
    volume: -500,
    changePercent: NaN
  });
  assert.equal(invalid.isValid, false);
  assert.ok(invalid.errors.includes('INVALID_NUMERIC_PRICE'));
  assert.ok(invalid.errors.includes('INVALID_NUMERIC_VOLUME'));
  assert.ok(invalid.errors.includes('NAN_CHANGE_PERCENT'));
});

test('Rule 2 - AI chat endpoint integrates QuantitativePrecisionEngine & anti-slop sanitizer', async () => {
  // Mock res object
  let body = '';
  let status = 0;
  const res = {
    statusCode: 0,
    setHeader: () => {},
    end: (str) => { body = str; status = res.statusCode; }
  };
  const req = {
    method: 'POST',
    body: {
      ticker: 'BBCA',
      message: 'Saham ini sangat menjanjikan dengan potensi cuan to the moon'
    }
  };

  await chatApi(req, res);
  assert.equal(status, 200);
  const data = JSON.parse(body);
  assert.equal(data.success, true);
  assert.ok(data.reply);
  // Ensure the reply is clean of slop
  assert.equal(/sangat menjanjikan/i.test(data.reply), false);
  assert.equal(/to the moon/i.test(data.reply), false);
  assert.equal(/potensi cuan/i.test(data.reply), false);
});
