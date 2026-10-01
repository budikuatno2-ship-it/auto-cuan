'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bandarmologiService = require('../lib/bandarmologi-service');
const bandarmologiRuntime = require('../public/bandarmologi-runtime');

test('FASE 1: normalizeInsiders extracts broker, shares_change, shares_before/after, and nationality', () => {
  const rawData = [
    {
      date: '2026-09-04',
      insider_name: '  Budi  Kuatno, S.E.  ',
      position: 'Direktur Utama',
      action_type: 'BELI',
      broker: 'yp',
      price: '9,750',
      changes_value: '696,500',
      changes_percentage: '+0.11%',
      shares_after: '12,500,000',
      shares_after_percentage: '0.101%',
      nationality: 'WNI'
    },
    {
      date: '2026-09-03',
      name: 'Global Investment Ltd',
      position: 'Pemegang Saham >5%',
      action_type: 'SELL',
      broker_code: 'AK',
      price: 9800,
      shares_change: 1000000,
      pct_change: '-0.15%',
      current_shares: 45000000,
      current_shares_percentage: '0.365%',
      previous_shares: 46000000,
      previous_shares_percentage: '0.373%',
      nationality: 'Asing'
    },
    {
      date: '2026-09-02',
      name: 'Siti Rahmawati',
      position: 'Komisaris',
      action_type: 'PENGALIHAN',
      broker: 'CC',
      price: 0,
      volume: 250000,
      pct_change: '0.00%',
      shares_after: 5000000,
      pct_after: '0.041%',
      nationality: 'local'
    }
  ];

  const norm = bandarmologiService.normalizeInsiders(rawData);
  assert.equal(norm.length, 3);

  // Row 1: Budi Kuatno
  assert.equal(norm[0].name, 'Budi Kuatno, S.E.');
  assert.equal(norm[0].insider_name, 'Budi Kuatno, S.E.');
  assert.equal(norm[0].action_type, 'BUY');
  assert.equal(norm[0].broker, 'YP');
  assert.equal(norm[0].price, 9750);
  assert.equal(norm[0].shares_change, 696500);
  assert.equal(norm[0].pct_change, '+0.11%');
  assert.equal(norm[0].shares_after, 12500000);
  assert.equal(norm[0].pct_after, '0.101%');
  // Fallback calculation: shares_before = shares_after - shares_change = 12,500,000 - 696,500 = 11,803,500
  assert.equal(norm[0].shares_before, 11803500);
  assert.equal(norm[0].nationality, 'local');

  // Row 2: Global Investment Ltd
  assert.equal(norm[1].name, 'Global Investment Ltd');
  assert.equal(norm[1].action_type, 'SELL');
  assert.equal(norm[1].broker, 'AK');
  assert.equal(norm[1].price, 9800);
  assert.equal(norm[1].shares_change, 1000000);
  assert.equal(norm[1].pct_change, '-0.15%');
  assert.equal(norm[1].shares_after, 45000000);
  assert.equal(norm[1].shares_before, 46000000);
  assert.equal(norm[1].nationality, 'foreign');

  // Row 3: Siti Rahmawati
  assert.equal(norm[2].action_type, 'TRANSFER');
  assert.equal(norm[2].broker, 'CC');
  assert.equal(norm[2].price, 0);
  assert.equal(norm[2].nationality, 'local');
});

