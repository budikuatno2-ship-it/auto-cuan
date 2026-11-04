#!/usr/bin/env node
'use strict';

const { ssh } = require('../tools/fase7-ssh');

const PARTS = [
  'echo "--- ionice ---"; command -v ionice || echo NO_IONICE',
  'echo "--- timeout ---"; command -v timeout || echo NO_TIMEOUT',
  'echo "--- flock ---"; command -v flock || echo NO_FLOCK',
  'echo "--- nice ---"; command -v nice || echo NO_NICE',
  'echo "--- check-candle-coverage ---"; [ -f /home/ubuntu/auto-cuan/tools/check-candle-coverage.js ] && echo ADA || echo HILANG',
  'echo "--- direct-refresh-landing ---"; [ -f /home/ubuntu/auto-cuan/tools/direct-refresh-landing.js ] && echo ADA || echo HILANG',
  'echo "--- run-lifecycle-evaluator ---"; [ -f /home/ubuntu/auto-cuan/deploy/vps/run-lifecycle-evaluator.sh ] && echo ADA || echo HILANG',
  'echo "--- admin notes expiry candidates ---"; grep -rlE "expire.*admin|admin.*expire|catatan.*expire" /home/ubuntu/auto-cuan/tools /home/ubuntu/auto-cuan/lib 2>/dev/null | head -10 || echo NONE',
  'echo "--- top5 in screener runner ---"; grep -oE "top5|Top5|TOP5" /home/ubuntu/auto-cuan/tools/run-all-screeners-vps.js | sort -u | head -5 || echo NONE',
  'echo "--- run-all-screeners-vps modes ---"; grep -oE "mode=[a-z-]+" /home/ubuntu/auto-cuan/tools/run-all-screeners-vps.js | sort -u | head -20 || echo NONE',
  'echo "--- node version ---"; /home/ubuntu/.local/node-v22/bin/node --version',
  'echo "--- crontab file size ---"; wc -c /home/ubuntu/auto-cuan-runner/final-schedule.cron 2>/dev/null || echo NONE',
  'echo "--- logs dir sample ---"; ls -1 /home/ubuntu/auto-cuan-runner/logs | head -30'
];

console.log(ssh(PARTS.join('; ')));
