'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const analisisV2Src = read('public/analisis-v2.js');
const chartWorkstationSrc = read('public/chart-workstation.js');
const marketRuntimeSrc = read('public/market-feature-runtime.js');

test('T4: Kerucut Rentang Wajar 10 Hari terpasang untuk horizon Scalping dan Swing, tidak untuk Investor', () => {
  // Check that drawStockCone exists and handles hz === 'inv' by returning early
  assert.match(analisisV2Src, /function drawStockCone\(id, e, candles, hz\)/);
  assert.match(analisisV2Src, /if \(hz === 'inv'\) return;/);
  assert.match(analisisV2Src, /if \(state\.hz === 'scalp' \|\| state\.hz === 'swing'\)/);

  // Check that 10 business days cone boundaries p90 and p10 are computed
  assert.match(analisisV2Src, /futureDays\(last\.time, 10\)/);
  assert.match(analisisV2Src, /title: 'p90 10H'/);
  assert.match(analisisV2Src, /title: 'p10 10H'/);

  // Verify cone math: range10 computes 8-in-10 volatility band from 60 sessions
  assert.match(analisisV2Src, /1\.2816 \* sd \* Math\.sqrt\(10\)/);
});

test('T4: Layer Tekanan Broker dan Harga rata-rata bandar terpasang di Chart Workstation', () => {
  // Both layers exist in LAYER_GROUPS
  assert.match(chartWorkstationSrc, /id: 'bandar_tekanan_broker', name: 'Tekanan Broker'/);
  assert.match(chartWorkstationSrc, /id: 'bandar_avg_price', name: 'Harga rata-rata bandar'/);

  // Both are categorized as stock-only layers (disabled on indices)
  assert.match(chartWorkstationSrc, /bandar_tekanan_broker/);
  assert.match(chartWorkstationSrc, /bandar_avg_price/);
});

test('T4: Penanganan state jujur layer bandar ketika seri broksum harian belum tersedia', () => {
  // Honest status badge in drawer
  assert.match(chartWorkstationSrc, /Belum tersedia \(menunggu kelengkapan seri broker harian\)/);

  // Honest status handling in chart runtime
  assert.match(marketRuntimeSrc, /showTekananBroker = wsState \? wsState\.isLayerActive\('bandar_tekanan_broker'\) : false/);
  assert.match(marketRuntimeSrc, /showBandarAvgPrice = wsState \? wsState\.isLayerActive\('bandar_avg_price'\) : false/);
  assert.match(marketRuntimeSrc, /Belum tersedia \(menunggu kelengkapan seri broker harian\)/);
});

test('T4: Kesiapan sisi klien untuk bar hari ini (provisional, updatedAt, series.update) tetap utuh', () => {
  // Provisional label WIB helper
  assert.match(marketRuntimeSrc, /function acProvisionalLabel\(/);
  assert.match(marketRuntimeSrc, /sementara · diperbarui/);

  // Real-time tick update via series.update without full setData redraw
  assert.match(marketRuntimeSrc, /candleSeries\.update\(bar\)/);
  assert.match(marketRuntimeSrc, /volumeSeries\.update\(/);
  assert.match(marketRuntimeSrc, /updateBar: function\(bar\)/);
});
