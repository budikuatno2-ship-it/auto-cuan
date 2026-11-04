#!/usr/bin/env node
'use strict';

/**
 * FASE 10B helper #3 — exit-code tolerant probe. `grep` returning 1 must not
 * be reported as a transport failure.
 */

const { ssh } = require('../tools/fase7-ssh');

const PROBES = [
  'ls -1 /home/ubuntu/auto-cuan/scripts/ || true',
  'ls -1 /home/ubuntu/auto-cuan/deploy/vps/ || true',
  'ls -1 /home/ubuntu/auto-cuan/tools/ | grep -iE "insider|sector|screen|screener|landing|context" || echo NONE',
  'ls -1 /home/ubuntu/auto-cuan/lib/ | grep -iE "insider|sector|screen" || echo NONE',
  'echo "--- run-all-screeners? ---"; ls -la /home/ubuntu/auto-cuan/deploy/vps/run-all-screeners.sh 2>&1 || true',
  'echo "--- run-insider-refresh? ---"; ls -la /home/ubuntu/auto-cuan/deploy/vps/run-insider-refresh.sh 2>&1 || true',
  'echo "--- run-fundamental-refresh content ---"; cat /home/ubuntu/auto-cuan/deploy/vps/run-fundamental-refresh.sh || true',
  'echo "--- run-catchup content ---"; cat /home/ubuntu/auto-cuan/deploy/vps/run-catchup-missing-dates.sh || true',
  'echo "--- run-broker-accumulation content ---"; cat /home/ubuntu/auto-cuan/deploy/vps/run-broker-accumulation.sh || true',
  'echo "--- run-sector-hot content ---"; cat /home/ubuntu/auto-cuan/deploy/vps/run-sector-hot.sh || true'
];

for (const p of PROBES) {
  let out = '';
  try {
    out = ssh(p).trim();
  } catch (e) {
    const stderr = e && e.stderr ? String(e.stderr).trim() : '';
    out = 'SSH_ERR ' + stderr + ' ' + (e && e.message ? e.message : '');
  }
  console.log('### ' + p);
  console.log(out || '(kosong)');
  console.log('');
}
