'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const risk = require('../lib/market-structure-risk');
const marketImport = require('../lib/market-structure-import');

test('free float below 15% becomes caution context, not regulatory non-compliance', () => {
  const result = risk.buildMarketStructureContext({
    free_float_pct: 12.5,
    free_float_source: 'idx_free_float_2026-09',
    free_float_as_of: '2026-09-30'
  });

  assert.equal(result.free_float_pct, 12.5);
  assert.equal(result.low_free_float_risk, true);
  assert.equal(result.low_free_float_reference_pct, 15);
  assert.equal(result.market_structure_status, 'LOW_FREE_FLOAT');
  assert.equal(result.market_structure_guard, 'CAUTION');
  assert.equal(result.regulatory_compliance_status, 'NOT_EVALUATED');
});

test('verified free float >=15% and explicit non-HSC snapshot is normal context', () => {
  const result = risk.buildMarketStructureContext({
    free_float_pct: 27.25,
    free_float_source: 'idx_free_float_2026-09',
    free_float_as_of: '2026-09-30',
    hsc_flag: false,
    hsc_source: 'idx_hsc_2026-09',
    hsc_as_of: '2026-09-30'
  });

  assert.equal(result.market_structure_status, 'STRUCTURE_VERIFIED');
  assert.equal(result.market_structure_guard, 'NORMAL');
  assert.equal(result.low_free_float_risk, false);
  assert.equal(result.hsc_flag, false);
  assert.equal(result.regulatory_compliance_status, 'NOT_EVALUATED');
});

test('verified HSC flag has caution priority even when free float is above 15%', () => {
  const result = risk.buildMarketStructureContext({
    free_float_pct: 30,
    free_float_source: 'idx_free_float_2026-09',
    free_float_as_of: '2026-09-30',
    hsc_flag: true,
    hsc_source: 'idx_hsc_2026-09',
    hsc_as_of: '2026-09-30'
  });

  assert.equal(result.market_structure_status, 'HIGH_SHAREHOLDING_CONCENTRATION');
  assert.equal(result.market_structure_guard, 'CAUTION');
});

test('market structure fails closed when provenance is incomplete', () => {
  const result = risk.buildMarketStructureContext({
    free_float_pct: 22,
    hsc_flag: false,
    hsc_source: 'idx_hsc_2026-09'
  });

  assert.equal(result.free_float_pct, null);
  assert.equal(result.hsc_flag, null);
  assert.equal(result.data_available, false);
  assert.equal(result.market_structure_status, 'DATA_INCOMPLETE');
  assert.equal(result.regulatory_compliance_status, 'NOT_EVALUATED');
});

test('market structure CSV requires provenance for every supplied metric', () => {
  assert.throws(() => marketImport.parseMarketStructureCsv(
    'ticker,free_float_pct\nBBCA,20\n'
  ), /free_float_source/);

  assert.throws(() => marketImport.parseMarketStructureCsv(
    'ticker,hsc_flag,hsc_source\nBBCA,true,idx_hsc\n'
  ), /hsc_as_of/);
});

test('market structure CSV parses explicit false HSC and decimal free float', () => {
  const parsed = marketImport.parseMarketStructureCsv([
    'ticker,free_float_pct,free_float_source,free_float_as_of,hsc_flag,hsc_source,hsc_as_of',
    'BBCA,42.5,idx_free_float,2026-09-30,false,idx_hsc,2026-09-30'
  ].join('\n'));

  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].ticker, 'BBCA');
  assert.equal(parsed.rows[0].free_float_pct, 42.5);
  assert.equal(parsed.rows[0].hsc_flag, false);
});

test('free float normalization rejects values outside 0..100', () => {
  assert.equal(risk.normalizeFreeFloatPct(-1), null);
  assert.equal(risk.normalizeFreeFloatPct(101), null);
  assert.equal(risk.normalizeFreeFloatPct('15.25'), 15.25);
});

test('CSV free-float percent normalization is complete and still range-validated', () => {
  const parsed = marketImport.parseMarketStructureCsv([
    'ticker,free_float_pct,free_float_source,free_float_as_of',
    'TEST,15%%,idx_verified,2026-09-30'
  ].join('\n'));
  assert.equal(parsed.rows[0].free_float_pct, 15);

  assert.throws(() => marketImport.parseMarketStructureCsv([
    'ticker,free_float_pct,free_float_source,free_float_as_of',
    'BAD,101%,idx_verified,2026-09-30'
  ].join('\n')), /free_float_pct tidak valid/);
});
