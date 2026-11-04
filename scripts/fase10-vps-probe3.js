#!/usr/bin/env node
'use strict';

const { ssh } = require('../tools/fase7-ssh');

const FILES = [
  '/home/ubuntu/auto-cuan/tools/run-broker-hunter-indexer.js',
  '/home/ubuntu/auto-cuan/tools/run-bandarmologi-intel.js',
  '/home/ubuntu/auto-cuan/tools/build-domestic-broksum-and-accum.js',
  '/home/ubuntu/auto-cuan/lib/broker-consistency.js',
  '/home/ubuntu/auto-cuan/lib/bandarmologi-intel-service.js',
  '/home/ubuntu/auto-cuan/lib/broker-hunter-service.js',
  '/home/ubuntu/auto-cuan/lib/broker-accumulation-local.js',
  '/home/ubuntu/auto-cuan/lib/arjum-quota-tracker.js',
  '/home/ubuntu/auto-cuan/tools/backfill-arjum-data.js',
  '/home/ubuntu/auto-cuan/tools/backfill-broksum.js',
  '/home/ubuntu/auto-cuan/deploy/vps/run-broker-hunter-indexer.sh',
  '/home/ubuntu/auto-cuan/deploy/vps/run-historical-backfill.sh',
  '/home/ubuntu/auto-cuan/scripts/refresh-sector-hot.js',
  '/home/ubuntu/auto-cuan/scripts/collect-daily-market-context.js'
];

const parts = FILES.map((f) => `[ -e ${f} ] && echo "ADA    ${f}" || echo "HILANG ${f}"`).join('; ');
console.log(ssh(parts + '; echo DONE'));
