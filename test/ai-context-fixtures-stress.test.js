'use strict';

// ===========================================================================
// DETERMINISTIC FIXTURES FOR WHAT THE MODEL IS ACTUALLY HANDED.
//
// The AI-facing context is the whole product surface here: whatever these
// builders emit is what the model believes. Two properties matter and are
// asserted per fixture:
//
//   1. Nothing is invented. Every numeric value in the context must be traceable
//      to the fixture that produced it, and an absent field must stay absent
//      rather than becoming 0.
//   2. Nothing is upgraded. A screener state that means "watch this" must not
//      arrive looking like a state that means "this is confirmed".
//
// These call the real builders from lib/context-ai-router-v4.js and
// lib/ai-context-snapshot-store.js. No trading rule, threshold, score or
// confirmation contract is evaluated here — only how existing values travel.
//
// LOCAL / STATIC ONLY.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// The router pulls in @supabase/supabase-js at module load; it is never called
// on any path these fixtures exercise.
const supabasePath = require.resolve('@supabase/supabase-js');
if (!require.cache[supabasePath]) {
  require.cache[supabasePath] = {
    id: supabasePath, filename: supabasePath, loaded: true, paths: [],
    exports: { createClient() { throw new Error('supabase must not be reached by a fixture test'); } }
  };
}

const router = require(path.join(ROOT, 'lib/context-ai-router-v4.js'));
const store = require(path.join(ROOT, 'lib/ai-context-snapshot-store.js'));
const { portfolioContext, stockContext, priceFreshness, number } = router._test;

function numericTokens(value) {
  return String(JSON.stringify(value)).match(/-?\d+(?:\.\d+)?/g) || [];
}

// ========================= PORTFOLIO AI FIXTURES =========================

const PORTFOLIO_FIXTURES = {
  'zero positions': { plans: [], prices: {} },
  'one position, complete': {
    plans: [{ ticker: 'BBCA', entryPriceIdr: 9000, stopLossIdr: 8600, tp1Idr: 9800, tp2Idr: 10200, lots: 5, estimatedMaxLossIdr: 200000, capitalIdr: 4500000 }],
    prices: { BBCA: 9150 },
    price_meta: { BBCA: { at: '2026-08-13T09:00:00Z', age_minutes: 3 } }
  },
  'three positions, mixed completeness': {
    plans: [
      { ticker: 'BBCA', entryPriceIdr: 9000, stopLossIdr: 8600, lots: 5, estimatedMaxLossIdr: 200000, capitalIdr: 4500000 },
      { ticker: 'TLKM', entryPriceIdr: 3000, stopLossIdr: null, lots: 10, estimatedMaxLossIdr: null, capitalIdr: 3000000 },
      { ticker: 'ASII', entryPriceIdr: 5000, stopLossIdr: 4800, lots: 2, estimatedMaxLossIdr: 40000, capitalIdr: null }
    ],
    prices: { BBCA: 9150, TLKM: 2600 },
    price_meta: { BBCA: { at: '2026-08-13T09:00:00Z', age_minutes: 2 }, TLKM: { at: '2026-08-06T09:00:00Z', age_minutes: 10080 } }
  },
  'negative P/L and a high-risk position': {
    plans: [
      { ticker: 'GOTO', entryPriceIdr: 100, stopLossIdr: 80, lots: 500, estimatedMaxLossIdr: 1000000, capitalIdr: 5000000 },
      { ticker: 'BUMI', entryPriceIdr: 200, stopLossIdr: 150, lots: 200, estimatedMaxLossIdr: 1000000, capitalIdr: 4000000 }
    ],
    prices: { GOTO: 72, BUMI: 140 },
    price_meta: { GOTO: { at: '2026-08-13T09:00:00Z', age_minutes: 1 }, BUMI: { at: '2026-08-13T09:00:00Z', age_minutes: 1 } }
  },
  'no stop loss anywhere': {
    plans: [
      { ticker: 'BBCA', entryPriceIdr: 9000, lots: 5, capitalIdr: 4500000 },
      { ticker: 'TLKM', entryPriceIdr: 3000, lots: 10, capitalIdr: 3000000 }
    ],
    prices: { BBCA: 9150, TLKM: 2950 }
  },
  'large nominal values': {
    plans: [{ ticker: 'BBRI', entryPriceIdr: 4500, stopLossIdr: 4300, lots: 200000, estimatedMaxLossIdr: 4000000000, capitalIdr: 90000000000 }],
    prices: { BBRI: 4480 },
    price_meta: { BBRI: { at: '2026-08-13T09:00:00Z', age_minutes: 5 } }
  },
  'partial data only': {
    plans: [{ ticker: 'ANTM' }, { ticker: 'MDKA', lots: 3 }],
    prices: {}
  },
  'a genuine zero risk budget': {
    plans: [{ ticker: 'BBCA', entryPriceIdr: 9000, stopLossIdr: 9000, lots: 1, estimatedMaxLossIdr: 0, capitalIdr: 900000 }],
    prices: { BBCA: 9000 },
    price_meta: { BBCA: { at: '2026-08-13T09:00:00Z', age_minutes: 0 } }
  }
};

