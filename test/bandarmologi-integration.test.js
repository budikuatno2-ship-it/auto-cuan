'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const arjumClient = require('../lib/arjum-client');
const bandarmologiService = require('../lib/bandarmologi-service');
const sectorHot = require('../api/sector-hot');

test('arjumClient: cleanTicker cleans non-alphanumerics and normalizes to uppercase', () => {
  assert.equal(arjumClient.cleanTicker('bbca'), 'BBCA');
  assert.equal(arjumClient.cleanTicker(' BBRI.JK '), 'BBRIJK');
  assert.equal(arjumClient.cleanTicker(null), '');
});

test('arjumClient: hasArjumApiKey checks environment variable safely without leaking', () => {
  const isConfigured = arjumClient.hasArjumApiKey();
  assert.equal(typeof isConfigured, 'boolean');
});

test('arjumClient: getConfiguredDailyQuota reads ARJUM_DAILY_QUOTA env var, falls back to a sane default', () => {
  const orig = process.env.ARJUM_DAILY_QUOTA;
  try {
    delete process.env.ARJUM_DAILY_QUOTA;
    assert.equal(arjumClient.getConfiguredDailyQuota(), 16000, 'must fall back to the documented plan quota, not a stale small default');

    process.env.ARJUM_DAILY_QUOTA = '25000';
    assert.equal(arjumClient.getConfiguredDailyQuota(), 25000, 'must be overridable via env var without a code change');

    process.env.ARJUM_DAILY_QUOTA = 'not-a-number';
    assert.equal(arjumClient.getConfiguredDailyQuota(), 16000, 'must ignore a garbage env value rather than returning NaN');
  } finally {
    if (orig !== undefined) process.env.ARJUM_DAILY_QUOTA = orig;
    else delete process.env.ARJUM_DAILY_QUOTA;
  }
});

test('arjumClient: extractQuotaHeaders picks up a rate-limit-style header opportunistically', () => {
  const headersWith = new Map([['x-ratelimit-remaining', '42'], ['x-ratelimit-limit', '16000']]);
  const resultWith = arjumClient.extractQuotaHeaders({ get: (k) => headersWith.get(k) || null });
  assert.deepEqual(resultWith, { remaining: 42, limit: 16000 });

  const headersWithout = new Map();
  const resultWithout = arjumClient.extractQuotaHeaders({ get: (k) => headersWithout.get(k) || null });
  assert.equal(resultWithout, null, 'must return null (not throw or fabricate) when Arjum sends no quota headers');
});

// Regression: the Broker Summary UI only ever showed 5 buyers/5 sellers.
// Root cause: broker_limit/level_limit were never sent to Arjum, so its
// endpoint fell back to a small default instead of the 20/25 the UI expects.
test('arjumClient: fetchBrokerSummary always sends explicit broker_limit and level_limit', async () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'arjum-cache-broker-limit-'));
  const origEnv = process.env.ARJUM_DATA_DIR;
  process.env.ARJUM_DATA_DIR = tmpBase; // fetchArjum records quota usage to disk on every real call — never let a test write into the real repo data dir.

  const origFetch = global.fetch;
  let capturedUrl = '';
  global.fetch = async (url) => {
    capturedUrl = url;
    return { ok: true, json: async () => ({ success: true }) };
  };
  try {
    await arjumClient.fetchBrokerSummary('BBCA');
    assert.match(capturedUrl, /broker_limit=100/, 'must default broker_limit to 100 to cover full IDX broker universe');
    assert.match(capturedUrl, /level_limit=100/);

    capturedUrl = '';
    await arjumClient.fetchBrokerSummary('BBCA', null, null, { brokerLimit: 50, levelLimit: 60 });
    assert.match(capturedUrl, /broker_limit=50/, 'must honor an explicit override');
    assert.match(capturedUrl, /level_limit=60/);
  } finally {
    global.fetch = origFetch;
    if (origEnv !== undefined) process.env.ARJUM_DATA_DIR = origEnv;
    else delete process.env.ARJUM_DATA_DIR;
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

// Regression: backfill/daily-update reserve-quota math is worthless if the
// underlying HTTP client never actually records usage anywhere durable.
test('arjumClient: every real fetchArjum call (2xx or not) increments the persistent quota tracker exactly once', async () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'arjum-cache-tracker-wiring-'));
  const origEnv = process.env.ARJUM_DATA_DIR;
  process.env.ARJUM_DATA_DIR = tmpBase;

  const quotaTracker = require('../lib/arjum-quota-tracker');
  const origFetch = global.fetch;
  let respondOk = true;
  global.fetch = async () => respondOk
    ? { ok: true, headers: { get: () => null }, json: async () => ({ success: true }) }
    : { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) };

  try {
    assert.equal(arjumClient.getUsedQuotaToday(), 0);
    await arjumClient.fetchBrokerSummary('BBCA');
    assert.equal(arjumClient.getUsedQuotaToday(), 1, 'a successful response must count against quota');

    respondOk = false;
    await arjumClient.fetchBrokerSummary('BBCA');
    assert.equal(arjumClient.getUsedQuotaToday(), 2, 'a rejected-but-answered request (e.g. 429) still reached Arjum and must also count');
  } finally {
    global.fetch = origFetch;
    if (origEnv !== undefined) process.env.ARJUM_DATA_DIR = origEnv;
    else delete process.env.ARJUM_DATA_DIR;
    fs.rmSync(tmpBase, { recursive: true, force: true });
    delete require.cache[require.resolve('../lib/arjum-quota-tracker')];
  }
});

