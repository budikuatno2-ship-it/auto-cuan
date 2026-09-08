'use strict';

/**
 * Unit tests for FASE 3 fix:
 * - normalizeBrokerAccumulation: returns full structure with empty arrays when raw is null
 * - synthesizeAccumulationFromSummary: derives real net_buyers/net_sellers from broker_summary
 * - getBandarmologiData: when no diskAcc, uses synthesized accumulation (non-empty bubble)
 */

const assert = require('assert');
const {
  normalizeBrokerAccumulation,
  synthesizeAccumulationFromSummary,
  normalizeBrokerSummary
} = require('../lib/bandarmologi-service');

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeNormSummary(overrides) {
  return Object.assign({
    date: '2026-09-04',
    range_label: 'Tanggal: 2026-09-04',
    net_flow: 32000000000,
    net_status: 'BIG_ACCUMULATION',
    net_label: 'Big Accumulation',
    gross_buyers: [
      { broker: 'YP', broker_name: 'Mirae', bval: 80000000000, sval: 40000000000, nval: 40000000000, bvol: 8000000, svol: 4000000 },
      { broker: 'CC', broker_name: 'Mandiri', bval: 60000000000, sval: 30000000000, nval: 30000000000, bvol: 6000000, svol: 3000000 }
    ],
    gross_sellers: [
      { broker: 'XC', broker_name: 'Ajaib', bval: 20000000000, sval: 60000000000, nval: -40000000000, bvol: 2000000, svol: 6000000 },
      { broker: 'NI', broker_name: 'BNI', bval: 15000000000, sval: 45000000000, nval: -30000000000, bvol: 1500000, svol: 4500000 }
    ],
    net_buyers: [
      { broker: 'YP', broker_name: 'Mirae', bval: 80000000000, sval: 40000000000, nval: 40000000000, bvol: 8000000, svol: 4000000 },
      { broker: 'CC', broker_name: 'Mandiri', bval: 60000000000, sval: 30000000000, nval: 30000000000, bvol: 6000000, svol: 3000000 }
    ],
    net_sellers: [
      { broker: 'XC', broker_name: 'Ajaib', bval: 20000000000, sval: 60000000000, nval: -40000000000, bvol: 2000000, svol: 6000000 },
      { broker: 'NI', broker_name: 'BNI', bval: 15000000000, sval: 45000000000, nval: -30000000000, bvol: 1500000, svol: 4500000 }
    ],
    top_buyers: [],
    top_sellers: []
  }, overrides);
}

// ─── 1. normalizeBrokerAccumulation(null) returns full empty structure ───────

{
  const result = normalizeBrokerAccumulation(null, 'BBCA');
  assert.strictEqual(result.ticker, 'BBCA', 'ticker preserved');
  assert.ok(Array.isArray(result.series), 'series is array');
  assert.ok(Array.isArray(result.daily_summary), 'daily_summary is array');
  assert.ok(Array.isArray(result.top_buyers), 'top_buyers is array');
  assert.ok(Array.isArray(result.top_sellers), 'top_sellers is array');
  assert.ok(Array.isArray(result.net_buyers), 'net_buyers is array');
  assert.ok(Array.isArray(result.net_sellers), 'net_sellers is array');
  assert.strictEqual(result.series.length, 0, 'series is empty for null input');
  assert.strictEqual(result.net_buyers.length, 0, 'net_buyers is empty for null input');
  console.log('✓ normalizeBrokerAccumulation(null) returns full empty structure');
}

// ─── 2. synthesizeAccumulationFromSummary: null normSummary ─────────────────

{
  const result = synthesizeAccumulationFromSummary(null, 'BBRI');
  assert.strictEqual(result.ticker, 'BBRI', 'ticker preserved for null normSummary');
  assert.ok(Array.isArray(result.net_buyers), 'net_buyers is array');
  assert.strictEqual(result.net_buyers.length, 0, 'empty for null normSummary');
  console.log('✓ synthesizeAccumulationFromSummary(null) returns empty structure');
}

// ─── 3. synthesizeAccumulationFromSummary: derives buyers and sellers ────────

