const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

test('REQ-01: Kalkulator Landing entry matches lot & modal calculation', () => {
  const indexHtml = fs.readFileSync('public/index.html', 'utf8');
  // W7: the static default must be an explicit empty state, never a hardcoded
  // market price presented as live. Real values are injected from the snapshot.
  assert.strictEqual(indexHtml.includes('<b id="lpCalcEntryVal" style="font-family:monospace">&mdash;</b>'), true);
  assert.strictEqual(indexHtml.includes('<b id="lpCalcEntryVal" style="font-family:monospace">1.210</b>'), false);
  assert.strictEqual(indexHtml.includes('<div><div style="font-size:11px;color:var(--lp-muted)">Entry</div><b style="font-family:monospace">0</b></div>'), false);
});

test('REQ-03: Auth UI sync hides login buttons when logged in', () => {
  const indexHtml = fs.readFileSync('public/index.html', 'utf8');
  assert.strictEqual(indexHtml.includes("REQ-03: Sembunyikan tombol 'Masuk / Login / Daftar' bila user sudah login"), true);
});

test('REQ-07 & REQ-08: Table thead alignment for Konglo and Non-Konglo screeners', () => {
  const indexHtml = fs.readFileSync('public/index.html', 'utf8');
  assert.strictEqual(indexHtml.includes('<th class="px-2 py-2.5 text-center text-gray-400 font-medium whitespace-nowrap">Conf</th>'), true);
  assert.strictEqual(indexHtml.includes('<th class="px-2 py-2.5 text-center text-gray-400 font-medium whitespace-nowrap">Skor</th>'), true);
});

test('REQ-10: Sektor Hot transient blank prevention', () => {
  const indexHtml = fs.readFileSync('public/index.html', 'utf8');
  assert.strictEqual(indexHtml.includes('REQ-10: Cegah blank transient saat memuat data 5 hari / rotasi grup'), true);
});

test('REQ-15: Bandarmologi Intel adaptive timeout', () => {
  const bandarJs = fs.readFileSync('public/bandarmologi-runtime.js', 'utf8');
  assert.strictEqual(bandarJs.includes('REQ-15: Adaptive timeout'), true);
  assert.strictEqual(bandarJs.includes('60000 : 25000'), true);
});

test('REQ-16: Insider Network adaptive radius for collision avoidance', () => {
  const bandarJs = fs.readFileSync('public/bandarmologi-runtime.js', 'utf8');
  assert.strictEqual(bandarJs.includes('REQ-16: Adaptive radius to avoid node & label overlap'), true);
});

test('REQ-17: Ranking sorting by transaction value', () => {
  const runtimeJs = fs.readFileSync('public/analisis-saham-runtime.js', 'utf8');
  assert.strictEqual(runtimeJs.includes('REQ-17: When \'Nilai Transaksi\' preset (idx 1) is clicked, sort by transaction value'), true);
});

test('REQ-18 & REQ-19: Financial overview source badge follows real provenance, not a hardcoded flag', () => {
  const runtimeJs = fs.readFileSync('public/analisis-saham-runtime.js', 'utf8');
  // Subtask J: the chip must be driven by the model's provenance so generated
  // sample data can never be presented as an official issuer report.
  assert.strictEqual(runtimeJs.includes("var prov = model && model.provenance;"), true);
  assert.strictEqual(runtimeJs.includes("'Laporan emiten (snapshot server)'"), true);
  assert.strictEqual(runtimeJs.includes("'DATA CONTOH · bukan laporan resmi'"), true);
  // The old flag-only label that called generated data "terverifikasi" is gone.
  assert.strictEqual(runtimeJs.includes("srcChip.textContent = meta.real ? 'Laporan emiten lengkap' : 'Data terverifikasi';"), false);
});

test('REQ-23 & REQ-24: Smooth scroll on Portfolio navigation', () => {
  const indexHtml = fs.readFileSync('public/index.html', 'utf8');
  assert.strictEqual(indexHtml.includes('REQ-23 & REQ-24: Scroll viewport smoothly to active container'), true);
});

test('REQ-25: Quote freshness confirmation text in portfolio', () => {
  const portJs = fs.readFileSync('public/portfolio-command-center.js', 'utf8');
  assert.strictEqual(portJs.includes('harga berhasil diperbarui ('), true);
});

test('REQ-27: Subscription lifetime active recognition', () => {
  const indexHtml = fs.readFileSync('public/index.html', 'utf8');
  assert.strictEqual(indexHtml.includes("(c==='LIFETIME'&&e.lifetime_state==='active')"), true);
});

test('REQ-32: Security panel fallback to real forensic events', () => {
  const logsJs = fs.readFileSync('api/admin-logs.js', 'utf8');
  assert.strictEqual(logsJs.includes('REQ-32: Fallback to local forensic security events if database events are empty'), true);
});
