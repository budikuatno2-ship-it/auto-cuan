'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const maintenanceHtml = fs.readFileSync(path.join(ROOT, 'public', 'maintenance.html'), 'utf8');
const vercelJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const localDevServer = fs.readFileSync(path.join(ROOT, 'tools', 'local-dev-server.js'), 'utf8');

test('Maintenance screen HTML markup contains canvas elements, dynamic status, and progress track', () => {
  // Title matching canvas
  assert.match(maintenanceHtml, /Kami sedang memperbarui sistem/);

  // Brand and scheduled badge
  assert.match(maintenanceHtml, /Auto-Cuan/);
  assert.match(maintenanceHtml, /Pemeliharaan terjadwal/);

  // Dynamic explanation & ETA elements
  assert.match(maintenanceHtml, /id="maintenanceReasonText"/);
  assert.match(maintenanceHtml, /id="maintenanceProgressTrack"/);
  assert.match(maintenanceHtml, /id="maintenanceStartTime"/);
  assert.match(maintenanceHtml, /id="maintenanceEtaTime"/);

  // Status fact rows
  assert.match(maintenanceHtml, /Tetap aman:/);
  assert.match(maintenanceHtml, /Sementara tidak tersedia:/);
  assert.match(maintenanceHtml, /Yang bisa Anda lakukan:/);

  // Check status button and interactive feedback
  assert.match(maintenanceHtml, /id="checkStatusBtn"/);
  assert.match(maintenanceHtml, /Cek status sekarang/);
  assert.match(maintenanceHtml, /id="checkStatusFeedback"/);

  // Admin login bypass affordance
  assert.match(maintenanceHtml, /Masuk sebagai admin/);
  assert.match(maintenanceHtml, /href="\/login\?admin=1"/);

  // Decorative wave SVG
  assert.match(maintenanceHtml, /<svg class="wave"/);

  // Zero internal provider names or VPS infrastructure terms
  assert.doesNotMatch(maintenanceHtml, /arjum/i);
  assert.doesNotMatch(maintenanceHtml, /cron/i);
  assert.doesNotMatch(maintenanceHtml, /<th>Alamat IP<\/th>/i);
});

test('Maintenance screen rewrites are registered in vercel.json and local-dev-server.js', () => {
  const rewriteMaint = vercelJson.rewrites.find(r => r.source === '/maintenance');
  assert.ok(rewriteMaint, 'expected rewrite rule for /maintenance');
  assert.equal(rewriteMaint.destination, '/maintenance.html');

  const rewritePemeliharaan = vercelJson.rewrites.find(r => r.source === '/pemeliharaan');
  assert.ok(rewritePemeliharaan, 'expected rewrite rule for /pemeliharaan');
  assert.equal(rewritePemeliharaan.destination, '/maintenance.html');

  assert.match(localDevServer, /'\/maintenance':\s*'\/maintenance\.html'/);
  assert.match(localDevServer, /'\/pemeliharaan':\s*'\/maintenance\.html'/);
});
