'use strict';

const { execSync } = require('child_process');

const SSH_KEY_PATH = 'D:\\Private Key Oracle\\ssh-key-2026-07-02.key';
const VPS_HOST = 'ubuntu@168.110.221.197';

function runSsh(cmd) {
  return execSync(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 -i "${SSH_KEY_PATH}" ${VPS_HOST} "${cmd.replace(/"/g, '\\"')}"`, {
    encoding: 'utf8',
    maxBuffer: 15 * 1024 * 1024
  });
}

function main() {
  console.log('--- 1. Searching for "flow=" or "fetchBrokerSummary" on VPS ---');
  try {
    const res1 = runSsh('grep -rni "flow=" /home/ubuntu/ 2>/dev/null | grep -v "node_modules" | grep -v ".git" | head -n 30');
    console.log('grep "flow=":\n', res1);
  } catch (e) { console.log('None found or error:', e.message); }

  console.log('--- 2. Checking crontab on VPS ---');
  try {
    const crontab = runSsh('crontab -l 2>/dev/null');
    console.log('Crontab:\n', crontab);
  } catch (e) { console.log('Crontab empty or error:', e.message); }

  console.log('--- 3. Checking if any broker-summary folder has foreign subfolders ---');
  try {
    const res2 = runSsh('find /home/ubuntu/auto-cuan/data/arjum-data/ -type d -name "*foreign*" -o -name "*flow*" 2>/dev/null');
    console.log('Found dirs:\n', res2);
  } catch (e) {}

  console.log('--- 4. Checking if any table in market.sqlite stores foreign broksum ---');
  try {
    const res3 = runSsh('sqlite3 -readonly /home/ubuntu/auto-cuan-data/market.sqlite "SELECT DISTINCT table_name FROM market_rows WHERE table_name LIKE \'%broker%\' OR table_name LIKE \'%foreign%\';"');
    console.log('Matching tables in SQLite:\n', res3);
  } catch (e) {}
}

main();
