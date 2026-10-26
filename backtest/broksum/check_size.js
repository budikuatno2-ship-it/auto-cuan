'use strict';

const { execSync } = require('child_process');

const SSH_KEY_PATH = 'D:\\Private Key Oracle\\ssh-key-2026-07-02.key';
const VPS_HOST = 'ubuntu@168.110.221.197';

function main() {
  const out = execSync(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 -i "${SSH_KEY_PATH}" ${VPS_HOST} "du -sh /home/ubuntu/auto-cuan/data/arjum-data/broker-summary"`, { encoding: 'utf8' });
  console.log('Size of broker-summary on VPS:', out.trim());
}

main();
