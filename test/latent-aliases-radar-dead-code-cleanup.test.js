const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sectorHot = require('../api/sector-hot');
const idxTick = require('../lib/idx-tick-normalization');
const tradePlanIntegration = require('../lib/trade-plan-v2-integration');
const tradePlanSourceAdapters = require('../lib/trade-plan-v2-source-adapters');

test('BUG-024: getDayTradeRadarStatus token boundary regex prevents false ARA/ARB matching', () => {
  const getDayTradeRadarStatus = sectorHot.__test.getDayTradeRadarStatus;
  assert.equal(typeof getDayTradeRadarStatus, 'function', 'getDayTradeRadarStatus must be exposed in __test');

  // Words containing substring 'ARA' like 'SYARAT', 'SEMENTARA' must NOT trigger ARA_ARB_MONITOR
  const syaratCandidate = {
    ticker: 'TEST',
    status: 'RADAR',
    status_reason: 'Syarat konfirmasi volume belum terpenuhi'
  };
  const syaratStatus = getDayTradeRadarStatus(syaratCandidate);
  assert.notEqual(syaratStatus, 'ARA_ARB_MONITOR', 'Syarat must not trigger ARA_ARB_MONITOR');
  assert.equal(syaratStatus, 'RADAR', 'Should resolve to RADAR');

  const sementaraCandidate = {
    ticker: 'TEST',
    status: 'WATCHLIST',
    status_reason: 'Sementara tunggu konfirmasi pasar'
  };
  const sementaraStatus = getDayTradeRadarStatus(sementaraCandidate);
  assert.notEqual(sementaraStatus, 'ARA_ARB_MONITOR', 'Sementara must not trigger ARA_ARB_MONITOR');

  // Genuine ARA or ARB tokens MUST trigger ARA_ARB_MONITOR
  const realAra = {
    ticker: 'TEST',
    status: 'ARA_ARB',
    status_reason: 'Kandidat ARA hari ini'
  };
  assert.equal(getDayTradeRadarStatus(realAra), 'ARA_ARB_MONITOR');

  const realArb = {
    ticker: 'TEST',
    status: 'MONITOR',
    status_reason: 'Waspada ARB lanjutan'
  };
  assert.equal(getDayTradeRadarStatus(realArb), 'ARA_ARB_MONITOR');

  const compoundAraArb = {
    ticker: 'TEST',
    status: 'MONITOR',
    status_reason: 'Area volatilitas ARA_ARB ekstrem'
  };
  assert.equal(getDayTradeRadarStatus(compoundAraArb), 'ARA_ARB_MONITOR');
});

test('BUG-021: Entry aliases fallback preserves entry1 >= entry2 across normalization paths', () => {
  // 1. buildDashboardPickRow
  const buildDashboardPickRow = sectorHot.__test.buildDashboardPickRow;
  const rawData = {
    ticker: 'BBCA',
    category: 'DayTrade',
    entry_low: 9500,
    entry_high: 9700,
    sl: 9400,
    tp1: 10000
  };
  // Calling with empty row so it falls back to raw
  const pickRow = buildDashboardPickRow({ raw_payload: rawData }, 1, { last: 9600 });
  assert.equal(pickRow.entry1, 9700, 'entry1 must be upper entry (9700)');
  assert.equal(pickRow.entry2, 9500, 'entry2 must be lower entry (9500)');

  // 2. buildWebTop5HistoryRow
  const buildWebTop5HistoryRow = sectorHot.__test.buildWebTop5HistoryRow;
  const historyRow = buildWebTop5HistoryRow({ raw_payload: rawData }, 1, { last: 9600 });
  assert.equal(historyRow.entry1, 9700, 'history entry1 must be upper entry (9700)');
  assert.equal(historyRow.entry2, 9500, 'history entry2 must be lower entry (9500)');

  // 3. deriveCandlePotentialRange
  const candleRange = idxTick.deriveCandlePotentialRange({
    ticker: 'BBCA',
    previous_close: 9500,
    current_price: 9600,
    entry1: 9700,
    entry2: 9500
  });
  assert.ok(candleRange, 'Candle potential range produced');
  assert.equal(typeof candleRange.ara_room_pct, 'number');
  assert.equal(typeof candleRange.ara_price, 'number');

  // 4. buildLegacyTradePlan in trade-plan-v2-integration
  const legacyPlan = tradePlanIntegration.buildLegacyTradePlan({
    ticker: 'BBCA',
    entry1: 9700,
    entry2: 9500,
    sl: 9400,
    tp1: 10000
  });
  assert.equal(legacyPlan.entry_high, 9700, 'legacyPlan entry_high must be 9700');
  assert.equal(legacyPlan.entry_low, 9500, 'legacyPlan entry_low must be 9500');

  // 5. tradePlanSourceAdapters (adaptDayTrade, adaptSwingKonglo, adaptSwingNonKonglo)
  const candidatePayload = {
    ticker: 'BBCA',
    entry1: 9700,
    entry2: 9500,
    sl: 9400,
    tp1: 10000
  };
  const adaptedDt = tradePlanSourceAdapters.adaptDayTrade({ candles: [], candidate: candidatePayload });
  assert.equal(adaptedDt.input.entry_high, 9700);
  assert.equal(adaptedDt.input.entry_low, 9500);

  const adaptedSk = tradePlanSourceAdapters.adaptSwingKonglo({ candles: [], candidate: candidatePayload });
  assert.equal(adaptedSk.input.entry_high, 9700);
  assert.equal(adaptedSk.input.entry_low, 9500);

  const adaptedSnk = tradePlanSourceAdapters.adaptSwingNonKonglo({ candles: [], candidate: candidatePayload });
  assert.equal(adaptedSnk.input.entry_high, 9700);
  assert.equal(adaptedSnk.input.entry_low, 9500);
});

test('BUG-007: public/index.html dead SSE streaming code removed', () => {
  const htmlPath = path.join(__dirname, '../public/index.html');
  const htmlContent = fs.readFileSync(htmlPath, 'utf8');

  assert.equal(htmlContent.includes('text/event-stream'), false, 'text/event-stream must not appear in index.html');
  assert.equal(htmlContent.includes('isStreamResponse'), false, 'isStreamResponse must not appear in index.html');
  assert.equal(htmlContent.includes('aiStreamBody'), false, 'aiStreamBody must not appear in index.html');
});
