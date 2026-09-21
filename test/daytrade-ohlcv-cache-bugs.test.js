const assert = require('assert');
const {
  normalizeCandles,
  createCacheProvider
} = require('../lib/daytrade-ohlcv-cache');

async function run() {
  console.log('Running daytrade-ohlcv-cache bug reproduction tests...');

  // BUG-DOC-01: safeTicker transforms BBCA.JK to BBCAJK and breaks cache and broker-summary sync
  {
    const provider = createCacheProvider({ syncWithBrokerSummary: true });
    // Simulate fetchWithCache on BBCA.JK ticker
    let fetchedSymbol = null;
    const customProvider = createCacheProvider({
      fetchFn: (ticker) => {
        fetchedSymbol = ticker;
        return Promise.resolve([]);
      }
    });
    await customProvider.fetchWithCache('BBCA.JK');
    assert.strictEqual(
      fetchedSymbol,
      'BBCA',
      `Bug 1: fetchWithCache must clean 'BBCA.JK' to 'BBCA', got '${fetchedSymbol}'`
    );
  }

  // BUG-DOC-02: normalizeCandle rejects all candles formatted with date strings (time: 'YYYY-MM-DD')
  {
    const dateFormattedCandles = [
      { time: '2026-03-30', open: 1000, high: 1050, low: 980, close: 1020, volume: 50000 }
    ];
    const normalized = normalizeCandles(dateFormattedCandles);
    assert.strictEqual(
      normalized.length,
      1,
      `Bug 2: normalizeCandles must accept candles with string date time, but returned 0 candles (got ${normalized.length})`
    );
  }

  // BUG-DOC-03: normalizeCandle formats date with UTC slice, causing Jakarta day offset
  {
    // 2026-03-29 18:00:00 UTC = 2026-03-30 01:00:00 WIB (Monday morning)
    const timestampSeconds = 1774807200;
    const candles = [
      { time: timestampSeconds, open: 1000, high: 1050, low: 980, close: 1020, volume: 50000 }
    ];
    const normalized = normalizeCandles(candles);
    assert.strictEqual(
      normalized[0].date,
      '2026-03-30',
      `Bug 3: normalizeCandle date must be formatted in Asia/Jakarta timezone ('2026-03-30'), got UTC '${normalized[0].date}'`
    );
  }

  console.log('All daytrade-ohlcv-cache tests passed (bugs fixed).');
}

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