// Regression: "All" in the flow selector must never become a locally-computed
// Foreign + Domestic sum — each flow-filtered call independently truncates to
// its own top-broker_limit, so summing two separately-truncated lists would
// NOT reconstruct the true combined top-N and would silently disagree with
// Arjum's own unfiltered total. "All" must stay a single pass-through call
// with no flow param, deferring entirely to Arjum's own combined response.
test('arjumClient: fetchBrokerSummary sends no flow param for "all" or an unrecognized value (never locally summed)', async () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'arjum-cache-flow-all-url-'));
  const origEnv = process.env.ARJUM_DATA_DIR;
  process.env.ARJUM_DATA_DIR = tmpBase; // fetchArjum records quota usage to disk on every real call — never let a test write into the real repo data dir.

  const origFetch = global.fetch;
  let capturedUrl = '';
  global.fetch = async (url) => { capturedUrl = url; return { ok: true, json: async () => ({ success: true }) }; };
  try {
    await arjumClient.fetchBrokerSummary('BBCA', null, 'all');
    assert.doesNotMatch(capturedUrl, /flow=/i, '"all" must omit the flow param entirely, not send flow=all or anything else');

    capturedUrl = '';
    await arjumClient.fetchBrokerSummary('BBCA', null, null);
    assert.doesNotMatch(capturedUrl, /flow=/i, 'omitting flow must also omit the flow param');

    capturedUrl = '';
    await arjumClient.fetchBrokerSummary('BBCA', null, 'F');
    assert.match(capturedUrl, /flow=F/, 'sanity check: F must still be sent explicitly');
  } finally {
    global.fetch = origFetch;
    if (origEnv !== undefined) process.env.ARJUM_DATA_DIR = origEnv;
    else delete process.env.ARJUM_DATA_DIR;
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('bandarmologiService: getBandarmologiData with flow=all (or omitted) uses the normal disk-cache path, never the live per-flow branch', async () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'arjum-flow-all-'));
  const origEnv = process.env.ARJUM_DATA_DIR;
  process.env.ARJUM_DATA_DIR = tmpBase;

  const origFetchSummary = arjumClient.fetchBrokerSummary;
  let liveFlowCallMade = false;
  arjumClient.fetchBrokerSummary = async (...args) => { liveFlowCallMade = true; return origFetchSummary(...args); };

  try {
    bandarmologiService.writeDiskCache('broker-summary', 'FLOWALL1', 'latest', {
      stock_code: 'FLOWALL1',
      date: '2026-09-05',
      top_buyers: [{ broker: 'YU', bval: 100, sval: 0, bvol: 10, svol: 0 }],
      top_sellers: []
    });

    const res = await bandarmologiService.getBandarmologiData('FLOWALL1', { flow: 'all' });
    assert.equal(res.success, true);
    assert.equal(liveFlowCallMade, false, 'flow=all must be served from the disk-cached combined data, not a live flow-filtered fetch');
  } finally {
    arjumClient.fetchBrokerSummary = origFetchSummary;
    if (origEnv !== undefined) process.env.ARJUM_DATA_DIR = origEnv;
    else delete process.env.ARJUM_DATA_DIR;
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

// Regression: the demo-fallback badge used to say generic "DEMO PREVIEW"
// regardless of why live data wasn't used, so a quota-exhausted API looked
// identical to "no cache yet" or a real outage.
test('arjumClient: classifyFailure distinguishes quota exhaustion from a generic API error', () => {
  assert.equal(arjumClient.classifyFailure({ ok: false, status: 429, error: 'Too Many Requests' }).reason, 'quota_exceeded');
  assert.equal(arjumClient.classifyFailure({ ok: false, status: 403, error: 'Daily quota exceeded' }).reason, 'quota_exceeded');
  assert.equal(arjumClient.classifyFailure({ ok: false, status: 500, error: 'Internal Server Error' }).reason, 'api_error');
  assert.equal(arjumClient.classifyFailure({ ok: false, status: 404, error: 'Not Found' }).reason, 'api_error');
  assert.equal(arjumClient.classifyFailure(null).reason, 'unknown');
});

test('bandarmologiService: getBandarmologiData surfaces demo_reason=quota_exceeded instead of a silent generic fallback', async () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'arjum-cache-quota-'));
  const origEnv = process.env.ARJUM_DATA_DIR;
  process.env.ARJUM_DATA_DIR = tmpBase;

  const origHasKey = arjumClient.hasArjumApiKey;
  const origFetchSummary = arjumClient.fetchBrokerSummary;
  const origFetchAcc = arjumClient.fetchBrokerAccumulation;
  const origFetchIns = arjumClient.fetchInsiders;

  arjumClient.hasArjumApiKey = () => true;
  arjumClient.fetchBrokerSummary = async () => ({ ok: false, status: 429, error: 'Quota exceeded for today' });
  arjumClient.fetchBrokerAccumulation = async () => ({ ok: false, status: 429, error: 'Quota exceeded for today' });
  arjumClient.fetchInsiders = async () => ({ ok: false, status: 429, error: 'Quota exceeded for today' });

  try {
    const res = await bandarmologiService.getBandarmologiData('NOCACHE1', {});
    assert.equal(res.success, true);
    assert.equal(res.is_demo, true);
    assert.equal(res.demo_reason, 'quota_exceeded');
  } finally {
    arjumClient.hasArjumApiKey = origHasKey;
    arjumClient.fetchBrokerSummary = origFetchSummary;
    arjumClient.fetchBrokerAccumulation = origFetchAcc;
    arjumClient.fetchInsiders = origFetchIns;
    if (origEnv !== undefined) process.env.ARJUM_DATA_DIR = origEnv;
    else delete process.env.ARJUM_DATA_DIR;
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('bandarmologiService: generateDemoData produces complete structure for UI', () => {
  const data = bandarmologiService.generateDemoData('BBCA', '2026-09-04');
  assert.equal(data.ticker, 'BBCA');
  assert.equal(data.date, '2026-09-04');
  assert.equal(data.is_demo, true);
  assert.ok(data.broker_summary);
  assert.ok(data.broker_summary.top_buyers.length >= 5);
  assert.ok(data.broker_summary.top_sellers.length >= 5);
  assert.ok(data.broker_accumulation);
  assert.ok(Array.isArray(data.broker_accumulation.series));
  assert.ok(Array.isArray(data.insiders));
});

test('bandarmologiService: getBandarmologiData returns demo fallback gracefully when key is unset', async () => {
  const res = await bandarmologiService.getBandarmologiData('BBRI');
  assert.equal(res.success, true);
  assert.equal(res.ticker, 'BBRI');
  assert.ok(res.broker_summary);
  assert.ok(res.broker_accumulation);
  assert.ok(res.insiders);
});

test('sectorHot: handleBandarmologi responds with status 200 and payload', async () => {
  const handler = sectorHot.__test.handleBandarmologi;
  assert.equal(typeof handler, 'function');

  let statusCode = 0;
  let responseData = null;

  const req = {
    query: { ticker: 'TLKM' }
  };
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(data) {
      responseData = data;
      return this;
    }
  };

  await handler(req, res);
  assert.equal(statusCode, 200);
  assert.equal(responseData.success, true);
  assert.equal(responseData.ticker, 'TLKM');
});