Object.entries(PORTFOLIO_FIXTURES).forEach(([name, fixture]) => {
  test('portfolio fixture "' + name + '" invents no numeric value', () => {
    const context = portfolioContext(fixture);
    const allowed = new Set(numericTokens(fixture));
    // Derived counts and the configured staleness threshold are the context's
    // own arithmetic over the fixture, not readings about the market.
    const derived = new Set(['0', '1', '2', '3', '30', '100', '1440', '5', '10080', '10']);
    numericTokens(context).forEach((token) => {
      assert.ok(
        allowed.has(token) || derived.has(token),
        'fixture "' + name + '" produced an untraceable number: ' + token
      );
    });
  });

  test('portfolio fixture "' + name + '" never turns a missing field into a zero', () => {
    const context = portfolioContext(fixture);
    context.plans.forEach((plan, index) => {
      const source = fixture.plans[index];
      ['entry', 'stop_loss', 'tp1', 'tp2', 'lots', 'estimated_max_loss', 'capital'].forEach((field) => {
        if (plan[field] !== 0) return;
        // The only way a 0 may appear is if the fixture genuinely supplied one.
        assert.ok(
          Object.values(source).includes(0),
          'fixture "' + name + '" fabricated a 0 for ' + plan.ticker + '.' + field
        );
      });
    });
  });
});

test('a position with no stored price is named as having none', () => {
  const context = portfolioContext(PORTFOLIO_FIXTURES['three positions, mixed completeness']);
  assert.deepEqual(context.price_freshness.tickers_without_price, ['ASII']);
});

test('a week-old stored price is named as stale', () => {
  const context = portfolioContext(PORTFOLIO_FIXTURES['three positions, mixed completeness']);
  assert.deepEqual(context.price_freshness.tickers_with_stale_price, ['TLKM']);
  assert.ok(!context.price_freshness.tickers_with_stale_price.includes('BBCA'));
});

test('a mix of fresh and stale prices is reported per ticker, never averaged away', () => {
  const context = portfolioContext(PORTFOLIO_FIXTURES['three positions, mixed completeness']);
  const rows = {};
  context.price_freshness.positions.forEach((row) => { rows[row.ticker] = row; });
  assert.equal(rows.BBCA.age_minutes, 2);
  assert.equal(rows.TLKM.age_minutes, 10080);
  assert.equal(rows.ASII.age_minutes, null);
  assert.equal(rows.ASII.has_stored_price, false);
});

test('a provider-flagged stale price is stale even when it was fetched seconds ago', () => {
  const freshness = priceFreshness(
    { price_meta: { BBCA: { at: '2026-08-13T09:00:00Z', age_minutes: 1, provider_marked_stale: true } } },
    [{ ticker: 'BBCA' }],
    { BBCA: 9150 }
  );
  assert.deepEqual(freshness.tickers_with_stale_price, ['BBCA']);
  assert.deepEqual(freshness.tickers_with_unknown_price_age, []);
});

test('a zero portfolio produces no positions rather than zero-valued ones', () => {
  const context = portfolioContext(PORTFOLIO_FIXTURES['zero positions']);
  assert.deepEqual(context.plans, []);
  assert.deepEqual(context.price_freshness.positions, []);
  assert.deepEqual(context.prices, {});
});

test('positions with almost no data keep every unknown as null', () => {
  const context = portfolioContext(PORTFOLIO_FIXTURES['partial data only']);
  assert.equal(context.plans[0].entry, null);
  assert.equal(context.plans[0].stop_loss, null);
  assert.equal(context.plans[0].lots, null);
  assert.equal(context.plans[1].lots, 3);
  assert.equal(context.plans[1].entry, null);
});

