'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const SSH_KEY_PATH = 'D:\\Private Key Oracle\\ssh-key-2026-07-02.key';
const VPS_HOST = 'ubuntu@168.110.221.197';

function sha(s) {
  return crypto.createHash('sha256').update(s.split('\r\n').join('\n')).digest('hex');
}

const files = [
  'lib/arjum-client.js',
  'lib/bandarmologi-service.js',
  'tools/run-daily-broker-update.js'
];

// Local branch working copies
const local = {};
files.forEach(f => {
  local[f] = sha(fs.readFileSync(f, 'utf8'));
});

// VPS: HEAD version vs working version
const script = `
const { execSync } = require('child_process');
const crypto = require('crypto');
const files = ${JSON.stringify(files)};
const out = {};
files.forEach(f => {
  const head = execSync('cd /home/ubuntu/auto-cuan && git show HEAD:' + f, { encoding: 'utf8', maxBuffer: 10*1024*1024 });
  const work = require('fs').readFileSync('/home/ubuntu/auto-cuan/' + f, 'utf8');
  out[f] = {
    head: crypto.createHash('sha256').update(head.split('\\r\\n').join('\\n')).digest('hex'),
    work: crypto.createHash('sha256').update(work.split('\\r\\n').join('\\n')).digest('hex')
  };
});
console.log(JSON.stringify(out));
`;

const vpsRaw = execSync(`ssh -o StrictHostKeyChecking=no -i "${SSH_KEY_PATH}" ${VPS_HOST} node`, {
  input: script, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024
});
const vps = JSON.parse(vpsRaw.trim());

console.log('=== Classification ===');
files.forEach(f => {
  const l = local[f];
  const isWorkMine = vps[f].work === l;
  const isHeadDifferent = vps[f].head !== vps[f].work;
  console.log(`\n${f}`);
  console.log(`  VPS HEAD == VPS WORKING? ${!isHeadDifferent}  (changed=${isHeadDifferent})`);
  console.log(`  VPS WORKING == LOCAL BRANCH WORKING? ${isWorkMine}`);
});