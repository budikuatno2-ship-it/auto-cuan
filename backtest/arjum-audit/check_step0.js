'use strict';
const fs = require('fs');
const path = require('path');

// load env
const envCandidates = [
  '/home/ubuntu/auto-cuan-runner/.env',
  '/home/ubuntu/auto-cuan/.env'
];
for (const envPath of envCandidates) {
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq > 0) {
        const k = t.slice(0, eq).trim();
        let v = t.slice(eq + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (!process.env[k]) process.env[k] = v;
      }
    }
  }
}

const arjumClient = require('/home/ubuntu/auto-cuan/lib/arjum-client');
const quotaTracker = require('/home/ubuntu/auto-cuan/lib/arjum-quota-tracker');

console.log('configuredDailyQuota:', arjumClient.getConfiguredDailyQuota());
console.log('usedToday:', quotaTracker.getUsedToday());
console.log('remaining:', arjumClient.getConfiguredDailyQuota() - quotaTracker.getUsedToday());
console.log('isCircuitBreakerTripped:', arjumClient.isCircuitBreakerTripped());
