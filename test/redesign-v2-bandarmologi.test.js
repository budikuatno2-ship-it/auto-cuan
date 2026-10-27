'use strict';

// Redesign v2 Bandarmologi (canvas Bandarmologi.dc.html).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const partialHtml = read('public/partials/analisis-saham.partial.html');
const indexHtml = read('public/index.html');
const runtimeJs = read('public/bandarmologi-runtime.js');

test('header carries the title, subtitle, and 2-way mode switch', () => {
  const start = partialHtml.indexOf('id="panel-tab-bandarmologi"');
  assert.ok(start > 0, 'panel-tab-bandarmologi exists in partial');
  const end = partialHtml.indexOf('id="panel-tab-intel"', start);
  const panel = partialHtml.slice(start, end);

  assert.match(panel, /<h1[^>]*>Bandarmologi<\/h1>/);
  assert.match(panel, /Siapa yang membeli, siapa yang melepas, dan seberapa terkonsentrasi transaksinya\./);
  assert.match(panel, /<div class="segx n2"[^>]*role="group"/);
  assert.match(panel, /id="subTabBrokerSummary"/);
  assert.match(panel, /id="subTabAkumulasiBroker"/);
});

test('index.html template also carries the redesign header and subtabs', () => {
  assert.ok(indexHtml.includes('id="subTabBrokerSummary"'));
  assert.ok(indexHtml.includes('id="subTabAkumulasiBroker"'));
  assert.match(indexHtml, /<h1[^>]*>Bandarmologi<\/h1>/);
});

test('runtime code has no illegal assignment to undeclared selectedDate', () => {
  // Line 2023 bug check: strict mode would throw ReferenceError: selectedDate is not defined
  assert.doesNotMatch(runtimeJs, /selectedDate\s*=\s*data\.available_dates\[0\]/);
});

test('weekend date selection is rejected with Indonesian message', () => {
  assert.match(runtimeJs, /akhir pekan, bursa tutup/);
  assert.match(runtimeJs, /getUTCDay/);
});

test('3-way flow toggle handles Semua, Asing, and Domestik', () => {
  assert.match(runtimeJs, /id="toggleFlowAll"/);
  assert.match(runtimeJs, /id="toggleFlowForeign"/);
  assert.match(runtimeJs, /id="toggleFlowDomestic"/);
  assert.match(runtimeJs, /Semua investor \(flow=all\)\./);
  assert.match(runtimeJs, /Investor asing \(flow=F\)\. Diarsip sejak 2 Jan 2026, sedang dilengkapi\./);
  assert.match(runtimeJs, /Domestik dihitung per broker: semua − asing\./);
  assert.match(runtimeJs, /data asing belum dirilis/);
  assert.match(runtimeJs, /belum lengkap · menunggu data lengkap/);
});

test('tables use tw container with overflow-x auto and canvas column structure', () => {
  assert.match(runtimeJs, /<div class="tw"[^>]*><table class="tbl bt">/);
  assert.match(runtimeJs, /Pembeli terbesar/);
  assert.match(runtimeJs, /Penjual terbesar/);
  assert.match(runtimeJs, /Volume dalam lot/);
});

test('Akumulasi Broker view renders 4 periods and diverging bars', () => {
  assert.match(runtimeJs, /Akumulasi bersih per broker/);
  assert.match(runtimeJs, /1 hari/);
  assert.match(runtimeJs, /3 hari/);
  assert.match(runtimeJs, /5 hari/);
  assert.match(runtimeJs, /20 hari/);
  assert.match(runtimeJs, /<div class="div"><i/);
  assert.match(runtimeJs, /Batang di kanan garis tengah = akumulasi, di kiri = distribusi/);
});

test('legacy controls are preserved inside collapsible Alat lanjutan', () => {
  assert.match(runtimeJs, /id="bandarAdvTools"/);
  assert.match(runtimeJs, /Alat lanjutan/);
  assert.match(runtimeJs, /id="bandarSearchBarContainer"/);
  assert.match(runtimeJs, /id="bandarTickerSearchInput"/);
  assert.match(runtimeJs, /id="toggleModeGross"/);
  assert.match(runtimeJs, /id="toggleModeNet"/);
  assert.match(runtimeJs, /id="smartBrokerSummaryContainer"/);
});
