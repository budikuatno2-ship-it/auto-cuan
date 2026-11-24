#!/usr/bin/env node
'use strict';
/**
 * V6.5 SINGLE DISPATCHER — unified production & offline cron entry.
 *
 * Reads AUTO_CUAN_DISPATCHER_REALM (PRODUCTION | OFFLINE, default OFFLINE).
 *  - PRODUCTION -> lib/v6-production-job-adapters.cjs (locked, quota-buffered, canary BBCA)
 *  - OFFLINE    -> lib/v6-scheduler-dispatcher.cjs + lib/v6-scheduler-adapters.cjs
 */

const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');

process.env.ADMIN_SCHEDULE_CONFIG_PATH = process.env.ADMIN_SCHEDULE_CONFIG_PATH || path.join(ROOT, 'data', 'admin-schedule-config.json');
const store = require(path.join(ROOT, 'lib', 'admin-schedule-store.js'));
const { createDispatcher } = require(path.join(ROOT, 'lib', 'v6-scheduler-dispatcher.cjs'));
const { createAdapters } = require(path.join(ROOT, 'lib', 'v6-scheduler-adapters.cjs'));
const { runProductionCycle } = require(path.join(ROOT, 'lib', 'v6-production-job-adapters.cjs'));

const realm = String(process.env.AUTO_CUAN_DISPATCHER_REALM || 'OFFLINE').trim().toUpperCase();
const stateDir = process.env.AUTO_CUAN_V6_DISPATCHER_STATE_DIR || '/home/ubuntu/auto-cuan-data/v6-dispatcher-state';

(async () => {
  if (realm === 'PRODUCTION') {
    const result = await runProductionCycle({ rootDir: ROOT, stateDir });
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }

  const schedule = store.get();
  if (!schedule.ok || !Number.isSafeInteger(schedule.doc.version)) {
    process.stdout.write(JSON.stringify({ status: 'SCHEDULE_UNKNOWN', at: new Date().toISOString() }) + '\n');
    return;
  }
  const adapterOptions = {
    realm: 'OFFLINE',
    cachedDir: path.join(stateDir, 'cache'),
    outputDir: path.join(stateDir, 'outputs')
  };
  const adapters = createAdapters(adapterOptions);
  const dispatcher = createDispatcher({
    statePath: path.join(stateDir, 'worker.json'),
    adapterOptions,
    adapters,
    legacyGuard: true,
    random: Math.random
  });
  const result = await dispatcher.cycle();
  process.stdout.write(JSON.stringify({
    at: new Date().toISOString(),
    scheduleVersion: schedule.doc.version,
    status: result.status,
    date: result.date,
    realm: result.realm,
    ran: (result.ran || []).map(r => r.job),
    blocked: (result.blocked || []).map(b => ({ job: b.job, reason: b.reason })),
    httpRequests: result.usage ? result.usage.httpRequests : 0,
    billedUnits: result.usage ? result.usage.billedUnits : 0
  }) + '\n');
})().catch((err) => {
  process.stderr.write('DISPATCHER_FAILED_CLOSED: ' + String(err && err.message || err) + '\n');
  process.exitCode = 1;
});
