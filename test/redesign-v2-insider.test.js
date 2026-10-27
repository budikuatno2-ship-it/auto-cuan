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

  // Canvas header
  assert.ok(container.innerHTML.includes('<h1>Jejaring Insider</h1>'), 'Must have h1 Jejaring Insider');
  assert.ok(container.innerHTML.includes('Relasi pengendali, direksi, dan kepemilikan silang'), 'Must have canvas subtitle');

  // Graph section & legend
  assert.ok(container.innerHTML.includes('id="insiderGraphSection"'), 'Must have insiderGraphSection');
  assert.ok(container.innerHTML.includes('class="legend"'), 'Must have legend');
  assert.ok(container.innerHTML.includes('Reset sorotan'), 'Must have Reset sorotan button');

  // §5c: HTML overlay labels over SVG
  assert.ok(container.innerHTML.includes('class="gw"'), 'Must have gw container');
  assert.ok(container.innerHTML.includes('class="gov"'), 'Must have gov overlay container');
  assert.ok(container.innerHTML.includes('class="glb gl'), 'Must have HTML node labels with glb gl');
  assert.ok(container.innerHTML.includes('class="glb gs'), 'Must have HTML node subtitle / edge labels with glb gs');

  // Detail panel & roster table
  assert.ok(container.innerHTML.includes('id="insiderDetailPanel"'), 'Must have detail panel');
  assert.ok(container.innerHTML.includes('id="insiderRosterSection"'), 'Must have roster section');
  assert.ok(container.innerHTML.includes('id="insiderRosterTbody"'), 'Must have roster tbody');

  // Truthful KSEI provenance date
  assert.ok(container.innerHTML.includes('30 Sep 2026'), 'Must truthfully display KSEI date 30 Sep 2026');
});

test('Insider Redesign: node selection and graph highlight updates', () => {
  const graphHtmlBBCA = bandarmologiRuntime.renderCanvasInsiderGraph('BBCA');
  assert.ok(graphHtmlBBCA.includes('viewBox="0 0 760 440"'), 'Has 760x440 viewBox');
  assert.ok(graphHtmlBBCA.includes('BBCA'), 'Contains BBCA');
  assert.ok(graphHtmlBBCA.includes('PT Dwimuria Investama Andalan'), 'Contains DWI');

  const detailBBCA = bandarmologiRuntime.renderCanvasInsiderDetail('BBCA');
  assert.ok(detailBBCA.includes('Emiten'), 'BBCA is Emiten');
  assert.ok(detailBBCA.includes('Dwimuria 54,94%'), 'Contains pengendali rel');

  const detailRBH = bandarmologiRuntime.renderCanvasInsiderDetail('RBH');
  assert.ok(detailRBH.includes('Robert Budi Hartono'), 'RBH title');
  assert.ok(detailRBH.includes('Orang'), 'RBH kind');
});
