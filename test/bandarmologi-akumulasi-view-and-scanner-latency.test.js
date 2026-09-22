'use strict';

/**
 * Regression coverage for the three Bandarmologi & Sinyal Intelijen UI defects:
 *
 *  1. Akumulasi Broker must default to "Tabel Rinci" and must never mount the
 *     bubble cluster container (AK -205M / YU +118M) while view === 'table'.
 *  2. reconcileScannerLivePrices must resolve prices from LOCAL memory/cache only
 *     (no per-ticker network round-trip) so the scanner answers in < 2s.
 *  3. Top Buyers / Top Sellers rows must resolve NET VOL / NET VAL through the full
 *     fallback chain and never print a literal "+0".
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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
    window: { location: { href: 'https://example.test/analisis-saham?tab=summary' } },
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
// FIX 1 — Akumulasi Broker default view + hidden bubble cluster
// ---------------------------------------------------------------------------

test('FIX1: setBandarSection("akumulasi") forces the default view to table', () => {
  const { api } = bootRuntime();
  api.setBrokerAccumulationView('bubble');
  assert.equal(api.getBrokerAccumulationView(), 'bubble', 'precondition: bubble selected');

  api.setBandarSection('akumulasi');
  assert.equal(api.getBrokerAccumulationView(), 'table',
    'entering Akumulasi Broker must reset the view to table');
});

test('FIX1: TAMPILAN pill highlights "Tabel Rinci" and clears "Visual Bubble"', () => {
  const bubbleBtn = makeEl('toggleAccViewBubble');
  const tableBtn = makeEl('toggleAccViewTable');
  bubbleBtn.className = 'px-2.5 py-1 rounded-md transition bg-emerald-500 text-dark-900 shadow-sm font-bold';

  const { api } = bootRuntime({
    toggleAccViewBubble: bubbleBtn,
    toggleAccViewTable: tableBtn
  });

  api.setBandarSection('akumulasi');

  assert.ok(!bubbleBtn.className.includes('bg-emerald-500'),
    'Visual Bubble pill must lose the active highlight');
  assert.equal(bubbleBtn.attributes['aria-pressed'], 'false');
  assert.ok(tableBtn.className.includes('bg-emerald-500'),
    'Tabel Rinci pill must carry the active highlight');
  assert.equal(tableBtn.attributes['aria-pressed'], 'true');
});

test('FIX1: Akumulasi table view renders NO bubble cluster container', () => {
  const { api, elements } = bootRuntime();
  const data = {
    ticker: 'TEST',
    broker_summary: {
      date: '2026-09-11',
      net_flow: 1200000000,
      top_buyers: [{ broker: 'AK', bval: 5000000000, sval: 5205000000, bvol: 1000, svol: 1041 }],
      top_sellers: [{ broker: 'YU', bval: 100000000, sval: 1180000000, bvol: 20, svol: 236 }]
    },
    broker_accumulation: {
      top_buyers: [{ broker: 'AK', bval: 5000000000, sval: 5205000000, bvol: 1000, svol: 1041 }],
      top_sellers: [{ broker: 'YU', bval: 100000000, sval: 1180000000, bvol: 20, svol: 236 }]
    }
  };

  api.setBandarSection('akumulasi');
  api.renderBandarmologiUI(elements.bandarmologiContent, data);
  const html = elements.bandarmologiContent.innerHTML;

  assert.ok(html.length > 0, 'Akumulasi must render content');
  assert.ok(!/class="ac-broker-bubble/.test(html),
    'no .ac-broker-bubble element may be emitted in Akumulasi table view');
  assert.ok(html.includes('id="acAccBubbleClusterWrap"'),
    'an explicit (hidden) bubble wrapper placeholder must exist');
  assert.ok(/id="acAccBubbleClusterWrap"[^>]*display:none/.test(html),
    'the bubble wrapper placeholder must be display:none');
});

test('FIX1: metric cards and the cumulative table stay visible in Akumulasi', () => {
  const { api, elements } = bootRuntime();
  const data = {
    ticker: 'TEST',
    broker_summary: {
      date: '2026-09-11',
      net_flow: 1200000000,
      top_buyers: [{ broker: 'AK', bval: 5000000000, sval: 5205000000, bvol: 1000, svol: 1041 }],
      top_sellers: [{ broker: 'YU', bval: 100000000, sval: 1180000000, bvol: 20, svol: 236 }]
    }
  };

  api.setBandarSection('akumulasi');
  api.renderBandarmologiUI(elements.bandarmologiContent, data);
  const html = elements.bandarmologiContent.innerHTML;

  assert.ok(html.includes('Concentration Ratio (CR)'), 'CR metric card must render');
  assert.ok(html.includes('Status Dominasi Pasar'), 'dominance card must render');
  assert.ok(html.includes('Partisipasi Bandar vs Ritel'), 'participation card must render');
  assert.ok(html.includes('Riwayat Harian'), 'cumulative daily table must render');
});

// ---------------------------------------------------------------------------
// FIX 3 — NET VOL / NET VAL never render as a literal "+0"
// ---------------------------------------------------------------------------

test('FIX3: rows carrying only bval/sval render real NET VOL and NET VAL', () => {
  const { api, elements } = bootRuntime();
  const data = {
    ticker: 'TEST',
    broker_summary: {
      date: '2026-09-11',
      net_flow: 0,
      // YU / DX / ZP / AK / BK / RX style rows: no explicit net_val / net_vol.
      top_buyers: [
        { broker: 'YU', bval: 1180000000, sval: 100000000, bvol: 236, svol: 20 },
        { broker: 'DX', bval: 900000000, sval: 150000000, bvol: 180, svol: 30 }
      ],
      top_sellers: [
        { broker: 'AK', bval: 100000000, sval: 5205000000, bvol: 20, svol: 1041 },
        { broker: 'BK', bval: 50000000, sval: 2050000000, bvol: 10, svol: 410 }
      ]
    }
  };

  api.setBandarSection('akumulasi');
  api.renderBandarmologiUI(elements.bandarmologiContent, data);
  const html = elements.bandarmologiContent.innerHTML;

  assert.ok(html.includes('TOP BUYERS'), 'Top Buyers table must render');
  assert.ok(html.includes('TOP SELLERS'), 'Top Sellers table must render');

  // YU net = 1.08B -> must be a real figure, never "+0".
  assert.ok(html.includes('1.08 M'),
    'YU NET VAL must resolve to a real magnitude (1.08 M)');

  // Scope the check to the broker tables only: the daily-history table has its
  // own zero-day semantics and is not part of this defect.
  const brokerTables = html.slice(html.indexOf('TOP BUYERS'), html.indexOf('Riwayat Harian'));
  assert.ok(brokerTables.length > 0, 'broker table segment must exist');
  assert.equal(brokerTables.match(/>\+0</g), null,
    'a bare "+0" cell must never be emitted for broker rows');
});

test('FIX3: rows carrying only txVal/txVol still resolve a non-zero NET VAL', () => {
  const { api, elements } = bootRuntime();
  const data = {
    ticker: 'TEST',
    broker_summary: { date: '2026-09-11', net_flow: 0 },
    broker_accumulation: {
      // Bubble-style items: magnitude lives in txVal / txVol only.
      top_buyers: [{ broker: 'ZP', txVal: 750000000, txVol: 150000 }],
      top_sellers: [{ broker: 'RX', txVal: 430000000, txVol: 86000 }]
    }
  };

  api.setBandarSection('akumulasi');
  api.renderBandarmologiUI(elements.bandarmologiContent, data);
  const html = elements.bandarmologiContent.innerHTML;

  assert.ok(html.includes('TOP BUYERS'), 'Top Buyers table must render');

  const brokerTables = html.slice(html.indexOf('TOP BUYERS'), html.indexOf('Riwayat Harian'));
  assert.ok(brokerTables.length > 0, 'broker table segment must exist');
  assert.equal(brokerTables.match(/>\+0</g), null,
    'txVal-only rows must not degrade to "+0"');
  assert.ok(html.includes('750 Jt') || html.includes('0.75 M'),
    'ZP NET VAL must resolve from txVal (750 Jt / 0.75 M)');
});

// ---------------------------------------------------------------------------
// FIX 2 — scanner reconciliation is local/memory only
// ---------------------------------------------------------------------------

test('FIX2: reconcileScannerLivePrices resolves prices without per-ticker network calls', () => {
  const intelSource = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'bandarmologi-intel-service.js'),
    'utf8'
  );

  assert.ok(intelSource.includes('SCANNER_LIVE_PRICE_MEMORY'),
    'a module-level live-price memory map must exist');
  assert.ok(intelSource.includes('function getBulkScannerLivePrice'),
    'a bulk local resolver must exist');
  assert.ok(!/realPrice = getCachedClosePrice\(clean\)/.test(intelSource),
    'the per-ticker getCachedClosePrice() network path must not be used in reconcile');

  const body = intelSource.slice(
    intelSource.indexOf('function reconcileScannerLivePrices'),
    intelSource.indexOf('async function getBandarmologiIntel')
  );
  assert.ok(!/fetchLivePriceFromVpsSync|fetchOhlcvFromVpsSync/.test(body),
    'reconcile must not trigger a VPS sync per ticker');
  assert.ok(body.includes('deadlineAt'), 'a wall-clock budget guard must exist');
});

test('FIX2: the intel bridge probe is memoised so repeat requests skip the network', () => {
  const intelSource = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'bandarmologi-intel-service.js'),
    'utf8'
  );
  assert.ok(intelSource.includes('INTEL_BRIDGE_CACHE'),
    'the blocking bridge probe must be memoised');
  assert.ok(intelSource.includes('INTEL_BRIDGE_OK_TTL_MS'),
    'a success TTL must be defined');
  assert.ok(intelSource.includes('INTEL_BRIDGE_FAIL_TTL_MS'),
    'a failure TTL must be defined');
});

test('FIX2: warm getBandarmologiIntel calls answer well under 2 seconds', async () => {
  // Hermetic: an unroutable bridge (fails fast) + a baked index on a temp dir,
  // mirroring a cold CI runner where no live VPS bridge is reachable.
  const os = require('node:os');
  const bakedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intel-latency-'));
  fs.writeFileSync(path.join(bakedDir, 'latest_7d.json'), JSON.stringify({
    updated_at: '2026-09-12T16:57:26.353Z',
    effective_date: '2026-09-11',
    date: '2026-09-11',
    total_evaluated: 1,
    indexes: {
      harga_di_bawah_modal_bandar: [{ ticker: 'LAT', current_price: 100, bandar_avg_buy: 120 }],
      silent_foreign_accumulation: [], ritel_cutloss_bandar_nampung: [],
      distribusi_ke_ritel: [], cr3_massive: []
    }
  }), 'utf8');

  const prevDir = process.env.INTEL_INDEX_DIR;
  const prevBase = process.env.VPS_DATA_API_BASE;
  process.env.INTEL_INDEX_DIR = bakedDir;
  process.env.VPS_DATA_API_BASE = 'http://127.0.0.1:1'; // unroutable, fails fast

  try {
    const intel = require('../lib/bandarmologi-intel-service');
    // The first call may probe the (unroutable) bridge once; afterwards the
    // failure TTL must prevent any further network attempt.
    await intel.getBandarmologiIntel({ range: '7d' });

    const samples = [];
    for (let i = 0; i < 3; i++) {
      const started = Date.now();
      const payload = await intel.getBandarmologiIntel({ range: '7d' });
      samples.push(Date.now() - started);
      assert.ok(payload && typeof payload.data_source === 'string',
        'the payload must always declare its data source');
    }

    const worst = Math.max.apply(null, samples);
    assert.ok(worst < 2000,
      `warm scanner responses must stay under 2s (worst=${worst}ms)`);
  } finally {
    process.env.INTEL_INDEX_DIR = prevDir;
    process.env.VPS_DATA_API_BASE = prevBase;
    try { fs.rmSync(bakedDir, { recursive: true, force: true }); } catch (_) {}
  }
});