test('bandarmologiService: normalizeBrokerSummary converts raw broker_levels to top_buyers/sellers', () => {
  const raw = {
    stock_code: 'BBCA',
    broker_start_date: '2026-09-04',
    broker_end_date: '2026-09-04',
    broker_levels: [
      {
        buy: { broker_code: 'YU', broker_name: 'CGS', bval: 154000000, bvol: 22000, bavg: 7000 },
        sell: { broker_code: 'AK', broker_name: 'UBS', sval: 120000000, svol: 17000, savg: 7050 }
      }
    ]
  };

  const norm = bandarmologiService.normalizeBrokerSummary(raw, '2026-09-04');
  assert.equal(norm.date, '2026-09-04');
  assert.equal(norm.top_buyers[0].broker, 'YU');
  assert.equal(norm.top_sellers[0].broker, 'AK');
  assert.equal(norm.net_status, 'BIG_ACCUMULATION');
  assert.ok(Array.isArray(norm.gross_buyers));
  assert.ok(Array.isArray(norm.net_buyers));
});

test('bandarmologiService: normalizeBrokerSummary handles full raw brokers array with gross and net fields', () => {
  const rawWithBrokers = {
    stock_code: 'BBCA',
    date: '2026-09-04',
    brokers: [
      { broker_code: 'YU', broker_name: 'CGS', bval: 154000, sval: 15000, bvol: 2200, svol: 200, bfrq: 240, sfrq: 30, nval: 139000, nvol: 2000 },
      { broker_code: 'AK', broker_name: 'UBS', bval: 20000, sval: 120000, bvol: 300, svol: 1700, bfrq: 50, sfrq: 180, nval: -100000, nvol: -1400 }
    ]
  };

  const norm = bandarmologiService.normalizeBrokerSummary(rawWithBrokers, '2026-09-04');
  assert.equal(norm.gross_buyers[0].broker, 'YU');
  assert.equal(norm.gross_buyers[0].bval, 154000);
  assert.equal(norm.gross_buyers[0].sval, 15000);
  assert.equal(norm.gross_buyers[0].bfrq, 240);
  assert.equal(norm.gross_buyers[0].sfrq, 30);
  assert.equal(norm.gross_buyers[0].nval, 139000);

  assert.equal(norm.gross_sellers[0].broker, 'AK');
  assert.equal(norm.gross_sellers[0].sval, 120000);
  assert.equal(norm.gross_sellers[0].bval, 20000);

  assert.equal(norm.net_buyers[0].broker, 'YU');
  assert.equal(norm.net_buyers[0].nval, 139000);
  assert.equal(norm.net_sellers[0].broker, 'AK');
  assert.equal(norm.net_sellers[0].nval, -100000);
  assert.equal(norm.net_flow, 39000); // 139000 (YU) + (-100000) (AK), summed once per broker
});