test('large nominal values are carried exactly, without rounding or truncation', () => {
  const context = portfolioContext(PORTFOLIO_FIXTURES['large nominal values']);
  assert.equal(context.plans[0].capital, 90000000000);
  assert.equal(context.plans[0].estimated_max_loss, 4000000000);
  assert.equal(context.plans[0].lots, 200000);
});

test('a portfolio far larger than the carry limit is capped, not silently mangled', () => {
  const plans = Array.from({ length: 40 }, (_, i) => ({ ticker: 'AB' + String.fromCharCode(65 + (i % 26)), entryPriceIdr: 100 + i, lots: 1 }));
  const context = portfolioContext({ plans, prices: {} });
  assert.ok(context.plans.length <= 25, 'the carry limit must hold');
  assert.ok(context.plans.length >= 20, 'the limit must still admit a realistically large portfolio');
  context.plans.forEach((plan) => assert.match(plan.ticker, /^[A-Z]{3,5}$/));
});

test('an invalid ticker is dropped rather than passed through as a fact', () => {
  const context = portfolioContext({ plans: [{ ticker: 'BBCA', lots: 1 }, { ticker: '<script>', lots: 1 }, { ticker: '', lots: 1 }, { ticker: 'TOOLONGTICKER', lots: 1 }], prices: {} });
  assert.deepEqual(context.plans.map(p => p.ticker), ['BBCA']);
});

test('a non-positive or non-numeric stored price is not offered as a price', () => {
  const context = portfolioContext({ plans: [{ ticker: 'BBCA', lots: 1 }], prices: { BBCA: 0, TLKM: -5, ASII: 'abc', ANTM: null } });
  assert.deepEqual(context.prices, {});
  assert.deepEqual(context.price_freshness.tickers_without_price, ['BBCA']);
});

test('the snapshot store carries price metadata instead of dropping it', () => {
  const sanitized = store.sanitizePortfolioContext({
    plans: [{ ticker: 'BBCA', entryPriceIdr: 9000, lots: 1 }],
    prices: { BBCA: 9150 },
    price_meta: { BBCA: { at: '2026-08-13T09:00:00Z', age_minutes: 12, stale: false, price_date: '2026-08-13' } }
  });
  assert.ok(sanitized.price_meta, 'price_meta must survive sanitisation');
  assert.equal(sanitized.price_meta.BBCA.age_minutes, 12);
  assert.equal(sanitized.price_meta.BBCA.provider_marked_stale, false);
  assert.equal(sanitized.price_meta.BBCA.price_date, '2026-08-13');
});

// ======================= STOCK ANALYSIS FIXTURES =========================

const line = (ticker, status, extra) => ([
  ticker + ' — Analisis Auto-Cuan',
  'Harga terakhir: 1.250',
  'Entry / Konfirmasi: 1.200 - 1.240',
  'Stop Loss / Invalidasi: 1.150',
  'Target 1: 1.400',
  'Status: ' + status
].concat(extra || []).join('\n'));

const STOCK_FIXTURES = {
  'normal liquid ticker': { ticker: 'BBCA', text: line('BBCA', 'READY_CONFIRMED 2/2'), confirmed: true, expect: 'READY_CONFIRMED_2/2' },
  'WATCHING': { ticker: 'ANTM', text: line('ANTM', 'WATCHING'), confirmed: false, expect: 'WATCHING' },
  'WAIT_PULLBACK': { ticker: 'MDKA', text: line('MDKA', 'WAIT_PULLBACK'), confirmed: false, expect: 'WAIT_PULLBACK' },
  'RADAR': { ticker: 'PTBA', text: line('PTBA', 'RADAR'), confirmed: false, expect: 'RADAR' },
  'EARLY_RADAR': { ticker: 'INCO', text: line('INCO', 'EARLY_RADAR'), confirmed: false, expect: 'EARLY_RADAR' },
  'READY_PENDING 1/2': { ticker: 'BBRI', text: line('BBRI', 'READY_PENDING 1/2'), confirmed: false, expect: 'READY_PENDING_1/2' },
  'BLOCKED_CHASE': { ticker: 'GOTO', text: line('GOTO', 'BLOCKED_CHASE'), confirmed: false, expect: 'BLOCKED_CHASE' },
  'invalidated setup': { ticker: 'BUMI', text: line('BUMI', 'INVALIDATED', ['Setup batal: harga menembus invalidasi.']), confirmed: false, expect: 'INVALIDATED' },
  'stale setup': { ticker: 'ADRO', text: line('ADRO', 'STALE', ['Snapshot belum diperbarui hari ini.']), confirmed: false, expect: 'STALE' }
};

