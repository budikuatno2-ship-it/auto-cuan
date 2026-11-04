#!/usr/bin/env node
'use strict';

/**
 * FASE 10B helper #2 — discover the concrete VPS filenames for the pipeline
 * stages named in the new schedule (broker-hunter indexer, bandarmologi intel,
 * insider tiered scheduler, domestic broksum compile, screeners).
 */

const { ssh } = require('../tools/fase7-ssh');

const PROBES = [
  'ls -1 /home/ubuntu/auto-cuan/tools/ | grep -i hunter',
  'ls -1 /home/ubuntu/auto-cuan/tools/ | grep -i bandarmologi',
  'ls -1 /home/ubuntu/auto-cuan/tools/ | grep -i intel',
  'ls -1 /home/ubuntu/auto-cuan/tools/ | grep -i accumulator',
  'ls -1 /home/ubuntu/auto-cuan/tools/ | grep -i akumulasi',
  'ls -1 /home/ubuntu/auto-cuan/tools/ | grep -i broksum',
  'ls -1 /home/ubuntu/auto-cuan/tools/ | grep -i insider',
  'ls -1 /home/ubuntu/auto-cuan/scripts/ | grep -i insider',
  'ls -1 /home/ubuntu/auto-cuan/scripts/ | grep -i hunter',
  'ls -1 /home/ubuntu/auto-cuan/scripts/ | grep -i intel',
  'ls -1 /home/ubuntu/auto-cuan/lib/ | grep -i insider',
  'ls -1 /home/ubuntu/auto-cuan/lib/ | grep -i hunter',
  'ls -1 /home/ubuntu/auto-cuan/deploy/vps/ | grep -i screener',
  'ls -1 /home/ubuntu/auto-cuan/deploy/vps/ | grep -i hunter',
  'ls -1 /home/ubuntu/auto-cuan/deploy/vps/ | grep -i acum',
  'ls -1 /home/ubuntu/auto-cuan/deploy/vps/ | grep -i akumulasi'
];

for (const p of PROBES) {
  let out = '';
  try {
    out = ssh(p).trim();
  } catch (e) {
    out = 'ERR ' + (e.stderr || e.message);
  }
  console.log('### ' + p);
  console.log(out || '(kosong)');
  console.log('');
}
