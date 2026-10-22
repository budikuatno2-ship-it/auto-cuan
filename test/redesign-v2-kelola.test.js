'use strict';

// Kelola Keuangan canvas parts (KelolaKeuangan.dc.html): month select,
// composition bar and the Jenis colour dot.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const html = read('public/index.html');
const runtime = read('public/money-sheet-runtime.js');
const css = read('public/money-sheet.css');

test('month picker is a select labelled like the canvas ("Oktober 2026")', () => {
  assert.match(html, /<label class="ms-month">Bulan <select id="mmSheetMonth" aria-label="Bulan anggaran"><\/select><\/label>/);
  assert.doesNotMatch(html, /id="mmSheetMonth" type="month"/);
  assert.match(runtime, /new Intl\.DateTimeFormat\('id-ID', \{ month: 'long', year: 'numeric' \}\)/);
  assert.equal(new Intl.DateTimeFormat('id-ID', { month: 'long', year: 'numeric' }).format(new Date(2026, 9, 1)), 'Oktober 2026');
  // Every write goes through monthValue so an unknown month still gets an option.
  assert.doesNotMatch(runtime, /\$\('mmSheetMonth'\)\.value =/);
});

test('composition bar has three parts, a legend, and hides without data', () => {
  assert.match(html, /id="mmCompositionBar" role="img"[^>]*hidden><i data-part="expense"><\/i><i data-part="saving"><\/i><i data-part="left"><\/i><\/div>/);
  assert.match(html, /id="mmCompositionLegend" hidden>/);
  assert.match(runtime, /bar\.hidden = legend\.hidden = !\(total > 0\)/);
  assert.match(runtime, /'Komposisi: pengeluaran '/);
  assert.match(css, /\.ms-bar i \{[^}]*animation: msGrow/);
  assert.match(css, /@keyframes msGrow \{ from \{ transform: scaleX\(0\); \} to \{ transform: scaleX\(1\); \} \}/);
});

test('Jenis shows a colour dot per type and stays an editable select', () => {
  assert.match(runtime, /if \(field === 'type'\) input\.parentNode\.dataset\.type = row\.type;/);
  assert.match(runtime, /if \(input\.dataset\.field === 'type'\) input\.parentNode\.dataset\.type = input\.value;/);
  assert.match(css, /td\[data-type="income"\]::before \{ background: var\(--ac-brand\); \}/);
  assert.match(css, /td\[data-type="expense"\]::before \{ background: var\(--ac-negative\); \}/);
  assert.match(css, /select\[data-field="type"\] \{[^}]*appearance: none/);
});
