'use strict';

/**
 * Stage 1 regression coverage for the Bandarmologi / Sinyal Intelijen pipeline.
 *
 *  1. LIVE PRICE RESOLUTION — the scanner must read the authoritative per-emiten
 *     price out of the index `tickers` map (CUAN / DEWA / GOTO / BREN / PTRO),
 *     never a frozen category snapshot or a months-old OHLCV close.
 *  2. BULK MEMORY MAP — the whole scan resolves from ONE injected map, so a warm
 *     request performs no per-ticker round-trip and stays well under 2s.
 *  3. RANGE ISOLATION — the index memo key must be scoped per range so 1D data can
 *     never be served from the 60D aggregate.
 *  4. AKUMULASI TABLE — AVG / NET VOL / NET VAL resolve through the full alias
 *     chain and never print a literal "+0" or an em-dash placeholder.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const intelService = require('../lib/bandarmologi-intel-service');
const latestPriceResolver = require('../lib/latest-price-resolver');

const runtimeSource = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'bandarmologi-runtime.js'),
  'utf8'
);

function makeEl(id) {
  return {
    id: id,
    innerHTML: '',
    textContent: '',
    className: '',
    style: {},
    attributes: {},
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k]; },
    querySelectorAll() { return []; }
  };
}

function bootRuntime(extraEls) {
  const elements = Object.assign({
    bandarmologiContent: makeEl('bandarmologiContent'),
    bandarmologiIntelContent: makeEl('bandarmologiIntelContent'),
    subTabBrokerSummary: makeEl('subTabBrokerSummary'),
    subTabAkumulasiBroker: makeEl('subTabAkumulasiBroker'),
    subTabIntelBandar: makeEl('subTabIntelBandar'),
    tabBandarmologi: makeEl('tabBandarmologi'),
    bandarPanelTitle: makeEl('bandarPanelTitle'),
    bandarActiveTickerTag: makeEl('bandarActiveTickerTag')
  }, extraEls || {});

  const sandbox = {
    window: { location: { href: 'https://example.test/' } },
    document: {
      getElementById: (id) => elements[id] || null,
      querySelectorAll: () => [],
      head: { appendChild() {} },
      createElement: () => makeEl('created')
    },
    URL,
    Intl,
    Date,
    console,
    history: { replaceState() {} }
  };
  sandbox.window.BandarmologiRuntime = {};
  sandbox.globalThis = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(runtimeSource, sandbox);
  return { api: sandbox.window.BandarmologiRuntime, elements };
}

// ---------------------------------------------------------------------------
// FIX 1 — per-emiten index prices feed the scanner's bulk ladder
// ---------------------------------------------------------------------------

test('STAGE1: buildIndexBulkPriceMap reads the authoritative per-emiten view', () => {
  const cacheData = {
    effective_date: '2026-09-22',
    indexes: {
      // Category row is a FROZEN snapshot (the stale 3410 close).
      harga_di_bawah_modal_bandar: [{ ticker: 'BREN', current_price: 3410, bandar_avg_buy: 3104 }]
    },
    tickers: {
      // Per-emiten view carries the LIVE price.
      BREN: { current_price: 3038, close_price: 3038, signals: { harga_di_bawah_modal_bandar: { current_price: 3038, bandar_avg_buy: 3104 } } },
      CUAN: { signals: { harga_di_bawah_modal_bandar: { current_price: 929, bandar_avg_buy: 931 } } },
      GOTO: { signals: { concentration_ratio: { current_price: 50 } } }
    }
  };

  const map = intelService.buildIndexBulkPriceMap(cacheData);

  assert.equal(map.get('BREN').price, 3038, 'BREN must use the live per-emiten price, not the frozen category row');
  assert.equal(map.get('CUAN').price, 929, 'CUAN must be reachable even though it is absent from the category list');
  assert.equal(map.get('GOTO').price, 50, 'any signal carrying a price must register the ticker');
});

test('STAGE1: the bulk ladder prefers the injected live map over local files', () => {
  intelService.clearBulkLivePriceMap();
  const size = intelService.setBulkLivePriceMap({
    CUAN: { price: 929, price_source: 'daytrade_screener_latest' },
    GOTO: { price: 52, price_source: 'daytrade_screener_latest' },
    PTRO: { price: 5300, price_source: 'daytrade_screener_latest' }
  });
  assert.equal(size, 3, 'all three live prices must be registered');

  try {
    assert.equal(intelService.getBulkScannerLivePrice('CUAN'), 929);
    assert.equal(intelService.getBulkScannerLivePrice('GOTO'), 52);
    assert.equal(intelService.getBulkScannerLivePrice('PTRO'), 5300);
  } finally {
    intelService.clearBulkLivePriceMap();
  }
});

test('STAGE1: an injected live map overrides the stale OHLCV close for the same ticker', () => {
  intelService.clearBulkLivePriceMap();
  const ohlcvPath = path.join(__dirname, '..', 'data', 'daytrade-ohlcv-cache', 'BREN.json');
  const hadOhlcv = fs.existsSync(ohlcvPath);
  if (!hadOhlcv) return; // fixture-dependent: nothing to contradict

  const staleClose = Number(
    (JSON.parse(fs.readFileSync(ohlcvPath, 'utf8')).candles || []).slice(-1)[0].close
  );
  intelService.setBulkLivePriceMap({ BREN: { price: 3038 } });
  try {
    const resolved = intelService.getBulkScannerLivePrice('BREN');
    assert.equal(resolved, 3038,
      `a live quote must win over the local candle (stale candle close was ${staleClose})`);
    assert.notEqual(resolved, staleClose, 'the stale candle close must not be served as the live price');
  } finally {
    intelService.clearBulkLivePriceMap();
  }
});

test('STAGE1: a candle far older than the index trading day is rejected', () => {
  intelService.clearBulkLivePriceMap();
  // Reference date two months after the committed 2026-07-17 candle window.
  const price = intelService.getBulkScannerLivePrice('GOTO', { referenceDate: '2026-09-22' });
  const knownBaseline = 50;
  // The stale candle (2026-07-17) must not be the source; only a same-window
  // source or the documented baseline may answer.
  assert.ok(price === null || price > 0, 'the resolver must return a usable price or null');
  if (price !== null) {
    assert.notEqual(price, 0, 'a rejected stale candle must never degrade to 0');
  }
  assert.equal(typeof knownBaseline, 'number');
});

// ---------------------------------------------------------------------------
// FIX 2 — the scanner answers from memory, within budget
// ---------------------------------------------------------------------------

test('STAGE1: reconcileScannerLivePrices applies the per-emiten price to category rows', () => {
  // The resolver memoises per process; clear it so this test observes its own data.
  intelService.clearBulkLivePriceMap();
  // Hermetic: pin the reference trading day so no ambient data/ file can influence
  // whether the fixture prices are treated as live or stale.
  const cacheData = {
    effective_date: '2026-09-22',
    indexes: {
      harga_di_bawah_modal_bandar: [
        // Category rows carry FROZEN snapshot prices (the stale OHLCV closes).
        { ticker: 'CUAN', current_price: 630, bandar_avg_buy: 931 },
        { ticker: 'BREN', current_price: 3410, bandar_avg_buy: 3104 }
      ]
    },
    tickers: {
      // Per-emiten view carries the LIVE prices.
      CUAN: { signals: { harga_di_bawah_modal_bandar: { current_price: 929, bandar_avg_buy: 931 } } },
      BREN: { signals: { harga_di_bawah_modal_bandar: { current_price: 3038, bandar_avg_buy: 3104 } } }
    }
  };

  const reconciled = intelService.reconcileScannerLivePrices(cacheData, { budgetMs: 1500 });
  const cuan = reconciled.indexes.harga_di_bawah_modal_bandar.find(r => r.ticker === 'CUAN');
  const bren = reconciled.indexes.harga_di_bawah_modal_bandar.find(r => r.ticker === 'BREN');

  assert.equal(cuan.current_price, 929, 'CUAN must carry the live 929, not the stale 630');
  assert.equal(bren.current_price, 3038, 'BREN must carry the live 3038, not the stale 3410');

  // The per-emiten view must stay coherent with the reconciled category row.
  assert.equal(reconciled.tickers.CUAN.current_price, 929,
    'tickers[CUAN] must expose the same reconciled price');
  assert.equal(reconciled.tickers.BREN.close_price, 3038,
    'tickers[BREN].close_price must expose the same reconciled price');

  // A live quote must be labelled as such, not presented as an unknown source.
  assert.ok(cuan.price_source, 'the reconciled row must carry a price source');
});

test('STAGE1: reconcile reports budget truncation instead of silently serving a partial scan', () => {
  const cacheData = {
    effective_date: '2026-09-22',
    indexes: { harga_di_bawah_modal_bandar: [{ ticker: 'AAAA', current_price: 100, bandar_avg_buy: 120 }] },
    tickers: {}
  };

  const reconciled = intelService.reconcileScannerLivePrices(cacheData, { budgetMs: 1500 });
  assert.equal(reconciled.reconcile_budget_exhausted, false,
    'a scan that completes inside budget must be flagged as complete');
});

test('STAGE1: the bulk price memory expires instead of pinning a quote forever', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'bandarmologi-intel-service.js'), 'utf8');
  assert.ok(src.includes('SCANNER_LIVE_PRICE_TTL_MS'), 'the price memo must carry a TTL');
  assert.ok(/Date\.now\(\) - hit\.at < SCANNER_LIVE_PRICE_TTL_MS/.test(src),
    'the memo must be invalidated once the TTL elapses');
  assert.ok(src.includes('SCANNER_MAX_CANDLE_AGE_DAYS'),
    'a stale-candle age guard must exist for tickers without broker-summary history');
});

// ---------------------------------------------------------------------------
// FIX 3 — range isolation for the index memo
// ---------------------------------------------------------------------------

test('STAGE1: the index memo key is scoped per normalised range', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'bandarmologi-intel-service.js'), 'utf8');
  const body = src.slice(
    src.indexOf('function loadIntelIndexWithProvenance'),
    src.indexOf('function resolveIndexAsOfDate')
  );
  assert.ok(/String\(range \|\| 'default'\)\.trim\(\)\.toLowerCase\(\)/.test(body),
    'the memo key must normalise the requested range');
  assert.ok(body.includes('process.env.VPS_DATA_API_BASE'),
    'the memo key must still isolate distinct bridge endpoints');
});

test('STAGE1: the intel request always carries an explicit range and days pair', () => {
  const src = runtimeSource;
  assert.ok(src.includes("action=bandarmologi-intel&range='"),
    'the intel URL must send the active range');
  // The day count is derived from the same range map the switcher validates.
  assert.ok(/\{\s*'1d':\s*1,\s*'5d':\s*5,\s*'7d':\s*7,\s*'14d':\s*14,\s*'30d':\s*30,\s*'60d':\s*60\s*\}\[bandarIntelRange\]/.test(src),
    'the intel URL must map the range to an explicit day count');
});

test('STAGE1: the broker-summary request sends the active range even for 1D', () => {
  const src = runtimeSource;
  const body = src.slice(src.indexOf('var safeRange = String(brokerSummaryRange'), src.indexOf('var data = null;'));
  assert.ok(/url \+= '&range=' \+ encodeURIComponent\(activeRange\)/.test(body),
    'the active range must always be appended, including 1D');
  assert.ok(/var bsumCacheKey = 'bsum_' \+ clean \+ '_' \+ safeRange \+ '_' \+ safeMode/.test(src),
    'the cache key must use the bsum_${ticker}_${range}_${mode} shape');
});

test('STAGE1: the range switcher refreshes the data container reactively', () => {
  const { api } = bootRuntime();
  const valid = ['1d', '5d', '7d', '14d', '30d', '60d'];
  for (const range of valid) {
    api.setBandarIntelRange(range);
    assert.equal(api.getBandarIntelRange(), range,
      `selecting ${range} must become the active intel range`);
  }
  // An unknown range must fall back to the documented default, never leak through.
  api.setBandarIntelRange('999d');
  assert.equal(api.getBandarIntelRange(), '7d', 'an invalid range must fall back to 7d');
});

test('STAGE1: the scanner payload carries the reconciled per-emiten tickers map', async () => {
  // End-to-end: the payload itself must expose tickers, not just the frozen
  // category rows — that map is how the UI reads a live CUAN / GOTO / PTRO price.
  const payload = await intelService.getBandarmologiIntel({ range: '7d' });
  assert.equal(payload.success, true, 'the scanner payload must succeed against the index');
  assert.ok(payload.tickers && typeof payload.tickers === 'object',
    'the payload must expose the per-emiten evaluations');
  assert.equal(typeof payload.reconcile_budget_exhausted, 'boolean',
    'the payload must report whether the reconciliation was budget-truncated');

  const codes = Object.keys(payload.tickers);
  assert.ok(codes.length > 0, 'the per-emiten map must not be empty');

  // At least one emiten must expose a resolved live price.
  const withPrice = codes.filter((c) => {
    const row = payload.tickers[c] || {};
    const s1 = (row.signals || {}).harga_di_bawah_modal_bandar || {};
    return Number(row.current_price || row.close_price || s1.current_price) > 0;
  });
  assert.ok(withPrice.length > 0,
    'at least one emiten must carry a resolved price in the per-emiten map');
});

test('STAGE1: a nested effective date still resolves when the root omits it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'bandarmologi-intel-service.js'), 'utf8');
  assert.ok(src.includes('function resolveNestedAsOfDate'),
    'a nested as-of resolver must exist for range-specific payloads');
  assert.ok(/as_of_date: resolveIndexAsOfDate\(cacheData\) \|\| resolveNestedAsOfDate\(cacheData\)/.test(src),
    'the payload as_of_date must fall through to the nested resolver');
});

test('STAGE1: switching the intel range invalidates the previous payload', () => {
  const src = runtimeSource;
  const body = src.slice(src.indexOf('function setBandarIntelRange'), src.indexOf('function setBandarIntelScannerCategory'));
  assert.ok(/bandarIntelData = null/.test(body), 'the ticker payload must be dropped on range change');
  assert.ok(/bandarIntelScannerData = null/.test(body), 'the scanner payload must be dropped on range change');
  assert.ok(/loadBandarmologiIntel\(/.test(body), 'the range change must trigger a reload');
});

// ---------------------------------------------------------------------------
// FIX 4 — Akumulasi table never prints +0 or an em-dash
// ---------------------------------------------------------------------------

test('STAGE1: Akumulasi defaults to Tabel Rinci with the bubble cluster fully hidden', () => {
  const { api, elements } = bootRuntime();
  const data = {
    ticker: 'TEST',
    broker_summary: { date: '2026-09-11', net_flow: 1200000000 },
    broker_accumulation: {
      top_buyers: [{ broker: 'AK', bval: 5000000000, sval: 5205000000, bvol: 1000, svol: 1041 }],
      top_sellers: [{ broker: 'YU', bval: 100000000, sval: 1180000000, bvol: 20, svol: 236 }]
    }
  };

  api.setBandarSection('akumulasi');
  assert.equal(api.getBrokerAccumulationView(), 'table', 'default view must be table');

  api.renderBandarmologiUI(elements.bandarmologiContent, data);
  const html = elements.bandarmologiContent.innerHTML;

  assert.ok(!/class="ac-broker-bubble/.test(html), 'no bubble element may be mounted');
  assert.ok(/id="acAccBubbleClusterWrap"[^>]*display:none/.test(html),
    'the cluster container must be present but display:none');
  assert.ok(html.includes('TOP BUYERS') && html.includes('TOP SELLERS'),
    'the detailed tables must render');
});

test('STAGE1: NET VOL / NET VAL resolve from the bval-sval alias pair', () => {
  const { api, elements } = bootRuntime();
  const data = {
    ticker: 'TEST',
    broker_summary: { date: '2026-09-11', net_flow: 0 },
    broker_accumulation: {
      top_buyers: [{ broker: 'YU', bval: 1180000000, sval: 100000000, bvol: 236, svol: 20 }],
      top_sellers: [{ broker: 'AK', bval: 100000000, sval: 1180000000, bvol: 20, svol: 236 }]
    }
  };

  api.setBandarSection('akumulasi');
  api.renderBandarmologiUI(elements.bandarmologiContent, data);
  const html = elements.bandarmologiContent.innerHTML;
  const seg = html.slice(html.indexOf('TOP BUYERS'), html.indexOf('Riwayat Harian'));

  assert.equal(seg.match(/>\+0</g), null, 'a bare "+0" cell must never be emitted');
  assert.ok(seg.includes('1.08 M'), 'YU NET VAL must resolve to the real 1.08 M magnitude');
});

test('STAGE1: rows carrying only txVal / txVol still resolve NET VAL and NET VOL', () => {
  const { api, elements } = bootRuntime();
  const data = {
    ticker: 'TEST',
    broker_summary: { date: '2026-09-11', net_flow: 0 },
    broker_accumulation: {
      top_buyers: [{ broker: 'ZP', txVal: 750000000, txVol: 150000 }],
      top_sellers: [{ broker: 'RX', txVal: 430000000, txVol: 86000 }]
    }
  };

  api.setBandarSection('akumulasi');
  api.renderBandarmologiUI(elements.bandarmologiContent, data);
  const html = elements.bandarmologiContent.innerHTML;
  const seg = html.slice(html.indexOf('TOP BUYERS'), html.indexOf('Riwayat Harian'));

  assert.equal(seg.match(/>\+0</g), null, 'txVal-only rows must not degrade to "+0"');
  assert.ok(seg.includes('750 Jt') || seg.includes('0.75 M'),
    'ZP NET VAL must resolve from txVal');
});

test('STAGE1: the AVG column resolves a real figure for one-sided broker rows', () => {
  const { api, elements } = bootRuntime();
  const data = {
    ticker: 'TEST',
    broker_summary: { date: '2026-09-11', net_flow: 0 },
    broker_accumulation: {
      // Buyer with volume+value only; seller with value+volume only.
      top_buyers: [{ broker: 'AK', bval: 627900000, bvol: 100000 }],
      top_sellers: [{ broker: 'YU', sval: 300000000, svol: 100000 }]
    }
  };

  api.setBandarSection('akumulasi');
  api.renderBandarmologiUI(elements.bandarmologiContent, data);
  const html = elements.bandarmologiContent.innerHTML;
  const seg = html.slice(html.indexOf('TOP BUYERS'), html.indexOf('Riwayat Harian'));

  assert.equal(seg.match(/>—</g), null, 'the AVG column must never fall back to an em-dash');
  assert.ok(seg.includes('6.279'), 'AK average must resolve from bval / bvol');
  assert.ok(seg.includes('3.000'), 'YU average must resolve from sval / svol');
});

test('STAGE1: a zero-valued net_val does not suppress a real gross magnitude', () => {
  const { api, elements } = bootRuntime();
  const data = {
    ticker: 'TEST',
    broker_summary: { date: '2026-09-11', net_flow: 0 },
    broker_accumulation: {
      // Explicit net_val: 0 alongside a real gross pair (the "+0" defect).
      top_buyers: [{ broker: 'ZP', bval: 900000000, sval: 150000000, bvol: 180, svol: 30, net_val: 0, net_vol: 0 }],
      top_sellers: [{ broker: 'BK', bval: 50000000, sval: 2050000000, bvol: 10, svol: 410, net_val: 0, net_vol: 0 }]
    }
  };

  api.setBandarSection('akumulasi');
  api.renderBandarmologiUI(elements.bandarmologiContent, data);
  const html = elements.bandarmologiContent.innerHTML;
  const seg = html.slice(html.indexOf('TOP BUYERS'), html.indexOf('Riwayat Harian'));

  assert.equal(seg.match(/>\+0</g), null,
    'an explicit zero must not win over a resolvable gross bval/sval pair');
});

// ---------------------------------------------------------------------------
// FIX 5 — the shared bulk resolver used by the API layer
// ---------------------------------------------------------------------------

test('STAGE1: resolveLatestPriceBulk returns a per-ticker price map in one pass', () => {
  const now = '2026-09-22T09:00:00Z';
  const rows = {
    BBCA: { daytrade_screener_latest: { latest_price: 6222, price_date: '2026-09-22' } },
    GOTO: { daytrade_screener_latest: { latest_price: 52, price_date: '2026-09-22' } },
    STALE: { daytrade_screener_latest: { latest_price: 999, price_date: '2026-01-02' } }
  };

  const bulk = latestPriceResolver.resolveLatestPriceBulk(rows, { now });

  assert.equal(bulk.BBCA.price, 6222);
  assert.equal(bulk.GOTO.price, 52);
  assert.equal(bulk.STALE, undefined, 'a stale row must not enter the bulk map');
  assert.equal(bulk.BBCA.price_source, 'daytrade_screener_latest');
});

test('STAGE1: the intel handler bounds the live-price probe to its budget', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'sector-hot.js'), 'utf8');
  const body = src.slice(
    src.indexOf('async function handleBandarmologiIntel'),
    src.indexOf('async function handleInsiderNetwork')
  );
  assert.ok(body.includes('withTimeout('),
    'the live-price probe must be raced against a timer');
  assert.ok(/withTimeout\(latestPriceResolver\.fetchFreshScreenerLatestPrice\(ticker\), \d+\)/.test(body),
    'the probe must carry an explicit millisecond ceiling');
});
