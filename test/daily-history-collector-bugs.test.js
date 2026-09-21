const assert = require('assert');
const {
  candlesToHistoryRows,
  computeWeek52FromCandles,
  reconcileMissingCloseFromMeta,
  isPartialSession
} = require('../lib/daily-history-collector');

async function run() {
  console.log('Running daily-history-collector bug reproduction tests...');

  // BUG-DHC-01: safeTicker mangles standard .JK tickers into corrupt 6-letter ticker 'BBCAJK'
  {
    const candles = [
      { date: '2026-03-30', open: 1000, high: 1050, low: 990, close: 1020, volume: 50000 }
    ];
    const rows = candlesToHistoryRows('BBCA.JK', candles, { now: new Date('2026-03-30T18:00:00.000Z') });
    assert.strictEqual(
      rows[0].ticker,
      'BBCA',
      `Bug 1: candlesToHistoryRows must strip .JK suffix, got corrupt ticker '${rows[0].ticker}'`
    );
  }

  // BUG-DHC-02: candlesToHistoryRows crashes with TypeError when options.now is an ISO string
  {
    const candles = [
      { date: '2026-03-30', open: 1000, high: 1050, low: 990, close: 1020, volume: 50000 }
    ];
    try {
      const rows = candlesToHistoryRows('BBCA', candles, { now: '2026-03-30T10:00:00.000Z' });
      assert.strictEqual(Array.isArray(rows), true);
    } catch (err) {
      assert.fail(`Bug 2: candlesToHistoryRows crashed on string options.now: ${err.message}`);
    }
  }

  // BUG-DHC-03: reconcileMissingCloseFromMeta rejects valid close price on 1-share volume drift
  {
    const reconciled = reconcileMissingCloseFromMeta({
      isLastRow: true,
      rowDate: '2026-03-30',
      metaDate: '2026-03-30',
      open: 1000,
      high: 1050,
      low: 990,
      volume: 100000,
      metaPrice: 1020,
      metaVolume: 100005 // 5 shares drift due to late exchange tick
    });
    assert.strictEqual(
      reconciled,
      1020,
      `Bug 3: reconcileMissingCloseFromMeta should accept close within [low, high] with negligible volume drift, got ${reconciled}`
    );
  }

  // BUG-DHC-04: computeWeek52FromCandles accepts zero/negative prices as 52-week low
  {
    const candles = [
      { date: '2026-03-27', high: 1500, low: 1200, close: 1400 },
      { date: '2026-03-30', high: 1550, low: 0, close: 1450 } // Bad zero-price tick
    ];
    const w52 = computeWeek52FromCandles(candles);
    assert.strictEqual(
      w52.week52_low,
      1200,
      `Bug 4: computeWeek52FromCandles must reject 0 as 52-week low, got ${w52.week52_low}`
    );
  }

  console.log('All daily-history-collector tests passed (bugs fixed).');
}

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
