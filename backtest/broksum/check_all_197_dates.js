'use strict';

const { execSync } = require('child_process');

const SSH_KEY_PATH = 'D:\\Private Key Oracle\\ssh-key-2026-07-02.key';
const VPS_HOST = 'ubuntu@168.110.221.197';

const remoteCode = `
const fs = require('fs');
const path = require('path');
const baseDir = '/home/ubuntu/auto-cuan/data/arjum-data/broker-summary';

const files = fs.readdirSync(path.join(baseDir, 'BRPT'))
  .filter(f => f.endsWith('.json') && f !== 'latest.json')
  .sort();

console.log('Total files for BRPT:', files.length);
console.log('First file:', files[0]);
console.log('Last file:', files[files.length - 1]);

// Check BBCA and MEDC as well
const bbcaFiles = fs.readdirSync(path.join(baseDir, 'BBCA'))
  .filter(f => f.endsWith('.json') && f !== 'latest.json')
  .sort();
console.log('Total files for BBCA:', bbcaFiles.length, bbcaFiles[0], bbcaFiles[bbcaFiles.length - 1]);

const medcFiles = fs.readdirSync(path.join(baseDir, 'MEDC'))
  .filter(f => f.endsWith('.json') && f !== 'latest.json')
  .sort();
console.log('Total files for MEDC:', medcFiles.length, medcFiles[0], medcFiles[medcFiles.length - 1]);
`;

function main() {
  const out = execSync(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 -i "${SSH_KEY_PATH}" ${VPS_HOST} node`, {
    input: remoteCode,
    maxBuffer: 10 * 1024 * 1024,
    encoding: 'utf8'
  });
  console.log(out);
}

main();
