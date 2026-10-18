'use strict';

const { execFileSync } = require('child_process');

const SSH_KEY = 'D:/Private Key Oracle/ssh-key-2026-07-02.key';
const VPS_HOST = 'ubuntu@168.110.221.197';

function ssh(remoteCmd) {
  console.log(`[SSH] ${remoteCmd}`);
  const out = execFileSync('ssh', [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=15',
    '-i', SSH_KEY,
    VPS_HOST,
    remoteCmd
  ], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });
  console.log(out);
  return out;
}

console.log('=== 1. Disk space (df -h) ===');
ssh('df -h /home/ubuntu');

console.log('=== 2. Inodes (df -i) ===');
ssh('df -i /home/ubuntu');

console.log('=== 3. Folder sizes (human readable) ===');
const dirs = [
  '/home/ubuntu/auto-cuan/data/arjum-data/broker-summary',
  '/home/ubuntu/auto-cuan/data/arjum-data/broker-summary-F',
  '/home/ubuntu/auto-cuan/data/arjum-data/broker-accumulation',
  '/home/ubuntu/auto-cuan/data/arjum-data/insiders',
  '/home/ubuntu/auto-cuan/data/daily-candles',
  '/home/ubuntu/auto-cuan/data/arjum-data/_backup-broksum-25',
  '/home/ubuntu/auto-cuan/data/arjum-data/_backfill',
  '/home/ubuntu/auto-cuan-runner/logs',
  '/home/ubuntu/.pm2/logs',
  '/home/ubuntu/auto-cuan/node_modules',
  '/home/ubuntu/auto-cuan/.git'
];
for (const d of dirs) {
  try {
    ssh(`du -sh "${d}" 2>/dev/null || echo "NOT_EXIST: ${d}"`);
  } catch (_) {}
}

console.log('=== 4. File counts ===');
for (const d of dirs) {
  try {
    ssh(`find "${d}" -type f 2>/dev/null | wc -l`);
  } catch (_) {}
}

console.log('=== 5. Quarantine folders ===');
ssh('ls -d /home/ubuntu/auto-cuan/data/arjum-data/_quarantine-* 2>/dev/null | head -20');