// Regression: the "Semua" (all) flow bubble view showed every broker as BUY
// with "Sellers (0)", even for tickers with genuine sell-side data visible
// in each broker's own detail card. Root cause: `raw.gross_sellers ||
// raw.top_sellers || []` does not fall back past an empty array — `[]` is
// truthy in JS — so an upstream response carrying an empty `gross_sellers`
// field alongside a populated `top_sellers` field had its real seller data
// silently discarded, both here and in the two other `||`-chained spots
// that fed the same top_sellers/gross_sellers fields.
test('bandarmologiService: normalizeBrokerSummary falls back to a populated top_sellers/top_buyers when gross_*/net_* is an empty array (not just missing)', () => {
  const rawEmptyGrossSellers = {
    stock_code: 'BBCA',
    date: '2026-09-04',
    gross_buyers: [], // also exercises the buyer-side symmetric bug
    top_buyers: [{ broker: 'YU', bval: 100, sval: 0, bvol: 10, svol: 0 }],
    gross_sellers: [], // <- present but empty, must not shadow top_sellers
    top_sellers: [{ broker: 'AK', bval: 46520000, sval: 53820000, bvol: 100, svol: 100 }]
  };

  const norm = bandarmologiService.normalizeBrokerSummary(rawEmptyGrossSellers, '2026-09-04');
  assert.equal(norm.gross_buyers.length, 1, 'an empty gross_buyers must fall back to top_buyers, not stay empty');
  assert.equal(norm.gross_buyers[0].broker, 'YU');
  assert.equal(norm.gross_sellers.length, 1, 'an empty gross_sellers must fall back to top_sellers, not stay empty');
  assert.equal(norm.gross_sellers[0].broker, 'AK');
  assert.equal(norm.gross_sellers[0].sval, 53820000);
});

