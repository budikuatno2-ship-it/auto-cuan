'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const bandarmologiRuntime = require('../public/bandarmologi-runtime');

test('renderBrokerSummaryTableHtml: is defined, exported, and crash-proof', () => {
  assert.equal(typeof bandarmologiRuntime.renderBrokerSummaryTableHtml, 'function');

  // Crash-proof on null, undefined, empty
  const outNull = bandarmologiRuntime.renderBrokerSummaryTableHtml(null);
  assert.ok(typeof outNull === 'string', 'Should return string on null input');
  assert.ok(outNull.includes('TOP BUYERS'), 'Renders empty buyer table');
  assert.ok(outNull.includes('TOP SELLERS'), 'Renders empty seller table');

  const outEmpty = bandarmologiRuntime.renderBrokerSummaryTableHtml([], []);
  assert.ok(typeof outEmpty === 'string');
});

test('renderBrokerSummaryTableHtml: renders sticky thead and 480px scroll container', () => {
  const buyers = [
    { broker: 'YU', broker_name: 'CGS International', avg_price: 3400, bval: 103000000000, bvol: 30354200, nval: 101000000000 }
  ];
  const sellers = [
    { broker: 'CC', broker_name: 'Mandirk Sekuritas', avg_price: 3390, sval: 130000000000, svol: 38365500, nval: -130000000000 }
  ];

  const html = bandarmologiRuntime.renderBrokerSummaryTableHtml(buyers, sellers, false, 'net');

  // Sticky thead check
  assert.ok(html.includes('class="sticky top-0 bg-slate-900 z-10'), 'Must contain sticky top-0 bg-slate-900 thead class');
  // Scroll container check
  assert.ok(html.includes('max-height: 480px; overflow-y: auto; overflow-x: auto;'), 'Must contain 480px scroll container');
  // Content check
  assert.ok(html.includes('YU'), 'Displays buyer broker YU');
  assert.ok(html.includes('CC'), 'Displays seller broker CC');
  assert.ok(html.includes('TOP BUYERS'), 'Contains TOP BUYERS header');
  assert.ok(html.includes('TOP SELLERS'), 'Contains TOP SELLERS header');
});

test('renderBandarmologiIntelUI: Market Screener has #panel-intel-scanner, max-height: 520px - 560px, and sticky thead', () => {
  const runtimeCode = fs.readFileSync(path.join(ROOT, 'public', 'bandarmologi-runtime.js'), 'utf8');
  assert.ok(runtimeCode.includes('id="panel-intel-scanner"'), 'Contains id="panel-intel-scanner"');
  assert.ok(/max-height:\s*5[2-6]0px;\s*overflow-y:\s*auto;\s*overflow-x:\s*auto;/.test(runtimeCode), 'Contains 520px-560px scroll container');
  assert.ok(runtimeCode.includes('sticky top-0 bg-slate-900'), 'Contains sticky top-0 thead in scanner table');
});

test('renderInsiderNetworkSvg: viewBox is 0 0 900 700 with cy = 350 and bottom padding > 80px', () => {
  const mockGraph = {
    summary: { entity_name: 'Belvin Tannadi', total_emitens: 2 },
    nodes: [
      { id: 'insider:belvin tannadi', label: 'Belvin Tannadi', type: 'insider', is_central: true, total_emitens: 2, nationality: 'local' },
      { id: 'ticker:BUMI', label: 'BUMI', ticker: 'BUMI', type: 'ticker' },
      { id: 'ticker:BRMS', label: 'BRMS', ticker: 'BRMS', type: 'ticker' }
    ],
    edges: [
      { source: 'insider:belvin tannadi', target: 'ticker:BUMI', ticker: 'BUMI', shares: 850000000, percentage: 2.45, broker: 'YP' },
      { source: 'insider:belvin tannadi', target: 'ticker:BRMS', ticker: 'BRMS', shares: 420000000, percentage: 1.80, broker: 'XL' }
    ]
  };

  const svg = bandarmologiRuntime.renderInsiderNetworkSvg(mockGraph, 'BUMI');

  assert.ok(svg.includes('viewBox="0 0 900 700"'), 'SVG must have viewBox="0 0 900 700"');
  assert.ok(svg.includes('Belvin Tannadi'), 'Central node has Belvin Tannadi');
  assert.ok(svg.includes('BUMI'), 'Contains BUMI node');
});
