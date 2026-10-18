'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');

const SSH_KEY = 'D:/Private Key Oracle/ssh-key-2026-07-02.key';
const VPS_HOST = 'ubuntu@168.110.221.197';

function ssh(cmd, opts) {
  return execFileSync('ssh', [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=15',
    '-i', SSH_KEY,
    VPS_HOST,
    cmd
  ], Object.assign({ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, opts || {}));
}

console.log('=== 1. Copy validator + scanner to VPS ===');
execFileSync('scp', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-i', SSH_KEY,
  'lib/broksum-validator.js', `${VPS_HOST}:/home/ubuntu/auto-cuan/lib/broksum-validator.js`]);
execFileSync('scp', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-i', SSH_KEY,
  'tools/audit-broksum-sanity-vps.js', `${VPS_HOST}:/tmp/audit-broksum-sanity-vps.js`]);

console.log('=== 2. Run scan on VPS (0 Arjum requests) ===');
const out = ssh('/home/ubuntu/.local/node-v22/bin/node /tmp/audit-broksum-sanity-vps.js', { timeout: 600000 });
console.log(out);

console.log('=== 3. Copy full report back ===');
const remote = ssh('wc -c /tmp/broksum_sanity_report.json');
console.log('Remote size:', remote.trim());
const raw = ssh('cat /tmp/broksum_sanity_report.json', { maxBuffer: 128 * 1024 * 1024 });
fs.writeFileSync('tmp_broksum_sanity_report.json', raw);
console.log('Saved locally: tmp_broksum_sanity_report.json', raw.length, 'bytes');