test('bandarmologiService: aggregateBrokerSummaries also falls back correctly when a day\'s gross_sellers is an empty array', () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'arjum-cache-empty-gross-'));
  const origEnv = process.env.ARJUM_DATA_DIR;
  process.env.ARJUM_DATA_DIR = tmpBase;
  try {
    const ticker = 'EMPTYGROSS1';
    bandarmologiService.writeDiskCache('broker-summary', ticker, '2026-09-05', {
      stock_code: ticker,
      date: '2026-09-05',
      gross_sellers: [],
      top_sellers: [{ broker: 'AK', bval: 0, sval: 5000000, bvol: 0, svol: 50 }],
      gross_buyers: [],
      top_buyers: [{ broker: 'YU', bval: 8000000, sval: 0, bvol: 80, svol: 0 }]
    });

    const result = bandarmologiService.aggregateBrokerSummaries(ticker, ['2026-09-05']);
    const brokerCodes = result.gross_sellers.map(b => b.broker);
    assert.ok(brokerCodes.includes('AK'), 'AK must survive into the aggregated seller list, not be dropped because gross_sellers was []');
  } finally {
    if (origEnv !== undefined) process.env.ARJUM_DATA_DIR = origEnv;
    else delete process.env.ARJUM_DATA_DIR;
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

// Regression: normalizeBrokerSummary's "brokers" (unified per-broker) input
// shape derives grossBuyers AND grossSellers from the SAME full broker set
// (just re-sorted), unlike the other two input shapes where buy-side and
// sell-side lists are genuinely disjoint. net_flow must be computed by
// summing each broker's nval exactly once — never via a "total buyer net"
// minus "total seller net" that both iterate that same full set, which
// silently cancels a pure-accumulation or pure-distribution day to ~0.
test('bandarmologiService: normalizeBrokerSummary net_flow is not neutralized for single-broker "brokers" shape', () => {
  const pureBuyDay = {
    stock_code: 'BBCA',
    date: '2026-09-05',
    brokers: [
      { broker_code: 'YU', broker_name: 'CGS', bval: 100, sval: 0, bvol: 10, svol: 0, nval: 100, nvol: 10 }
    ]
  };
  const normBuy = bandarmologiService.normalizeBrokerSummary(pureBuyDay, '2026-09-05');
  assert.equal(normBuy.net_flow, 100, 'a single pure-buyer day must report its full net_flow, not cancel to 0');
  assert.equal(normBuy.net_status, 'BIG_ACCUMULATION');

  const pureSellDay = {
    stock_code: 'BBCA',
    date: '2026-09-06',
    brokers: [
      { broker_code: 'AK', broker_name: 'UBS', bval: 0, sval: 50, bvol: 0, svol: 5, nval: -50, nvol: -5 }
    ]
  };
  const normSell = bandarmologiService.normalizeBrokerSummary(pureSellDay, '2026-09-06');
  assert.equal(normSell.net_flow, -50, 'a single pure-seller day must report its full negative net_flow, not cancel to 0');
  assert.equal(normSell.net_status, 'BIG_DISTRIBUTION');
});

// Same regression, exercised through the two OTHER input shapes to confirm
// they were never affected (disjoint buy/sell lists, no aliasing).
test('bandarmologiService: normalizeBrokerSummary net_flow is correct for broker_levels and top_buyers/top_sellers shapes', () => {
  const levelsShape = {
    stock_code: 'BBCA',
    date: '2026-09-05',
    broker_levels: [
      { buy: { broker_code: 'YU', broker_name: 'CGS', bval: 100, bvol: 10 }, sell: { broker_code: 'AK', broker_name: 'UBS', sval: 40, svol: 4 } }
    ]
  };
  const normLevels = bandarmologiService.normalizeBrokerSummary(levelsShape, '2026-09-05');
  assert.equal(normLevels.net_flow, 60); // 100 (buy) - 40 (sell)
  assert.equal(normLevels.net_status, 'BIG_ACCUMULATION');

  const arraysShape = {
    stock_code: 'BBCA',
    date: '2026-09-05',
    top_buyers: [{ broker: 'YU', bval: 100, sval: 0, bvol: 10, svol: 0 }],
    top_sellers: [{ broker: 'AK', bval: 0, sval: 40, bvol: 0, svol: 4 }]
  };
  const normArrays = bandarmologiService.normalizeBrokerSummary(arraysShape, '2026-09-05');
  assert.equal(normArrays.net_flow, 60); // 100 (buy) - 40 (sell)
  assert.equal(normArrays.net_status, 'BIG_ACCUMULATION');
});

// Regression: header badge (net_label/net_status) must track the actual net
// flow direction, not get overridden by which list (buyer/seller) an item
// arrived in — the same class of bug fixed for the bubble visualization in
// PR #550 (isBuyerList overriding explicitNetVal).
test('bandarmologiService: normalizeBrokerSummary badge shows Big Distribution when sellers dominate', () => {
  const rawSellHeavy = {
    stock_code: 'BBCA',
    date: '2026-09-04',
    brokers: [
      { broker_code: 'YU', broker_name: 'CGS', bval: 20000, sval: 15000, bvol: 300, svol: 200, nval: 5000, nvol: 100 },
      { broker_code: 'AK', broker_name: 'UBS', bval: 10000, sval: 200000, bvol: 100, svol: 2500, nval: -190000, nvol: -2400 }
    ]
  };

  const norm = bandarmologiService.normalizeBrokerSummary(rawSellHeavy, '2026-09-04');
  assert.equal(norm.net_status, 'BIG_DISTRIBUTION');
  assert.equal(norm.net_label, 'Big Distribution');
  assert.ok(norm.net_flow < 0);
});

test('bandarmologiService: normalizeBrokerSummary badge respects explicit net_val even for pure seller items', () => {
  // Seller-side items reported with only net_val (no explicit sval) must not
  // have their sign flipped by an isBuyer-style override when computing the
  // net flow direction feeding the badge.
  const rawNetValOnly = {
    stock_code: 'BBCA',
    date: '2026-09-04',
    brokers: [
      { broker_code: 'YU', broker_name: 'CGS', net_val: 8000 },
      { broker_code: 'AK', broker_name: 'UBS', net_val: -50000 }
    ]
  };

  const norm = bandarmologiService.normalizeBrokerSummary(rawNetValOnly, '2026-09-04');
  assert.equal(norm.net_status, 'BIG_DISTRIBUTION');
  assert.equal(norm.net_label, 'Big Distribution');
});

// Regression: the "Lembar Saham" column in the Insider table always showed
// "–", while the neighboring "Perubahan %" column had real values. Root
// cause: Arjum's changes_value field can arrive as a thousand-separated
// string (e.g. "1,234,567"), and the client's formatNumber() runs
// `isNaN(num)` on whatever it's handed — which is true for a comma string —
// silently rendering "–" even though real data existed. pct_change is
// displayed as raw text (no numeric parsing), so it was unaffected and
// looked fine, making this look like a shares-only bug.
test('bandarmologiService: normalizeInsiders parses a comma-formatted changes_value instead of dropping it to "–"', () => {
  const raw = [
    { date: '2026-09-01', name: 'Budi', action_type: 'BUY', changes_value: '1,234,567', changes_percentage: '+0.0012%' },
    { date: '2026-09-02', name: 'Siti', action_type: 'SELL', changes_value: 500000, changes_percentage: '-0.0005%' },
    { date: '2026-09-03', name: 'Ali', action_type: 'BUY', changes_percentage: '+0.0001%' } // no shares field anywhere
  ];
  const normalized = bandarmologiService.normalizeInsiders(raw);
  assert.equal(normalized[0].shares, 1234567, 'a comma-formatted string must be parsed to a real number, not dropped');
  assert.equal(normalized[1].shares, 500000, 'a plain number must still work');
  assert.equal(normalized[2].shares, null, 'genuinely missing data must be null, not silently coerced to 0 (which would also render wrong)');
});

test('bandarmologiService: normalizeInsiders never fabricates a shares value out of garbage input', () => {
  const raw = [{ date: '2026-09-01', name: 'Test', action_type: 'BUY', changes_value: 'not-a-number', changes_percentage: '+0.001%' }];
  const normalized = bandarmologiService.normalizeInsiders(raw);
  assert.equal(normalized[0].shares, null, 'unparseable input must become null, never NaN or a garbage number');
});

test('bandarmologiService: normalizeBrokerAccumulation builds daily series per date', () => {
  const raw = {
    code: 'BBCA',
    series: [
      {
        broker_code: 'AK',
        points: [
          { date: '2026-09-03', nval: 10000000 },
          { date: '2026-09-04', nval: -5000000 }
        ]
      },
      {
        broker_code: 'YU',
        points: [
          { date: '2026-09-03', nval: 20000000 },
          { date: '2026-09-04', nval: 15000000 }
        ]
      }
    ]
  };

  const norm = bandarmologiService.normalizeBrokerAccumulation(raw, 'BBCA');
  assert.equal(norm.series.length, 2);
  assert.equal(norm.series[0].date, '2026-09-03');
  assert.equal(norm.series[0].net_val, 30000000);
  assert.equal(norm.series[1].date, '2026-09-04');
  assert.equal(norm.series[1].net_val, 10000000);
});

test('bandarmologiService: readDiskCache does NOT fallback to other dates when specific date identifier is missing', () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'arjum-cache-test-'));
  const testDir = path.join(tmpBase, 'broker-summary', 'TEST_TICKER');
  fs.mkdirSync(testDir, { recursive: true });

  // Save only 2026-08-03.json
  const fileData = { date: '2026-08-03', stock_code: 'TEST_TICKER', net_status: 'ACC' };
  fs.writeFileSync(path.join(testDir, '2026-08-03.json'), JSON.stringify(fileData));

  const origEnv = process.env.ARJUM_DATA_DIR;
  process.env.ARJUM_DATA_DIR = tmpBase;

  try {
    // 1. Exact existing date returns exact file
    const exact = bandarmologiService.readDiskCache('broker-summary', 'TEST_TICKER', '2026-08-03');
    assert.ok(exact, '2026-08-03 must exist');
    assert.equal(exact.date, '2026-08-03');
    assert.equal(bandarmologiService.hasDiskCache('broker-summary', 'TEST_TICKER', '2026-08-03'), true);

    // 2. Unsaved date MUST return null, NOT 2026-08-03
    const missing = bandarmologiService.readDiskCache('broker-summary', 'TEST_TICKER', '2026-08-04');
    assert.equal(missing, null, 'readDiskCache must return null for missing date, never return other dates as false fallback');
    assert.equal(bandarmologiService.hasDiskCache('broker-summary', 'TEST_TICKER', '2026-08-04'), false);

    // 3. Requesting 'latest' or omitting identifier falls back to newest available file
    const latest = bandarmologiService.readDiskCache('broker-summary', 'TEST_TICKER', 'latest');
    assert.ok(latest, 'latest can fall back to newest file');
    assert.equal(latest.date, '2026-08-03');
    assert.equal(bandarmologiService.hasDiskCache('broker-summary', 'TEST_TICKER', 'latest'), true);
  } finally {
    if (origEnv !== undefined) {
      process.env.ARJUM_DATA_DIR = origEnv;
    } else {
      delete process.env.ARJUM_DATA_DIR;
    }
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('bandarmologiService: getBandarmologiData(flow=F) fetches foreign-only data and reports foreign net buy', async () => {
  const origHasKey = arjumClient.hasArjumApiKey;
  const origFetchSummary = arjumClient.fetchBrokerSummary;
  const origFetchAcc = arjumClient.fetchBrokerAccumulation;
  const origFetchIns = arjumClient.fetchInsiders;

  arjumClient.hasArjumApiKey = () => true;
  arjumClient.fetchBrokerSummary = async (ticker, date, flow) => {
    assert.equal(flow, 'F');
    return {
      ok: true,
      data: {
        stock_code: ticker,
        date: '2026-09-05',
        top_buyers: [{ broker: 'FRGN', broker_name: 'Foreign Desk', bval: 9000000, sval: 1000000, bvol: 900, svol: 100 }],
        top_sellers: [{ broker: 'LOCL', broker_name: 'Local Desk', bval: 500000, sval: 500000, bvol: 50, svol: 50 }]
      }
    };
  };
  arjumClient.fetchBrokerAccumulation = async () => ({ ok: false });
  arjumClient.fetchInsiders = async () => ({ ok: false });

  try {
    const res = await bandarmologiService.getBandarmologiData('BBCA', { flow: 'F' });
    assert.equal(res.success, true);
    assert.equal(res.flow, 'F');
    assert.ok(res.broker_summary.net_flow > 0, 'foreign-buy-heavy summary must report positive net flow');
    assert.equal(res.broker_summary.net_status, 'BIG_ACCUMULATION');
  } finally {
    arjumClient.hasArjumApiKey = origHasKey;
    arjumClient.fetchBrokerSummary = origFetchSummary;
    arjumClient.fetchBrokerAccumulation = origFetchAcc;
    arjumClient.fetchInsiders = origFetchIns;
  }
});

test('bandarmologiService: getBandarmologiData(flow=D) fetches domestic-only data and reports domestic net sell', async () => {
  const origHasKey = arjumClient.hasArjumApiKey;
  const origFetchSummary = arjumClient.fetchBrokerSummary;
  const origFetchAcc = arjumClient.fetchBrokerAccumulation;
  const origFetchIns = arjumClient.fetchInsiders;

  arjumClient.hasArjumApiKey = () => true;
  arjumClient.fetchBrokerSummary = async (ticker, date, flow) => {
    assert.equal(flow, 'D');
    return {
      ok: true,
      data: {
        stock_code: ticker,
        date: '2026-09-05',
        top_buyers: [{ broker: 'LOCL', broker_name: 'Local Desk', bval: 500000, sval: 500000, bvol: 50, svol: 50 }],
        top_sellers: [{ broker: 'DOM', broker_name: 'Domestic Desk', bval: 1000000, sval: 9000000, bvol: 100, svol: 900 }]
      }
    };
  };
  arjumClient.fetchBrokerAccumulation = async () => ({ ok: false });
  arjumClient.fetchInsiders = async () => ({ ok: false });

  try {
    const res = await bandarmologiService.getBandarmologiData('BBCA', { flow: 'D' });
    assert.equal(res.success, true);
    assert.equal(res.flow, 'D');
    assert.ok(res.broker_summary.net_flow < 0, 'domestic-sell-heavy summary must report negative net flow');
    assert.equal(res.broker_summary.net_status, 'BIG_DISTRIBUTION');
  } finally {
    arjumClient.hasArjumApiKey = origHasKey;
    arjumClient.fetchBrokerSummary = origFetchSummary;
    arjumClient.fetchBrokerAccumulation = origFetchAcc;
    arjumClient.fetchInsiders = origFetchIns;
  }
});

test('bandarmologiService: getBandarmologiData with custom date range only aggregates dates inside the window', async () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'arjum-cache-custom-range-'));
  const origEnv = process.env.ARJUM_DATA_DIR;
  process.env.ARJUM_DATA_DIR = tmpBase;

  try {
    const ticker = 'CUSTOMR';
    // top_buyers/top_sellers as separate lists (the real Arjum broker-summary
    // shape) so each day's net_flow is unambiguous.
    bandarmologiService.writeDiskCache('broker-summary', ticker, '2026-08-01', {
      stock_code: ticker, date: '2026-08-01',
      top_buyers: [{ broker: 'YU', broker_name: 'Test Buyer', bval: 100, sval: 0, bvol: 10, svol: 0 }],
      top_sellers: []
    });
    bandarmologiService.writeDiskCache('broker-summary', ticker, '2026-08-15', {
      stock_code: ticker, date: '2026-08-15',
      top_buyers: [],
      top_sellers: [{ broker: 'AK', broker_name: 'Test Seller', bval: 0, sval: 50, bvol: 0, svol: 5 }]
    });
    bandarmologiService.writeDiskCache('broker-summary', ticker, '2026-08-31', {
      stock_code: ticker, date: '2026-08-31',
      top_buyers: [{ broker: 'ZP', broker_name: 'Outside Window', bval: 200, sval: 0, bvol: 20, svol: 0 }],
      top_sellers: []
    });

    // Window covers only 08-01 and 08-15, excludes 08-31.
    const res = await bandarmologiService.getBandarmologiData(ticker, { range: 'custom', startDate: '2026-08-01', endDate: '2026-08-20' });
    assert.equal(res.success, true);
    assert.equal(res.broker_summary.net_flow, 50); // 100 (08-01) - 50 (08-15), 08-31 excluded

    // Window with no matching dates on disk must not fall back to demo/live data.
    const empty = await bandarmologiService.getBandarmologiData(ticker, { range: 'custom', startDate: '2020-01-01', endDate: '2020-01-31' });
    assert.equal(empty.success, true);
    assert.equal(empty.is_demo, false);
    assert.equal(empty.broker_summary.net_status, 'NO_DATA');
    assert.equal(empty.broker_summary.top_buyers.length, 0);
  } finally {
    if (origEnv !== undefined) {
      process.env.ARJUM_DATA_DIR = origEnv;
    } else {
      delete process.env.ARJUM_DATA_DIR;
    }
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('bandarmologiService: aggregateBrokerSummaries sums transaction metrics across multiple dates', () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'arjum-agg-test-'));
  const testDir = path.join(tmpBase, 'broker-summary', 'TEST_AGGR');
  fs.mkdirSync(testDir, { recursive: true });

  // Day 1
  const day1 = {
    date: '2026-08-01',
    stock_code: 'TEST_AGGR',
    gross_buyers: [{ broker: 'YP', broker_name: 'Mirae', bval: 100, sval: 20, bvol: 10, svol: 2, bfrq: 5, sfrq: 1 }],
    gross_sellers: [{ broker: 'CC', broker_name: 'Mandiri', bval: 10, sval: 80, bvol: 1, svol: 8, bfrq: 1, sfrq: 4 }],
    net_flow: 50
  };
  // Day 2
  const day2 = {
    date: '2026-08-02',
    stock_code: 'TEST_AGGR',
    gross_buyers: [{ broker: 'YP', broker_name: 'Mirae', bval: 150, sval: 30, bvol: 15, svol: 3, bfrq: 6, sfrq: 2 }],
    gross_sellers: [{ broker: 'CC', broker_name: 'Mandiri', bval: 20, sval: 120, bvol: 2, svol: 12, bfrq: 2, sfrq: 6 }],
    net_flow: 70
  };

  fs.writeFileSync(path.join(testDir, '2026-08-01.json'), JSON.stringify(day1));
  fs.writeFileSync(path.join(testDir, '2026-08-02.json'), JSON.stringify(day2));

  const origEnv = process.env.ARJUM_DATA_DIR;
  process.env.ARJUM_DATA_DIR = tmpBase;

  try {
    const agg = bandarmologiService.aggregateBrokerSummaries('TEST_AGGR', ['2026-08-02', '2026-08-01']);
    assert.ok(agg, 'Aggregated result must exist');
    assert.equal(agg.range_days, 2);
    assert.equal(agg.net_flow, 120);

    const yp = agg.gross_buyers.find(b => b.broker === 'YP');
    assert.ok(yp, 'YP must be present in gross_buyers');
    assert.equal(yp.bval, 250); // 100 + 150
    assert.equal(yp.sval, 50);  // 20 + 30
    assert.equal(yp.bvol, 25);  // 10 + 15
    assert.equal(yp.svol, 5);   // 2 + 3
    assert.equal(yp.bfrq, 11);  // 5 + 6
    assert.equal(yp.sfrq, 3);   // 1 + 2
    assert.equal(yp.nval, 200); // 250 - 50
  } finally {
    if (origEnv !== undefined) {
      process.env.ARJUM_DATA_DIR = origEnv;
    } else {
      delete process.env.ARJUM_DATA_DIR;
    }
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("bandarmologiService: normalizeBrokerSummary preserves Arjum sellers aliases when a partial payload also has buyer fields", () => {
  const norm = bandarmologiService.normalizeBrokerSummary({
    stock_code: "BBCA",
    date: "2026-09-04",
    gross_buyers: [{ broker: "YU", bval: 10000000, sval: 0, bvol: 100, svol: 0 }],
    net_buyers: [{ broker: "YU", nval: 10000000, nvol: 100 }],
    sellers: [{ broker: "AK", bval: 0, sval: 9000000, bvol: 0, svol: 90 }],
    net_sellers: []
  }, "2026-09-04");

  assert.equal(norm.gross_sellers.length, 1, "the sellers alias must populate Full / Gross sellers");
  assert.equal(norm.gross_sellers[0].broker, "AK");
  assert.equal(norm.net_sellers.length, 1, "an empty net_sellers must fall back to real seller rows");
  assert.equal(norm.net_sellers[0].nval, -9000000);
});

test("bandarmologiService: GPRA 2026-09-04 regression: top sellers never clone top buyers and sellers have negative net value", () => {
  const gpraRaw = {
    stock_code: "GPRA",
    date: "2026-09-04",
    gross_buyers: [
      { broker: "XL", bval: 823600000, sval: 0, bvol: 82360, svol: 0 },
      { broker: "CP", bval: 383200000, sval: 0, bvol: 38320, svol: 0 },
      { broker: "KK", bval: 311900000, sval: 0, bvol: 31190, svol: 0 },
      { broker: "XC", bval: 242700000, sval: 0, bvol: 24270, svol: 0 }
    ],
    gross_sellers: [], // empty from upstream API/disk
    net_buyers: [
      { broker: "XL", nval: 823600000, nvol: 82360 },
      { broker: "CP", nval: 383200000, nvol: 38320 },
      { broker: "KK", nval: 311900000, nvol: 31190 },
      { broker: "XC", nval: 242700000, nvol: 24270 }
    ],
    net_sellers: [], // empty from upstream API/disk
    top_buyers: [
      { broker: "XL", bval: 823600000, sval: 0, bvol: 82360, svol: 0 },
      { broker: "CP", bval: 383200000, sval: 0, bvol: 38320, svol: 0 }
    ],
    top_sellers: [
      { broker: "MG", bval: 0, sval: 1600000000, bvol: 0, svol: 160000 },
      { broker: "CC", bval: 0, sval: 693900000, bvol: 0, svol: 69390 },
      { broker: "AK", bval: 0, sval: 299100000, bvol: 0, svol: 29910 },
      { broker: "ZP", bval: 0, sval: 107100000, bvol: 0, svol: 10710 },
      { broker: "BK", bval: 0, sval: 67700000, bvol: 0, svol: 6770 },
      { broker: "BQ", bval: 0, sval: 23500000, bvol: 0, svol: 2350 },
      { broker: "PD", bval: 0, sval: 17700000, bvol: 0, svol: 1770 },
      { broker: "AZ", bval: 0, sval: 8700000, bvol: 0, svol: 870 }
    ]
  };

  const norm = bandarmologiService.normalizeBrokerSummary(gpraRaw, "2026-09-04");

  assert.ok(norm, "must return normalized summary");
  assert.equal(norm.gross_sellers.length, 8, "empty gross_sellers must populate from top_sellers");
  assert.equal(norm.top_sellers.length, 8);
  assert.equal(norm.top_sellers[0].broker, "MG", "top seller must be MG, not XL or CP");
  assert.notEqual(norm.top_sellers[0].broker, norm.top_buyers[0].broker);
  assert.ok(norm.top_sellers.every(s => s.broker !== "XL" && s.broker !== "CP"), "sellers must not clone buyers");

  assert.equal(norm.net_sellers.length, 8, "net_sellers must populate real sellers");
  assert.equal(norm.net_sellers[0].broker, "MG");
  assert.equal(norm.net_sellers[0].nval, -1600000000, "MG net value must be negative");
  assert.equal(norm.net_sellers[1].broker, "CC");
  assert.equal(norm.net_sellers[1].nval, -693900000, "CC net value must be negative");
});
