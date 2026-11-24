'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bandarmologiRuntime = require('../public/bandarmologi-runtime');

test('Insider Redesign: exports required canvas functions', () => {
  assert.equal(typeof bandarmologiRuntime.renderInsiderNetworkUI, 'function');
  assert.equal(typeof bandarmologiRuntime.selectInsiderNode, 'function');
  assert.equal(typeof bandarmologiRuntime.renderCanvasInsiderGraph, 'function');
  assert.equal(typeof bandarmologiRuntime.renderCanvasInsiderDetail, 'function');
});

test('Insider Redesign: renders canvas elements and layout', () => {
  const container = { innerHTML: '' };
  bandarmologiRuntime.renderInsiderNetworkUI(container, 'BBCA');

  assert.ok(container.innerHTML.includes('<h1>Jejaring Insider</h1>'), 'Must have h1 Jejaring Insider');
  assert.ok(container.innerHTML.includes('Relasi pengendali, direksi, dan kepemilikan silang'), 'Must have canvas subtitle');
  assert.ok(container.innerHTML.includes('id="insiderGraphSection"'), 'Must have insiderGraphSection');
  assert.ok(container.innerHTML.includes('class="legend"'), 'Must have legend');
  assert.ok(container.innerHTML.includes('Reset sorotan'), 'Must have Reset sorotan button');

  // FIX 3: single sharp SVG label per entity/percentage — no ghost overlay.
  assert.ok(container.innerHTML.includes('class="gw"'), 'Must have gw container');
  assert.ok(!container.innerHTML.includes('class="gov"'), 'No ghost HTML overlay container');
  assert.ok(!container.innerHTML.includes('class="glb'), 'No duplicate HTML overlay labels');
  assert.ok(container.innerHTML.includes('<text class="nl"'), 'SVG node labels present');

  assert.ok(container.innerHTML.includes('id="insiderDetailPanel"'), 'Must have detail panel');
  assert.ok(container.innerHTML.includes('id="insiderRosterSection"'), 'Must have roster section');
  assert.ok(container.innerHTML.includes('id="insiderRosterTbody"'), 'Must have roster tbody');

  // FIX 3: canonical arjum_insiders provenance through 20 Nov 2026.
  assert.ok(container.innerHTML.includes('arjum_insiders'), 'Must name canonical source');
  assert.ok(container.innerHTML.includes('20 Nov 2026'), 'Must show canonical as-of date');
});

test('Insider Redesign: node selection and graph highlight updates', () => {
  const graphHtmlBBCA = bandarmologiRuntime.renderCanvasInsiderGraph('BBCA');
  assert.ok(graphHtmlBBCA.includes('viewBox="0 0 760 440"'), 'Has 760x440 viewBox');
  assert.ok(graphHtmlBBCA.includes('BBCA'), 'Contains BBCA');
  assert.ok(graphHtmlBBCA.includes('PT Dwimuria Investama Andalan'), 'Contains DWI');

  const detailBBCA = bandarmologiRuntime.renderCanvasInsiderDetail('BBCA');
  assert.ok(detailBBCA.includes('Emiten'), 'BBCA is Emiten');
  assert.ok(detailBBCA.includes('54,94%'), 'Contains pengendali percentage');

  const detailRBH = bandarmologiRuntime.renderCanvasInsiderDetail('RBH');
  assert.ok(detailRBH.includes('Robert Budi Hartono'), 'RBH title');
  assert.ok(detailRBH.includes('Orang'), 'RBH kind');
});
