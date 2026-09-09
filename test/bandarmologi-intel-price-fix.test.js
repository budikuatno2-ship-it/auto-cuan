'use strict';

/**
 * Unit tests for FASE 5 fix:
 * - Bandarmologi Intel S1 signal resolves real current_price and broker_cost / bandar_avg_buy
 * - Evaluates correctly using persistent broker-hunter indexes without returning "NO_DATA" or "—"
 * - Frontend renderBandarmologiIntelUI renders real formatted price strings and broker badges
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const intelService = require('../lib/bandarmologi-intel-service');

test('FASE 5: detectPriceBelowBandarCost returns non-zero real price and broker cost for BBCA', () => {
  const res = intelService.detectPriceBelowBandarCost('BBCA', { range: '7d' });

  assert.equal(res.signal_key, 'HARGA_DI_BAWAH_MODAL_BANDAR');
  assert.equal(typeof res.current_price, 'number');
  assert.ok(res.current_price > 0, `current_price should be > 0, got ${res.current_price}`);

  // Checks both primary and alias fields
  assert.equal(typeof res.bandar_avg_buy, 'number');
  assert.ok(res.bandar_avg_buy > 0, `bandar_avg_buy should be > 0, got ${res.bandar_avg_buy}`);
  assert.equal(res.bandar_avg_price, res.bandar_avg_buy);
  assert.equal(res.broker_cost, res.bandar_avg_buy);
  assert.equal(res.harga_modal, res.bandar_avg_buy);

  // Checks sweet spot flags
  assert.equal(typeof res.in_sweet_spot, 'boolean');
  assert.equal(res.is_sweet_spot, res.in_sweet_spot);

  // Checks top brokers
  assert.ok(Array.isArray(res.top_3_brokers), 'top_3_brokers is array');
  assert.ok(res.top_3_brokers.length > 0, 'top_3_brokers has elements');
  assert.ok(Array.isArray(res.top_broker_details), 'top_broker_details is array');
  assert.ok(Array.isArray(res.top_brokers), 'top_brokers is array');
});

test('FASE 5: evaluateBandarmologiIntelForTicker resolves all 4 signals with real data for BMRI', () => {
  const evalResult = intelService.evaluateBandarmologiIntelForTicker('BMRI', { range: '7d' });

  assert.equal(evalResult.ticker, 'BMRI');
  assert.ok(evalResult.signals, 'signals exists');

  const s1 = evalResult.signals.harga_di_bawah_modal_bandar;
  assert.ok(s1, 'Signal 1 exists');
  assert.ok(s1.current_price > 0, 'BMRI current_price > 0');
  assert.ok(s1.bandar_avg_buy > 0, 'BMRI bandar_avg_buy > 0');

  const s3 = evalResult.signals.ritel_cutloss_vs_bandar;
  assert.ok(s3, 'Signal 3 exists');
  assert.ok(Array.isArray(s3.top_buyers), 'Signal 3 top_buyers exists');
  assert.ok(Array.isArray(s3.top_sellers), 'Signal 3 top_sellers exists');

  const s4 = evalResult.signals.concentration_ratio;
  assert.ok(s4, 'Signal 4 exists');
  assert.ok(typeof s4.cr3 === 'number', 'CR3 is number');
});

test('FASE 5: Frontend renderBandarmologiIntelUI displays real prices and no em-dash in S1 card', () => {
  const runtimeSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'bandarmologi-runtime.js'), 'utf8');

  const elements = {
    bandarmologiContent: { innerHTML: '' },
    subTabBrokerSummary: { classList: { toggle() {} }, setAttribute() {} },
    subTabAkumulasiBroker: { classList: { toggle() {} }, setAttribute() {} },
    subTabIntelBandar: { classList: { toggle() {} }, setAttribute() {} },
    tabBandarmologi: { classList: { toggle() {} }, setAttribute() {} },
    bandarPanelTitle: { textContent: '' },
    bandarActiveTickerTag: { textContent: '' }
  };

  const sandbox = {
    window: {},
    document: {
      getElementById: (id) => elements[id] || null,
      head: { appendChild() {} }
    },
    URL,
    Intl,
    Date,
    console
  };
  sandbox.window.BandarmologiRuntime = {};
  sandbox.globalThis = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(runtimeSource, sandbox);

  const realIntelData = {
    success: true,
    ticker: 'BBCA',
    result: intelService.evaluateBandarmologiIntelForTicker('BBCA')
  };

  sandbox.window.BandarmologiRuntime.renderBandarmologiIntelUI(elements.bandarmologiContent, realIntelData);
  const html = elements.bandarmologiContent.innerHTML;

  // Verify S1 card contains formatted real price
  const s1 = realIntelData.result.signals.harga_di_bawah_modal_bandar;
  const expectedPrice = Math.round(s1.current_price || s1.close_price).toLocaleString('id-ID');
  assert.ok(html.includes(`Rp ${expectedPrice}`) || html.includes(`Rp${expectedPrice}`), `HTML renders Rp ${expectedPrice} for BBCA`);

  // Verify the S1 metric section does NOT contain '—' (em-dash placeholder)
  const card1Match = html.match(/id="intelCardHargaModal"[\s\S]*?id="intelCardSilentForeign"/);
  assert.ok(card1Match, 'Card 1 exists in rendered output');
  const card1Html = card1Match[0];
  assert.ok(!card1Html.includes('>—<'), 'Card 1 metric boxes do NOT contain empty em-dash placeholder');

  // Verify top broker codes are rendered as chips
  for (const b of (s1.top_brokers || [])) {
    assert.ok(card1Html.includes(b), `Renders ${b} chip`);
  }
});
