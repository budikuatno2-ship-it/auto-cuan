'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bandarmologiRuntime = require('../public/bandarmologi-runtime');

test('Broker Hunter Redesign: exports required functions', () => {
  assert.equal(typeof bandarmologiRuntime.setHunterBroker, 'function');
  assert.equal(typeof bandarmologiRuntime.setHunterRange, 'function');
  assert.equal(typeof bandarmologiRuntime.selectHunterStock, 'function');
  assert.equal(typeof bandarmologiRuntime.filterHunterRoster, 'function');
  assert.equal(typeof bandarmologiRuntime.getHunterSelectedStock, 'function');
  assert.equal(typeof bandarmologiRuntime.renderBrokerHunterUI, 'function');
});

test('Broker Hunter Redesign: renders canvas elements and layout', () => {
  const container = { innerHTML: '' };
  bandarmologiRuntime.renderBrokerHunterUI(container);

  // Canvas header & ranges
  assert.ok(container.innerHTML.includes('<h1>Broker Hunter</h1>'), 'Must have h1 Broker Hunter');
  assert.ok(container.innerHTML.includes('Mulai dari broker, bukan ticker'), 'Must have canvas subtitle');
  assert.ok(container.innerHTML.includes('segx n4'), 'Must have 4-range segmented toggle');
  assert.ok(container.innerHTML.includes('>1 hari</button>'), 'Must have 1 hari toggle');
  assert.ok(container.innerHTML.includes('>3 hari</button>'), 'Must have 3 hari toggle');
  assert.ok(container.innerHTML.includes('>1 minggu</button>'), 'Must have 1 minggu toggle');
  assert.ok(container.innerHTML.includes('>1 bulan</button>'), 'Must have 1 bulan toggle');

  // Broker roster
  assert.ok(container.innerHTML.includes('class="ros"'), 'Must have ros container');
  assert.ok(container.innerHTML.includes('hunterBrokerFilterInput'), 'Must have broker search filter');

  // Legacy preserved in Alat Lanjutan
  assert.ok(container.innerHTML.includes('<details class="adv-tools"'), 'Must have adv-tools details');
  assert.ok(container.innerHTML.includes('<summary>Alat lanjutan</summary>'), 'Must have Alat lanjutan summary');
  assert.ok(container.innerHTML.includes('Broker Hunter — Top 10 Saham per Broker'), 'Must have legacy title in adv tools');
});

test('Broker Hunter Redesign: renders tables and provenance with loaded data fixture', () => {
  const container = { innerHTML: '' };
  // Mock loaded data
  const mockData = {
    success: true,
    from_cache: true,
    broker: 'AK',
    broker_name: 'UBS Sekuritas Indonesia',
    range: '1d',
    date_range_label: '2026-09-08',
    total_stocks_active: 7,
    top_accumulated: [
      { ticker: 'BBRI', net_val: 61437020000, buy_val: 95969929000, sell_val: 34532909000, avg_buy_price: 3392, days_active: 1 },
      { ticker: 'BBCA', net_val: 45200000000, buy_val: 80000000000, sell_val: 34800000000, avg_buy_price: 10450, days_active: 3 }
    ],
    top_distributed: [
      { ticker: 'ASII', net_val: -16800000000, buy_val: 10000000000, sell_val: 26800000000, avg_sell_price: 5160, days_active: 2 }
    ]
  };

  // Pass mockData
  bandarmologiRuntime.renderBrokerHunterUI(container, mockData);

  // Check strip, tables, drill-down
  assert.ok(container.innerHTML.includes('class="strip"'), 'Must have strip');
  assert.ok(container.innerHTML.includes('Sedang dikoleksi'), 'Must have Sedang dikoleksi section');
  assert.ok(container.innerHTML.includes('Sedang dilepas'), 'Must have Sedang dilepas section');
  assert.ok(container.innerHTML.includes('class="hb"'), 'Must have hb progress bar');
  assert.ok(container.innerHTML.includes('Drill-down'), 'Must have drill-down card');
  assert.ok(container.innerHTML.includes('class="prov"'), 'Must have provenance bar');
});
