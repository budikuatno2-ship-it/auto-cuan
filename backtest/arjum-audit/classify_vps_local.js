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

// Untracked code files that should match my branch
const untracked = ['lib/broksum-flow.js', 'lib/broker-accumulation-local.js', 'tools/backfill-broksum.js'];
const local = {};
untracked.forEach(f => { local[f] = sha(fs.readFileSync(f, 'utf8')); });

const script = `
const fs = require('fs');
const crypto = require('crypto');
const files = ${JSON.stringify(untracked)};
const out = {};
files.forEach(f => {
  const p = '/home/ubuntu/auto-cuan/' + f;
  if (fs.existsSync(p)) {
    out[f] = crypto.createHash('sha256').update(fs.readFileSync(p,'utf8').split('\\r\\n').join('\\n')).digest('hex');
  } else {
    out[f] = 'MISSING';
  }
});
console.log(JSON.stringify(out));
`;
const vps = JSON.parse(execSync(`ssh -o StrictHostKeyChecking=no -i "${SSH_KEY_PATH}" ${VPS_HOST} node`, { input: script, encoding: 'utf8', maxBuffer: 20*1024*1024 }).trim());

console.log('=== Untracked code files vs local branch ===');
untracked.forEach(f => {
  console.log(`${f}: match=${vps[f] === local[f]}`);
});

// Inspect the data-file diffs (bandarmologi-intel-indexes)
const dscript = `
const { execSync } = require('child_process');
const diff = execSync('cd /home/ubuntu/auto-cuan && git diff --stat data/bandarmologi-intel-indexes/', { encoding: 'utf8' });
console.log(diff);
`;
console.log('=== Data file diff stat ===');
console.log(execSync(`ssh -o StrictHostKeyChecking=no -i "${SSH_KEY_PATH}" ${VPS_HOST} node`, { input: dscript, encoding: 'utf8' }).trim());