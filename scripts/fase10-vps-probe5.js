#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { ssh } = require('../tools/fase7-ssh');

const ROOT = path.resolve(__dirname, '..');

console.log('=== LOCAL: fetch-ihsg-candle.js source strategy ===');
const ihsg = fs.readFileSync(path.join(ROOT, 'tools/fetch-ihsg-candle.js'), 'utf8');
ihsg.split(/\r?\n/).forEach((l, i) => {
  if (/yahoo|Yahoo|arjum|source|fetchDaily/i.test(l)) console.log((i + 1) + ': ' + l.trim().slice(0, 150));
});

console.log('\n=== LOCAL: backfill-broksum.js args ===');
const bb = fs.readFileSync(path.join(ROOT, 'tools/backfill-broksum.js'), 'utf8');
bb.split(/\r?\n/).forEach((l, i) => {
  if (/args\.(includes|indexOf)|--[a-z-]+/.test(l)) console.log((i + 1) + ': ' + l.trim().slice(0, 150));
});

console.log('\n=== VPS: extra path existence ===');
const paths = [
  '/home/ubuntu/auto-cuan/tools/run-after-market-top5-lock.js',
  '/home/ubuntu/auto-cuan/tools/run-bandarmologi-intel.js',
  '/home/ubuntu/auto-cuan/tools/run-broker-hunter-indexer.js',
  '/home/ubuntu/auto-cuan/tools/build-domestic-broksum-and-accum.js',
  '/home/ubuntu/auto-cuan/tools/fetch-ihsg-candle.js',
  '/home/ubuntu/auto-cuan/tools/check-candle-coverage.js',
  '/home/ubuntu/auto-cuan/deploy/vps/run-screeners-preflight.sh',
  '/home/ubuntu/auto-cuan/deploy/vps/run-broker-hunter-indexer.sh'
];
console.log(ssh(paths.map((p) => `[ -e ${p} ] && echo "ADA    ${p}" || echo "HILANG ${p}"`).join('; ')));

console.log('\n=== VPS: pm2 local app port ===');
try {
  console.log(ssh('curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1:3000/ 2>/dev/null || echo NO_LOCAL_APP'));
} catch (e) {
  console.log('ERR ' + e.message);
}
