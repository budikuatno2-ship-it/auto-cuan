'use strict';

/**
 * Unit tests for price-below-bandar-cost fix:
 * - getCachedClosePrice does NOT fall back to broker hunter avg_price (circular reference fix)
 * - S1 resolves genuine market price (via live VPS fetch or OHLCV cache) or NO_CURRENT_PRICE
 * - When currentPrice is resolved or provided via options, discountPct is calculated correctly (not fake 0)
 * - bandar_avg_buy is always present and never artificially identical to current_price
 * - Frontend renderBandarmologiIntelUI gracefully handles both price states
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const intelService = require('../lib/bandarmologi-intel-service');

test('FASE 5 fix: detectPriceBelowBandarCost resolves genuine market price or reports NO_CURRENT_PRICE', () => {
  const res = intelService.detectPriceBelowBandarCost('BBCA', { range: '7d' });

  assert.equal(res.signal_key, 'HARGA_DI_BAWAH_MODAL_BANDAR');
  assert.ok(typeof res.bandar_avg_buy === 'number' && res.bandar_avg_buy > 0,
    'bandar_avg_buy should be a positive number, got ' + res.bandar_avg_buy);
  assert.equal(res.bandar_avg_price, res.bandar_avg_buy);
  assert.equal(res.broker_cost, res.bandar_avg_buy);
  assert.equal(res.harga_modal, res.bandar_avg_buy);

  if (res.current_price != null) {
    // Market price successfully resolved from live VPS fetch or OHLCV cache
    assert.ok(res.current_price > 0, 'current_price must be > 0 when resolved, got ' + res.current_price);
    // CRITICAL: Must not equal broker buy average (the old circular-reference bug)
    assert.notEqual(res.current_price, res.bandar_avg_buy,
      'current_price must NOT equal bandar_avg_buy (circular reference bug prevented)');
    assert.ok(typeof res.discount_pct === 'number', 'discount_pct must be calculated when price resolved');
  } else {
    // When market price cannot be resolved anywhere
    assert.equal(res.reason, 'NO_CURRENT_PRICE');
    assert.equal(res.discount_pct, null);
  }

  assert.ok(Array.isArray(res.top_3_brokers), 'top_3_brokers is array');
  assert.ok(res.top_3_brokers.length > 0, 'top_3_brokers has elements');
  assert.ok(Array.isArray(res.top_broker_details), 'top_broker_details is array');
  assert.ok(Array.isArray(res.top_brokers), 'top_brokers is array');
});

test('FASE 5 fix: detectPriceBelowBandarCost calculates real discount when currentPrice injected via options', () => {
  // BBCA bandar cost in dataset is ~6629, so price 6000 is genuinely below bandar cost
  const injectedPrice = 6000;

  const res = intelService.detectPriceBelowBandarCost('BBCA', {
    range: '7d',
    currentPrice: injectedPrice
  });

  assert.equal(res.signal_key, 'HARGA_DI_BAWAH_MODAL_BANDAR');
  assert.equal(res.current_price, injectedPrice, 'current_price should be ' + injectedPrice);
  assert.ok(res.bandar_avg_buy > 0, 'bandar_avg_buy should be > 0');
  assert.ok(typeof res.discount_pct === 'number', 'discount_pct should be a number');
  assert.notEqual(res.discount_pct, 0, 'discount_pct must NOT be 0 when price differs from bandar cost');
  assert.ok(res.discount_pct > 0, 'discount_pct should be positive (price below bandar cost), got ' + res.discount_pct);
  assert.notEqual(res.current_price, res.bandar_avg_buy,
    'current_price must NOT equal bandar_avg_buy (that was the circular-reference bug)');
});

test('FASE 5 fix: detectPriceBelowBandarCost reports above-bandar-cost correctly', () => {
  const highPrice = 12000;
  const res = intelService.detectPriceBelowBandarCost('BBCA', {
    range: '7d',
    currentPrice: highPrice
  });

  assert.equal(res.current_price, highPrice);
  assert.ok(res.discount_pct < 0, 'discount_pct should be negative when price is above bandar cost, got ' + res.discount_pct);
  assert.equal(res.in_sweet_spot, false, 'Should NOT be in sweet spot when price above bandar cost');
});

test('FASE 5 fix: evaluateBandarmologiIntelForTicker resolves all 4 signals for BMRI', () => {
  const evalResult = intelService.evaluateBandarmologiIntelForTicker('BMRI', { range: '7d' });

  assert.equal(evalResult.ticker, 'BMRI');
  assert.ok(evalResult.signals, 'signals exists');

  const s1 = evalResult.signals.harga_di_bawah_modal_bandar;
  assert.ok(s1, 'Signal 1 exists');
  assert.ok(s1.signal_key === 'HARGA_DI_BAWAH_MODAL_BANDAR', 'Signal 1 key is correct');
  assert.ok(s1.bandar_avg_buy > 0, 'BMRI bandar_avg_buy > 0');

  const s3 = evalResult.signals.ritel_cutloss_vs_bandar;
  assert.ok(s3, 'Signal 3 exists');
  assert.ok(Array.isArray(s3.top_buyers), 'Signal 3 top_buyers exists');
  assert.ok(Array.isArray(s3.top_sellers), 'Signal 3 top_sellers exists');

  const s4 = evalResult.signals.concentration_ratio;
  assert.ok(s4, 'Signal 4 exists');
  assert.ok(typeof s4.cr3 === 'number', 'CR3 is number');
});

test('FASE 5 fix: Frontend renderBandarmologiIntelUI handles NO_CURRENT_PRICE gracefully', () => {
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

  const evalResult = intelService.evaluateBandarmologiIntelForTicker('BBCA');
  const realIntelData = {
    success: true,
    ticker: 'BBCA',
    result: evalResult
  };

  assert.doesNotThrow(() => {
    sandbox.window.BandarmologiRuntime.renderBandarmologiIntelUI(elements.bandarmologiContent, realIntelData);
  }, 'renderBandarmologiIntelUI must not throw on NO_CURRENT_PRICE');

  const html = elements.bandarmologiContent.innerHTML;
  assert.ok(html.length > 0, 'HTML output is non-empty');

  const s1 = evalResult.signals && evalResult.signals.harga_di_bawah_modal_bandar;
  if (s1 && s1.top_brokers && s1.top_brokers.length > 0) {
    assert.ok(html.includes(s1.top_brokers[0]), 'Renders top broker chip: ' + s1.top_brokers[0]);
  }
});
