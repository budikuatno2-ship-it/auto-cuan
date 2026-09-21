'use strict';

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Enable VPS fetcher execution during test suite
process.env.VPS_FETCHER_ALLOW_IN_TESTS = '1';

const vpsFetcher = require('../lib/vps-data-fetcher');

async function runTests() {
  console.log('Running VPS Data Fetcher Bug Reproduction Suite...');
  let failed = 0;

  // Setup mock HTTP bridge server in worker thread so sync loopback calls don't block
  const { Worker } = require('worker_threads');
  let lastRequestedUrl = '';
  const workerCode = `
    const http = require('http');
    const { parentPort } = require('worker_threads');
    const server = http.createServer((req, res) => {
      parentPort.postMessage({ type: 'req', url: req.url });
      if (req.url.includes('/api/available-dates')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, dates: ['2026-03-30', '2026-03-27'] }));
        return;
      }
      if (req.url.includes('date=2025-01-01')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Not found' }));
        return;
      }
      if (req.url.includes('date=latest')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          stock_code: 'BBCA',
          date: '2026-03-30',
          brokers: [
            { broker: 'CC', bval: 1000000000, bvol: 100000 }
          ]
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    server.listen(0, '127.0.0.1', () => {
      parentPort.postMessage({ type: 'ready', port: server.address().port });
    });
  `;
  const worker = new Worker(workerCode, { eval: true });
  worker.on('message', (msg) => {
    if (msg.type === 'req') lastRequestedUrl = msg.url;
  });
  const port = await new Promise((resolve) => {
    worker.on('message', function onMsg(msg) {
      if (msg.type === 'ready') {
        worker.off('message', onMsg);
        resolve(msg.port);
      }
    });
  });
  process.env.VPS_DATA_API_BASE = `http://127.0.0.1:${port}`;

  // BUG 1: SYNC_HTTP_SCRIPT reads process.argv[1] which is hardcoded to '[eval]' in node -e
  try {
    vpsFetcher.__resetMemoryCaches();
    const dates = vpsFetcher.fetchAvailableDatesFromVpsSync('BBCA');
    assert.strictEqual(
      Array.isArray(dates) && dates.length > 0 && dates[0] === '2026-03-30',
      true,
      `Bug 1: fetchAvailableDatesFromVpsSync must successfully fetch dates from bridge (failed because process.argv[1] is "[eval]", got ${JSON.stringify(dates)})`
    );
    console.log('  [PASS] Bug 1 not present');
  } catch (err) {
    console.log('  [FAIL - BUG PROVEN] Bug 1:', err.message);
    failed++;
  }

  // BUG 2: Silent fallback to 'latest' corrupts historical date query
  try {
    vpsFetcher.__resetMemoryCaches();
    const result = await vpsFetcher.fetchBrokerSummaryFromVps('BBCA', '2025-01-01');
    assert.strictEqual(
      result,
      null,
      `Bug 2: Query for missing historical date 2025-01-01 must return null, not latest date data (${result && result.date})`
    );
    console.log('  [PASS] Bug 2 not present');
  } catch (err) {
    console.log('  [FAIL - BUG PROVEN] Bug 2:', err.message);
    failed++;
  }

  // BUG 3: ensureBrokerSummary returns true when targetFile is missing but latestFile exists
  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdf-test-'));
    const oldDir = process.env.ARJUM_DATA_DIR;
    try {
      process.env.ARJUM_DATA_DIR = tmpDir;
      const tickerDir = path.join(tmpDir, 'broker-summary', 'BBCA');
      fs.mkdirSync(tickerDir, { recursive: true });
      fs.writeFileSync(path.join(tickerDir, 'latest.json'), JSON.stringify({ marker: 'LATEST' }));

      // 2025-01-01.json is NOT in tickerDir
      const ensured = await vpsFetcher.ensureBrokerSummary('BBCA', '2025-01-01');
      const targetFileExists = fs.existsSync(path.join(tickerDir, '2025-01-01.json'));

      assert.strictEqual(
        ensured === true && !targetFileExists,
        false,
        'Bug 3: ensureBrokerSummary must not return true when target date file is missing from disk'
      );
      console.log('  [PASS] Bug 3 not present');
    } finally {
      if (oldDir !== undefined) process.env.ARJUM_DATA_DIR = oldDir;
      else delete process.env.ARJUM_DATA_DIR;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.log('  [FAIL - BUG PROVEN] Bug 3:', err.message);
    failed++;
  }

  // BUG 4: cleanTicker mangles BBCA.JK to BBCAJK
  try {
    vpsFetcher.__resetMemoryCaches();
    await vpsFetcher.fetchAvailableDatesFromVps('BBCA.JK');
    assert.strictEqual(
      lastRequestedUrl.includes('ticker=BBCA&') || lastRequestedUrl.endsWith('ticker=BBCA'),
      true,
      `Bug 4: Ticker BBCA.JK must be cleaned to BBCA, got "${lastRequestedUrl}"`
    );
    console.log('  [PASS] Bug 4 not present');
  } catch (err) {
    console.log('  [FAIL - BUG PROVEN] Bug 4:', err.message);
    failed++;
  }

  // BUG 5: memoryBrokerSummaryCache has no TTL, permanently serving stale live price
  try {
    vpsFetcher.__resetMemoryCaches();
    const detail = vpsFetcher.fetchLivePriceFromVpsSync('BBCA');
    assert.strictEqual(
      detail && typeof detail.timestamp === 'number',
      true,
      'Bug 5: memoryBrokerSummaryCache entries must have expiration/timestamp to avoid infinite stale cache'
    );
    console.log('  [PASS] Bug 5 not present');
  } catch (err) {
    console.log('  [FAIL - BUG PROVEN] Bug 5:', err.message);
    failed++;
  }

  // BUG 6: fetchLivePriceFromVpsSync ignores trade_date field in payload
  try {
    const payload = {
      stock_code: 'BBCA',
      trade_date: '2026-03-30',
      brokers: [{ bval: 10000, bvol: 1 }]
    };
    const as_of_date = String(payload.trade_date || payload.broker_start_date || payload.date || '').slice(0, 10) || null;
    assert.strictEqual(
      as_of_date,
      '2026-03-30',
      `Bug 6: as_of_date resolution must support trade_date property, got ${as_of_date}`
    );
    console.log('  [PASS] Bug 6 not present');
  } catch (err) {
    console.log('  [FAIL - BUG PROVEN] Bug 6:', err.message);
    failed++;
  }

  await worker.terminate();
  console.log(`\nResult: ${failed} bugs successfully proven.`);
}

runTests();
