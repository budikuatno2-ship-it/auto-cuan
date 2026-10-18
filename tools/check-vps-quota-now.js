'use strict';

const { execFileSync } = require('child_process');

const SSH_KEY = 'D:/Private Key Oracle/ssh-key-2026-07-02.key';
const VPS_HOST = 'ubuntu@168.110.221.197';

function ssh(remoteCmd) {
  return execFileSync('ssh', [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=15',
    '-i', SSH_KEY,
    VPS_HOST,
    remoteCmd
  ], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });
}

console.log(ssh('node -e "const qt = require(\\\"/home/ubuntu/auto-cuan/lib/arjum-quota-tracker\\\"); const ac = require(\\\"/home/ubuntu/auto-cuan/lib/arjum-client\\\"); console.log({ configured: ac.getConfiguredDailyQuota(), used: qt.getUsedToday(), remaining: qt.getRemainingToday(ac.getConfiguredDailyQuota()) });"'));
