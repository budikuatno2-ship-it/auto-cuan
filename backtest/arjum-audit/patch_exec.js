'use strict';

const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '..', '..', 'tools', 'run-daily-broker-update.js');
let c = fs.readFileSync(target, 'utf8');
const crlf = c.includes('\r\n');
c = c.replace(/\r\n/g, '\n');

function rep(from, to, label) {
  if (!c.includes(from)) { console.error('NOT FOUND: ' + label); process.exitCode = 1; return; }
  c = c.replace(from, to);
  console.log('OK: ' + label);
}

// 2a + 2b: change defaults
rep(
`  const accumSource = (args.find(a => a.startsWith('--accum-source=')) || '').replace('--accum-source=', '') || process.env.ACCUM_SOURCE || 'local';
  const insiderMode = (args.find(a => a.startsWith('--insider-mode=')) || '').replace('--insider-mode=', '') || process.env.INSIDER_MODE || 'priority';`,
`  // 2a: Parity test (2026-10-18) FAILED while broker-summary is still clipped to
  // 25 levels, so local accumulation is LESS accurate than Arjum's own API.
  // Keep /api/broker-accumulation as the SINGLE daily accumulation writer.
  // ACCUM_SOURCE=local stays available for historical re-derivation once the
  // all_data=true backfill is complete.
  const accumSource = (args.find(a => a.startsWith('--accum-source=')) || '').replace('--accum-source=', '') || process.env.ACCUM_SOURCE || 'api';
  // 2b: Insider stays DAILY for all stocks while the 12.060 quota holds.
  // weekly = all stocks on Saturday 01:00 + <=100 priority daily (prepared,
  // NOT enabled). Default is 'daily'.
  const insiderMode = (args.find(a => a.startsWith('--insider-mode=')) || '').replace('--insider-mode=', '') || process.env.INSIDER_MODE || 'daily';`,
'2a+2b default flags'
);

if (crlf) c = c.replace(/\n/g, '\r\n');
fs.writeFileSync(target, c, 'utf8');
console.log('Patched:', target);