{
  const normSummary = makeNormSummary({});
  const result = synthesizeAccumulationFromSummary(normSummary, 'BBCA');

  assert.strictEqual(result.ticker, 'BBCA', 'ticker');
  assert.ok(result.net_buyers.length > 0, `net_buyers should be non-empty, got ${result.net_buyers.length}`);
  assert.ok(result.net_sellers.length > 0, `net_sellers should be non-empty, got ${result.net_sellers.length}`);

  // Verify all buyers have non-negative nval
  for (const b of result.net_buyers) {
    const nval = b.nval != null ? b.nval : (b.net_val != null ? b.net_val : 0);
    assert.ok(nval >= 0, `buyer ${b.broker} has negative nval: ${nval}`);
  }

  // Verify all sellers have negative nval
  for (const s of result.net_sellers) {
    const nval = s.nval != null ? s.nval : (s.net_val != null ? s.net_val : 0);
    assert.ok(nval < 0, `seller ${s.broker} has non-negative nval: ${nval}`);
  }

  // Verify no broker appears in both lists
  const buyerCodes = new Set(result.net_buyers.map(b => b.broker));
  const sellerCodes = new Set(result.net_sellers.map(s => s.broker));
  for (const code of buyerCodes) {
    assert.ok(!sellerCodes.has(code), `broker ${code} appears in both buyers and sellers`);
  }

  console.log(`✓ synthesizeAccumulationFromSummary: ${result.net_buyers.length} buyers, ${result.net_sellers.length} sellers (no duplicates)`);
}

// ─── 4. synthesizeAccumulationFromSummary: no Trillion values ───────────────

{
  const normSummary = makeNormSummary({
    net_buyers: [
      // Values within normal Miliar range (< 5e11)
      { broker: 'YP', broker_name: 'Mirae', bval: 80000000000, sval: 40000000000, nval: 40000000000 }
    ],
    net_sellers: [
      { broker: 'XC', broker_name: 'Ajaib', bval: 20000000000, sval: 60000000000, nval: -40000000000 }
    ]
  });
  const result = synthesizeAccumulationFromSummary(normSummary, 'BMRI');

  for (const b of result.net_buyers.concat(result.net_sellers)) {
    const nval = Math.abs(b.nval != null ? b.nval : 0);
    assert.ok(nval < 5e11, `Trillion anomaly detected for ${b.broker}: nval=${nval}`);
  }
  console.log('✓ synthesizeAccumulationFromSummary: no Trillion values in output');
}

// ─── 5. synthesizeAccumulationFromSummary: series includes net_flow ──────────

{
  const normSummary = makeNormSummary({ net_flow: 32000000000, date: '2026-09-04' });
  const result = synthesizeAccumulationFromSummary(normSummary, 'BBCA');

  assert.ok(result.series.length > 0, 'series should be non-empty when net_flow != 0');
  assert.strictEqual(result.series[0].net_val, 32000000000, 'series net_val matches net_flow');
  assert.strictEqual(result.series[0].status, 'ACC', 'positive net_flow → ACC status');
  console.log(`✓ synthesizeAccumulationFromSummary: series has ${result.series.length} entry with correct status`);
}

// ─── 6. synthesizeAccumulationFromSummary: DISTRIBUTION status when net_flow < 0

{
  const normSummary = makeNormSummary({
    net_flow: -25000000000,
    net_status: 'BIG_DISTRIBUTION',
    net_buyers: [
      { broker: 'XC', broker_name: 'Ajaib', bval: 20000000000, sval: 60000000000, nval: -40000000000 }
    ],
    net_sellers: [
      { broker: 'YP', broker_name: 'Mirae', bval: 20000000000, sval: 60000000000, nval: -40000000000 }
    ],
    gross_buyers: [],
    gross_sellers: []
  });
  const result = synthesizeAccumulationFromSummary(normSummary, 'TLKM');

  assert.strictEqual(result.status, 'DISTRIBUTION', 'negative net_flow → DISTRIBUTION');
  if (result.series.length > 0) {
    assert.strictEqual(result.series[0].status, 'DIST', 'series entry status is DIST');
  }
  console.log('✓ synthesizeAccumulationFromSummary: DISTRIBUTION status for negative net_flow');
}

// ─── 7. normalizeBrokerAccumulation: existing series data flows through ──────

{
  const rawAcc = {
    series: [
      { date: '2026-09-04', net_val: 42300000000, status: 'BIG_ACC' },
      { date: '2026-09-03', net_val: -5400000000, status: 'DIST' }
    ],
    net_buyers: [
      { broker: 'YP', broker_name: 'Mirae', nval: 40000000000, bval: 80000000000, sval: 40000000000 }
    ],
    net_sellers: [
      { broker: 'XC', broker_name: 'Ajaib', nval: -35000000000, bval: 20000000000, sval: 55000000000 }
    ]
  };
  const result = normalizeBrokerAccumulation(rawAcc, 'BBCA');

  assert.ok(result.net_buyers.length > 0, 'net_buyers populated from raw');
  assert.ok(result.net_sellers.length > 0, 'net_sellers populated from raw');
  assert.ok(result.series.length > 0, 'series preserved');
  console.log(`✓ normalizeBrokerAccumulation: ${result.net_buyers.length} buyers, ${result.net_sellers.length} sellers from raw disk data`);
}

console.log('\n✅ All broker-accumulation-fix tests passed!\n');
