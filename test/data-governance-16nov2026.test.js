'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  LAST_PROVEN_TRADING_DATE,
  CURRENT_SESSION_DATE,
  ZERO_FABRICATION_ENFORCED,
  evaluateDataGovernance
} = require('../lib/data-governance-policy');
const { buildChartResponse } = require('../api/chart');

test('Data Governance: Kebijakan eksplisit tanggal 16 Nov 2026 dan no-mock invariant', () => {
  // 1. Kebijakan tanggal bursa terakhir yang terbukti lengkap adalah 13 November 2026
  assert.equal(LAST_PROVEN_TRADING_DATE, '2026-11-13');
  assert.equal(CURRENT_SESSION_DATE, '2026-11-16');
  assert.equal(ZERO_FABRICATION_ENFORCED, true);

  // 2. Evaluasi kesegaran: data 2026-11-13 berstatus not_due (karena batch malam 16 Nov belum ditarik)
  const eval13 = evaluateDataGovernance('2026-11-13');
  assert.equal(eval13.status, 'not_due');
  assert.equal(eval13.as_of, '2026-11-13');
  assert.equal(eval13.is_synthetic, false);

  // 3. Data sebelum 13 Nov 2026 berstatus stale
  const evalOld = evaluateDataGovernance('2026-11-06');
  assert.equal(evalOld.status, 'stale');
  assert.equal(evalOld.as_of, '2026-11-06');
  assert.equal(evalOld.is_synthetic, false);

  // 4. Data null berstatus unavailable
  const evalNull = evaluateDataGovernance(null);
  assert.equal(evalNull.status, 'unavailable');
  assert.equal(evalNull.as_of, null);
  assert.equal(evalNull.is_synthetic, false);
});

test('Data Governance: api/chart buildChartResponse tidak pernah memfabrikasi candle 16 Nov 2026', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-chart-test-'));
  const ohlcvDir = path.join(tmp, 'data', 'ohlcv');
  fs.mkdirSync(ohlcvDir, { recursive: true });

  const fixtureData = {
    ticker: 'BBCA',
    candles: [
      { date: '2026-11-11', open: 10100, high: 10250, low: 10050, close: 10200, volume: 5000000 },
      { date: '2026-11-12', open: 10200, high: 10300, low: 10150, close: 10250, volume: 6000000 },
      { date: '2026-11-13', open: 10250, high: 10350, low: 10200, close: 10300, volume: 5500000 }
    ]
  };

  fs.writeFileSync(path.join(ohlcvDir, 'BBCA.json'), JSON.stringify(fixtureData));

  try {
    // Evaluasi pada 16 Nov 2026 pukul 16:30 WIB (pasca penutupan pasar 15:50 WIB)
    const nowWib = new Date('2026-11-16T16:30:00+07:00');
    const res = buildChartResponse('BBCA', nowWib, { root: tmp });

    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.success, true);
    assert.equal(res.payload.as_of, '2026-11-13', 'as_of harus jujur 2026-11-13');
    assert.equal(res.payload.actual_data_date, '2026-11-13');
    assert.equal(res.payload.total_candles, 3);

    // Pastikan TIDAK ADA bar palsu bertanggal 2026-11-16 yang dibuat
    const hasNov16 = res.payload.candles.some(c => c.time === '2026-11-16');
    assert.equal(hasNov16, false, 'Dilarang keras menyisipkan bar sintetis 2026-11-16');

    // Pastikan data_governance metadata hadir
    assert.ok(res.payload.data_governance, 'data_governance metadata must be present');
    assert.equal(res.payload.data_governance.last_proven_date, '2026-11-13');
    assert.equal(res.payload.data_governance.is_synthetic, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