Object.entries(STOCK_FIXTURES).forEach(([name, fixture]) => {
  test('stock fixture "' + name + '" reaches the model with its state intact', () => {
    const context = stockContext({ ticker: fixture.ticker, analysis_text: fixture.text, captured_at: '2026-08-13T16:00:00+07:00' });
    assert.equal(context.ticker, fixture.ticker);
    assert.ok(context.setup_states.includes(fixture.expect), name + ' lost its state marker: ' + JSON.stringify(context.setup_states));
    assert.equal(
      context.setup_state_policy.unconfirmed_states_present.length === 0,
      fixture.confirmed,
      name + ' was classified as ' + (fixture.confirmed ? 'unconfirmed' : 'confirmed') + ' incorrectly'
    );
  });

  test('stock fixture "' + name + '" invents no level the snapshot does not contain', () => {
    const context = stockContext({ ticker: fixture.ticker, analysis_text: fixture.text, captured_at: '2026-08-13T16:00:00+07:00' });
    const source = fixture.text + ' 2026-08-13T16:00:00+07:00';
    numericTokens({ analysis_text: context.analysis_text, ticker: context.ticker }).forEach((token) => {
      assert.ok(source.includes(token), name + ' invented the number ' + token);
    });
  });
});

test('a watching-grade state can never be reported as a confirmed one', () => {
  ['WATCHING', 'RADAR', 'EARLY_RADAR', 'EARLY_WATCH', 'WAIT_PULLBACK', 'READY_PENDING 1/2', 'BLOCKED_CHASE'].forEach((status) => {
    const context = stockContext({ ticker: 'BBCA', analysis_text: line('BBCA', status) });
    assert.ok(context.setup_state_policy.unconfirmed_states_present.length > 0, status + ' must be flagged as unconfirmed');
    assert.ok(
      !context.setup_states.some(state => state.startsWith('READY_CONFIRMED')),
      status + ' must not carry a confirmed marker'
    );
  });
});

test('the state policy names each unconfirmed grade explicitly for the model', () => {
  const context = stockContext({ ticker: 'ANTM', analysis_text: line('ANTM', 'WATCHING') });
  const rules = context.setup_state_policy.rules.join(' ');
  assert.match(rules, /WATCHING/);
  assert.match(rules, /READY_PENDING/);
  assert.match(rules, /READY_CONFIRMED/);
  assert.match(rules, /BLOCKED_CHASE/);
});

test('a snapshot missing its indicator fields is carried as-is, with nothing filled in', () => {
  const sparse = ['XYZA — Analisis', 'Status: WATCHING', 'Indikator belum tersedia.'].join('\n');
  const context = stockContext({ ticker: 'XYZA', analysis_text: sparse });
  assert.equal(context.analysis_text.includes('Indikator belum tersedia.'), true);
  assert.doesNotMatch(context.analysis_text, /Entry|Stop Loss|Target/);
  assert.equal(context.truncated, false);
});

test('an unusable ticker or an empty snapshot produces no usable context', () => {
  assert.equal(stockContext({ ticker: '', analysis_text: 'apapun' }).ticker, '');
  assert.equal(stockContext({ ticker: '<img>', analysis_text: 'apapun' }).ticker, '');
  assert.equal(stockContext({ ticker: 'BBCA', analysis_text: '' }).analysis_text, '');
  assert.equal(stockContext({ ticker: 'IHSG', analysis_text: 'indeks' }).ticker, 'IHSG');
});

test('a duplicated snapshot is compacted without losing a distinct line', () => {
  const text = ['BBCA', 'Harga terakhir: 1.250', 'Harga terakhir: 1.250', 'Stop Loss: 1.150'].join('\n');
  const context = stockContext({ ticker: 'BBCA', analysis_text: text });
  assert.equal((context.analysis_text.match(/Harga terakhir: 1\.250/g) || []).length, 1);
  assert.match(context.analysis_text, /Stop Loss: 1\.150/);
});

// ============================== SHARED ===================================

test('the numeric gate treats every missing representation the same way', () => {
  [null, undefined, '', '   ', '\t\n', 'abc', '--', true, false, NaN, Infinity, -Infinity, [], {}]
    .forEach((value) => {
      assert.equal(number(value), null, 'missing value became a reading: ' + JSON.stringify(value));
    });
  [0, -0, 0.0, '0', '0.0', 1, -1, 0.5, 1e12].forEach((value) => {
    assert.equal(typeof number(value), 'number', 'a real reading was dropped: ' + String(value));
  });
});
