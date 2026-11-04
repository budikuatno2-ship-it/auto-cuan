#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ssh } = require('../tools/fase7-ssh');

const ROOT = path.resolve(__dirname, '..');
const FILES = [
  'tools/catchup-missing-dates.js',
  'tools/run-fundamental-refresh.js',
  'tools/backfill-arjum-data.js',
  'tools/backfill-broksum.js',
  'tools/collect-insider-data.js',
  'tools/run-daily-broker-update.js',
  'lib/arjum-client.js',
  'lib/arjum-quota-tracker.js',
  'lib/insider-tiered-scheduler.js',
  'lib/liquidity-profiler.js',
  'lib/admin-notes-handler.js',
  'deploy/vps/run-catchup-missing-dates.sh',
  'deploy/vps/run-fundamental-refresh.sh',
  'deploy/vps/run-historical-backfill.sh',
  'deploy/vps/final-schedule.cron'
];

const remote = ssh(FILES.map((f) => `md5sum /home/ubuntu/auto-cuan/${f} 2>/dev/null || echo "MISSING ${f}"`).join('; '));
const remoteMap = new Map();
for (const line of remote.trim().split(/\r?\n/)) {
  const m = /^([0-9a-f]{32})\s+(.+)$/.exec(line.trim());
  if (m) remoteMap.set(m[2].replace('/home/ubuntu/auto-cuan/', ''), m[1]);
  const mm = /^MISSING\s+(.+)$/.exec(line.trim());
  if (mm) remoteMap.set(mm[1], 'MISSING');
}

let same = 0;
let diff = 0;
let missing = 0;
for (const f of FILES) {
  const localPath = path.join(ROOT, f);
  let localHash = 'LOCAL_MISSING';
  if (fs.existsSync(localPath)) {
    localHash = crypto.createHash('md5').update(fs.readFileSync(localPath)).digest('hex');
  }
  const r = remoteMap.get(f) || 'MISSING';
  let verdict;
  if (r === 'MISSING') { verdict = 'VPS_MISSING'; missing += 1; }
  else if (r === localHash) { verdict = 'IDENTIK'; same += 1; }
  else { verdict = 'BEDA'; diff += 1; }
  console.log(`${verdict.padEnd(12)} ${f}  local=${localHash.slice(0, 8)} vps=${String(r).slice(0, 8)}`);
}
console.log(`\nRINGKASAN: identik=${same} beda=${diff} vps_missing=${missing} dari ${FILES.length}`);
