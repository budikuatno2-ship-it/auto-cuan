'use strict';

const { execFileSync } = require('child_process');

const SSH_KEY_PATH = 'D:\\Private Key Oracle\\ssh-key-2026-07-02.key';
const VPS_HOST = 'ubuntu@168.110.221.197';

function runSsh(remoteCmd) {
  const args = [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=15',
    '-i', SSH_KEY_PATH,
    VPS_HOST,
    remoteCmd
  ];
  return execFileSync('ssh', args, { encoding: 'utf8', maxBuffer: 25 * 1024 * 1024 });
}

function main() {
  console.log('Searching for broker-summary on VPS...');
  try {
    const findDirs = runSsh('find /home/ubuntu -type d -name "broker-summary" 2>/dev/null');
    console.log('Found broker-summary directories:\n', findDirs);
  } catch (e) {
    console.error('Error finding dirs:', e.message);
  }

  try {
    const listArjum = runSsh('ls -la /home/ubuntu/auto-cuan/data/arjum-data/ 2>/dev/null');
    console.log('/home/ubuntu/auto-cuan/data/arjum-data/:\n', listArjum);
  } catch (e) {
    console.error('Error listing arjum-data:', e.message);
  }

  try {
    const findFiles = runSsh('find /home/ubuntu -name "*broker*" -o -name "*broksum*" 2>/dev/null | grep -v "node_modules" | grep -v ".git" | head -n 30');
    console.log('Files matching broker/broksum:\n', findFiles);
  } catch (e) {}
}

main();
