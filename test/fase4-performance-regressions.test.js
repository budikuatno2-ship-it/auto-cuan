'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const { InMemoryTtlCache, hotQuoteCache, hotMarketStructureCache } = require('../lib/in-memory-ttl-cache');

test('AC-4.1: InMemoryTtlCache supports sub-millisecond retrieval, TTL expiry, and LRU bounds', async () => {
  const cache = new InMemoryTtlCache({ defaultTtlMs: 50, maxEntries: 3 });

  // 1. Basic set and hit
  cache.set('key1', { data: 'test1' });
  const start = process.hrtime.bigint();
  const hit = cache.get('key1');
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

  assert.ok(hit, 'Key1 must hit');
  assert.equal(hit.data, 'test1');
  assert.ok(elapsedMs < 1.0, `Cache hit must be sub-millisecond (measured: ${elapsedMs}ms)`);

  // 2. LRU eviction
  cache.set('key2', { data: 'test2' });
  cache.set('key3', { data: 'test3' });
  cache.set('key4', { data: 'test4' }); // Should evict oldest (key1 was accessed, so key2 should be oldest or size bounded)

  assert.ok(cache.getStats().size <= 3, 'Cache size must not exceed maxEntries');

  // 3. TTL expiry
  await new Promise(r => setTimeout(r, 60));
  assert.equal(cache.get('key4'), null, 'Expired entry must return null');
});

test('AC-4.1: /api/quote and /api/sector-hot set X-Cache headers and Cache-Control', async (t) => {
  const quoteHandler = require('../api/quote');
  const sectorHandler = require('../api/sector-hot');

  hotQuoteCache.clear();
  hotMarketStructureCache.clear();

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      chart: {
        result: [{
          meta: { regularMarketPrice: 10000, symbol: 'BBCA.JK', currency: 'IDR' },
          timestamp: [1760000000, 1760086400],
          indicators: {
            quote: [{
              open: [9900, 10000],
              high: [10100, 10200],
              low: [9850, 9950],
              close: [10000, 10050],
              volume: [50000000, 60000000]
            }]
          }
        }]
      }
    })
  });

  if (t && typeof t.after === 'function') {
    t.after(() => { global.fetch = originalFetch; });
  }

  function callHandler(handler, query) {
    return new Promise((resolve, reject) => {
      const headers = {};
      let statusCode = 200;
      let body = null;
      const req = {
        method: 'GET',
        query,
        url: '/test?' + new URLSearchParams(query).toString(),
        headers: { host: '127.0.0.1' },
        connection: { remoteAddress: '127.0.0.1' },
        socket: { remoteAddress: '127.0.0.1' }
      };
      const res = {
        headersSent: false,
        statusCode: 200,
        setHeader(k, v) { headers[k.toLowerCase()] = v; },
        getHeader(k) { return headers[k.toLowerCase()]; },
        removeHeader(k) { delete headers[k.toLowerCase()]; },
        status(code) { statusCode = code; return this; },
        json(data) { this.headersSent = true; body = data; resolve({ statusCode, headers, body }); return this; },
        end() { this.headersSent = true; resolve({ statusCode, headers, body }); return this; }
      };
      try {
        const p = handler(req, res);
        if (p && typeof p.then === 'function') p.catch(reject);
      } catch (err) { reject(err); }
    });
  }

  try {
    // Quote cold vs warm
    const qCold = await callHandler(quoteHandler, { ticker: 'BBCA' });
    assert.equal(qCold.statusCode, 200);
    assert.equal(qCold.headers['x-cache'], 'MISS');
    assert.ok(qCold.headers['cache-control'].includes('public'));

    const qWarm = await callHandler(quoteHandler, { ticker: 'BBCA' });
    assert.equal(qWarm.statusCode, 200);
    assert.equal(qWarm.headers['x-cache'], 'HIT');

    // Market structure cold vs warm
    const msCold = await callHandler(sectorHandler, { action: 'market-structure-list' });
    assert.equal(msCold.statusCode, 200);
    assert.equal(msCold.headers['x-cache'], 'MISS');

    const msWarm = await callHandler(sectorHandler, { action: 'market-structure-list' });
    assert.equal(msWarm.statusCode, 200);
    assert.equal(msWarm.headers['x-cache'], 'HIT');
  } finally {
    global.fetch = originalFetch;
  }
});