test('FASE 1: Frontend renders complete 10-column table and reactive action filter', () => {
  const mockInsiders = [
    {
      date: '2026-08-28',
      name: 'Direksi Utama',
      position: 'Direktur Utama',
      action_type: 'BUY',
      broker: 'YP',
      price: 9750,
      shares_change: 696500,
      pct_change: '+0.11%',
      shares_after: 12500000,
      pct_after: '0.101%',
      shares_before: 11803500,
      pct_before: '0.095%',
      nationality: 'local'
    },
    {
      date: '2026-08-10',
      name: 'Offshore Fund Ltd',
      position: 'Investor',
      action_type: 'SELL',
      broker: 'AK',
      price: 9825,
      shares_change: 1000000,
      pct_change: '-0.15%',
      shares_after: 45000000,
      pct_after: '0.365%',
      shares_before: 46000000,
      pct_before: '0.373%',
      nationality: 'foreign'
    }
  ];

  const mockData = {
    ticker: 'BBRI',
    broker_summary: { net_flow: 1000000000, top_buyers: [{ broker: 'CC', bval: 1000000000 }], top_sellers: [] },
    insiders: mockInsiders
  };

  const container = { innerHTML: '' };
  bandarmologiRuntime.setBandarSection('summary');
  bandarmologiRuntime.setInsiderActionFilter('all');
  bandarmologiRuntime.renderBandarmologiUI(container, mockData);

  const html = container.innerHTML;

  // 1. Check all 10 column headers
  assert.ok(html.includes('Tanggal'), 'Must have Tanggal column');
  assert.ok(html.includes('Nama Insider'), 'Must have Nama Insider column');
  assert.ok(html.includes('Jabatan'), 'Must have Jabatan column');
  assert.ok(html.includes('Aksi'), 'Must have Aksi column');
  assert.ok(html.includes('Harga'), 'Must have Harga column');
  assert.ok(html.includes('Broker'), 'Must have Broker column');
  assert.ok(html.includes('Perubahan (%)'), 'Must have Perubahan (%) column');
  assert.ok(html.includes('Kepemilikan Saat Ini (%)'), 'Must have Kepemilikan Saat Ini (%) column');
  assert.ok(html.includes('Kepemilikan Sebelumnya (%)'), 'Must have Kepemilikan Sebelumnya (%) column');
  assert.ok(html.includes('Nasionalitas'), 'Must have Nasionalitas column');

  // 2. Check rendered rows content
  assert.match(html, /BELI/, 'Must render BELI badge');
  assert.match(html, /JUAL/, 'Must render JUAL badge');
  assert.match(html, /YP/, 'Must render broker YP');
  assert.match(html, /AK/, 'Must render broker AK');
  assert.match(html, /Rp\s*9\.750/, 'Must render price Rp 9.750');
  assert.match(html, /Rp\s*9\.825/, 'Must render price Rp 9.825');
  assert.match(html, /\+696\.500/, 'Must render +696.500');
  assert.match(html, /-1\.000\.000/, 'Must render -1.000.000');
  assert.match(html, /12\.500\.000 \(0\.101%\)/, 'Must render Kepemilikan Saat Ini with %');
  assert.match(html, /11\.803\.500 \(0\.095%\)/, 'Must render Kepemilikan Sebelumnya with %');
  assert.match(html, /Local/, 'Must render Local nationality');
  assert.match(html, /Foreign/, 'Must render Foreign nationality');

  // 3. Check reactive filter dropdown
  assert.ok(html.includes('id="insiderActionFilterSelect"'), 'Must have action filter select dropdown');
  assert.ok(html.includes('Semua Aksi (2)'), 'Must show Semua Aksi (2)');
  assert.ok(html.includes('🟢 Beli (1)'), 'Must show Beli (1)');
  assert.ok(html.includes('🔴 Jual (1)'), 'Must show Jual (1)');
});

test('FASE 1: setInsiderActionFilter reactively isolates BUY and SELL transactions', () => {
  const mockInsiders = [
    {
      name: 'Pembeli 1',
      action_type: 'BUY',
      shares_change: 500000,
      price: 5000
    },
    {
      name: 'Penjual 1',
      action_type: 'SELL',
      shares_change: 300000,
      price: 5200
    }
  ];

  const mockData = {
    ticker: 'BBCA',
    broker_summary: { net_flow: 500000000 },
    insiders: mockInsiders
  };

  const container = { innerHTML: '' };
  bandarmologiRuntime.setBandarSection('summary');

  // Filter BUY only
  bandarmologiRuntime.setInsiderActionFilter('BUY');
  assert.equal(bandarmologiRuntime.getInsiderActionFilter(), 'BUY');
  bandarmologiRuntime.renderBandarmologiUI(container, mockData);
  assert.ok(container.innerHTML.includes('Pembeli 1'), 'Must include Pembeli 1');
  assert.ok(!container.innerHTML.includes('Penjual 1'), 'Must NOT include Penjual 1 when filtered to BUY');

  // Filter SELL only
  bandarmologiRuntime.setInsiderActionFilter('SELL');
  assert.equal(bandarmologiRuntime.getInsiderActionFilter(), 'SELL');
  bandarmologiRuntime.renderBandarmologiUI(container, mockData);
  assert.ok(!container.innerHTML.includes('Pembeli 1'), 'Must NOT include Pembeli 1 when filtered to SELL');
  assert.ok(container.innerHTML.includes('Penjual 1'), 'Must include Penjual 1');

  // Reset to all
  bandarmologiRuntime.setInsiderActionFilter('all');
  assert.equal(bandarmologiRuntime.getInsiderActionFilter(), 'all');
  bandarmologiRuntime.renderBandarmologiUI(container, mockData);
  assert.ok(container.innerHTML.includes('Pembeli 1'));
  assert.ok(container.innerHTML.includes('Penjual 1'));
});
