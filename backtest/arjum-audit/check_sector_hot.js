'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SSH_KEY_PATH = 'D:\\Private Key Oracle\\ssh-key-2026-07-02.key';
const VPS_HOST = 'ubuntu@168.110.221.197';

const script = `
const fs = require('fs');
const path = require('path');

console.log('=== 1. CHECK SECTOR HOT JSON FILES ===');
const dataDir = '/home/ubuntu/auto-cuan/data';
const files = fs.readdirSync(dataDir).filter(f => f.startsWith('sector-hot-') && f.endsWith('.json')).sort();
console.log('Total sector-hot json files:', files.length);
console.log('Latest 5 files:', files.slice(-5));
if (files.length > 0) {
  const latestFile = path.join(dataDir, files[files.length - 1]);
  const stat = fs.statSync(latestFile);
  console.log('Latest file size:', stat.size, 'mtime:', stat.mtime.toISOString());
  try {
    const d = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
    console.log('Latest file keys:', Object.keys(d));
    console.log('Date in file:', d.date || d.updated_at || d.generated_at || 'unknown');
  } catch(e) {
    console.log('Error reading latest file:', e.message);
  }
}

console.log('\\n=== 2. CHECK SECTOR HOT .done MARKERS ===');
const stateDir = '/home/ubuntu/auto-cuan-runner/state';
if (fs.existsSync(stateDir)) {
  const doneFiles = fs.readdirSync(stateDir).filter(f => f.startsWith('sector-hot-') && f.endsWith('.done')).sort();
  console.log('Total sector-hot .done files:', doneFiles.length);
  console.log('Latest 5 .done files:', doneFiles.slice(-5));
}

console.log('\\n=== 3. CHECK SECTOR HOT RUNNER CODE & LOG ===');
const logFile = '/home/ubuntu/auto-cuan-runner/logs/sector-hot.log';
if (fs.existsSync(logFile)) {
  const stat = fs.statSync(logFile);
  console.log('sector-hot.log size:', stat.size, 'mtime:', stat.mtime.toISOString());
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\\n');
  console.log('Last 20 lines of sector-hot.log:');
  console.log(lines.slice(-20).join('\\n'));
}

console.log('\\n=== 4. CHECK scripts/refresh-sector-hot.js ===');
const rsh = '/home/ubuntu/auto-cuan/scripts/refresh-sector-hot.js';
if (fs.existsSync(rsh)) {
  const c = fs.readFileSync(rsh, 'utf8');
  console.log('refresh-sector-hot lines writing .done or json:');
  c.split('\\n').forEach((l, i) => {
    if (l.includes('.done') || l.includes('sector-hot-') || l.includes('writeFileSync') || l.includes('MARKET_GUARD')) {
      console.log((i+1) + ': ' + l.trim());
    }
  });
}
`;

const out = execSync(`ssh -o StrictHostKeyChecking=no -i "${SSH_KEY_PATH}" ${VPS_HOST} node`, {
  input: script,
  encoding: 'utf8'
});

console.log(out);
