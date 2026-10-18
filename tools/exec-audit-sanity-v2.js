'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');

const SSH_KEY = 'D:/Private Key Oracle/ssh-key-2026-07-02.key';
const VPS_HOST = 'ubuntu@168.110.221.197';

function ssh(cmd, opts) {
  return execFileSync('ssh', [
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-i', SSH_KEY, VPS_HOST, cmd
  ], Object.assign({ encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }, opts || {}));
}

execFileSync('scp', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-i', SSH_KEY,
  'tools/audit-broksum-sanity-vps.js', `${VPS_HOST}:/tmp/audit-broksum-sanity-vps.js`]);

console.log('=== Running v2 scan ===');
console.log(ssh('/home/ubuntu/.local/node-v22/bin/node /tmp/audit-broksum-sanity-vps.js', { timeout: 900000 }));

console.log('=== Copy report locally ===');
const raw = ssh('cat /tmp/broksum_sanity_report_v2.json', { maxBuffer: 128 * 1024 * 1024 });
fs.writeFileSync('tmp_broksum_sanity_v2.json', raw);
console.log('Saved tmp_broksum_sanity_v2.json', raw.length, 'bytes');