test('AC-4.3: Lifecycle Polling Guard suppresses interval ticks when document.hidden === true', async () => {
  let docHidden = true;
  let listener = null;
  const doc = {
    get hidden() { return docHidden; },
    addEventListener(evt, fn) { listener = fn; }
  };

  let callbackTicks = 0;
  const mockRoot = {
    document: doc,
    setInterval(fn, d) { return setInterval(fn, d); },
    clearInterval(id) { return clearInterval(id); }
  };

  const guardCode = fs.readFileSync(path.join(__dirname, '../public/lifecycle-polling-guard.js'), 'utf8');
  const guardFn = new Function('window', 'document', guardCode + '\nreturn window.AutoCuanLifecycleGuard;');
  const guard = guardFn(mockRoot, doc);

  const timerId = mockRoot.setInterval(function () {
    callbackTicks++;
  }, 10);

  // While hidden, ticks must be completely suppressed
  await new Promise(r => setTimeout(r, 60));
  assert.equal(callbackTicks, 0, 'Callback must not execute while document is hidden');
  assert.ok(guard.getStats().metrics.hiddenTicksSuppressed > 0, 'Suppressed ticks counter must increment');

  // When visible, ticks resume
  docHidden = false;
  let resumed = false;
  guard.addResumeListener(() => { resumed = true; });
  if (listener) listener();

  await new Promise(r => setTimeout(r, 40));
  assert.ok(callbackTicks > 0, 'Callback must resume execution when document is visible');
  assert.equal(resumed, true, 'Resume listener must be triggered on visibility change');

  mockRoot.clearInterval(timerId);
});

test('AC-4.3: Tab switching clears previous tab intervals and triggers AbortController', () => {
  const doc = {
    hidden: false,
    addEventListener() {}
  };

  const mockRoot = {
    document: doc,
    setInterval(fn, d) { return setInterval(fn, d); },
    clearInterval(id) { return clearInterval(id); }
  };

  const guardCode = fs.readFileSync(path.join(__dirname, '../public/lifecycle-polling-guard.js'), 'utf8');
  const guardFn = new Function('window', 'document', guardCode + '\nreturn window.AutoCuanLifecycleGuard;');
  const guard = guardFn(mockRoot, doc);

  // Switch to screener tab and start interval
  guard.onTabSwitch('screener');
  const timer1 = mockRoot.setInterval(() => {}, 1000);
  assert.equal(guard.getStats().activeTimersCount, 1);

  // Switch to sektor tab: screener interval must be automatically cleaned up
  guard.onTabSwitch('sektor');
  assert.equal(guard.getStats().activeTimersCount, 0, 'Previous tab timer must be pruned');
  assert.ok(guard.getStats().metrics.tabTimersCleared >= 1);
  assert.ok(guard.getStats().metrics.abortedTabRequestsCount >= 1);
});

test('AC-4.4: 3x tab cycles maintain stable heap growth (< 10%)', async () => {
  const { runBenchmark } = require('../tools/benchmark-fase4-perf');
  const report = await runBenchmark();

  assert.equal(report.overall_status, 'PASS');
  assert.ok(report.criteria['AC-4.4'].growth_pct < 10.0, 'Heap growth must be strictly under 10%');
});

test('AntiSlop / GPU CSS: Zero backdrop-blur on scrolling table headers in public/index.html', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  // Ensure no sticky thead contains backdrop-blur
  const stickyTheadWithBlurRegex = /<thead[^>]*class="[^"]*sticky[^"]*backdrop-blur[^"]*"[^>]*>/gi;
  const matches = indexHtml.match(stickyTheadWithBlurRegex) || [];

  assert.equal(matches.length, 0, `Expected 0 table theads with backdrop-blur, found ${matches.length}`);
});
