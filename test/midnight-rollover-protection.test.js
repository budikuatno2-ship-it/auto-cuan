'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const market = require('../tools/run-daily-market-update');
const broker = require('../tools/run-daily-broker-update');

async function withTempState(fn) {
  const old = process.env.ARJUM_DATA_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'market-rollover-'));
  process.env.ARJUM_DATA_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (old == null) delete process.env.ARJUM_DATA_DIR;
    else process.env.ARJUM_DATA_DIR = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function markComplete(date) {
  broker.writeMarker(date, { version: 2, complete: true });
  fs.mkdirSync(market.stateDir(), { recursive: true });
  fs.writeFileSync(path.join(market.stateDir(), date + '.json'), JSON.stringify({ date, complete: true }));
}

function markIncomplete(date) {
  broker.writeMarker(date, { version: 2, complete: false });
  fs.mkdirSync(market.stateDir(), { recursive: true });
  fs.writeFileSync(path.join(market.stateDir(), date + '.json'), JSON.stringify({ date, complete: false }));
}

test('BUG-03: Midnight rollover protection and startTime locking', async (t) => {
  await t.test('1. Locks target date when startTime is passed even if currentTime is past midnight', async () => {
    await withTempState(async () => {
      markComplete('2026-09-30');
      // Job initiated at 23:30 WIB on 2026-10-01 (trading day)
      const startTime = new Date('2026-10-01T23:30:00+07:00');
      // Execution evaluation at 00:15 WIB next day (2026-10-02)
      const afterMidnight = new Date('2026-10-02T00:15:00+07:00');

      const dates = market.pendingDates(afterMidnight, { startTime });
      assert.deepEqual(dates, ['2026-10-01'], 'Must retain 2026-10-01 target date and not abort');
    });
  });

  await t.test('2. Honors explicit --date via options or argv regardless of hour', async () => {
    await withTempState(async () => {
      // Midnight 01:00 WIB
      const midnightTime = new Date('2026-10-02T01:00:00+07:00');

      const datesFromOpt = market.pendingDates(midnightTime, { date: '2026-09-29' });
      assert.deepEqual(datesFromOpt, ['2026-09-29'], 'Should honor options.date');

      const datesFromArgv = market.pendingDates(midnightTime, { argv: ['--date=2026-09-28'] });
      assert.deepEqual(datesFromArgv, ['2026-09-28'], 'Should honor --date= argument');

      const datesFromSeparateArgv = market.pendingDates(midnightTime, { argv: ['--date', '2026-09-27'] });
      assert.deepEqual(datesFromSeparateArgv, ['2026-09-27'], 'Should honor --date value argument');
    });
  });

  await t.test('3. Rollover tolerance: running between 00:00-04:00 WIB with rollover finishes yesterday batch', async () => {
    await withTempState(async () => {
      markComplete('2026-09-30');
      markIncomplete('2026-10-01');

      // Launched at 01:30 WIB on 2026-10-02 to finish yesterday's batch
      const earlyMorning = new Date('2026-10-02T01:30:00+07:00');

      const dates = market.pendingDates(earlyMorning, { rollover: true });
      assert.deepEqual(dates, ['2026-10-01'], 'Should continue yesterday incomplete session during 00:00-04:00 WIB');
    });
  });

  await t.test('4. Weekend rollover tolerance: Friday night run crossing into Saturday morning 01:00 WIB', async () => {
    await withTempState(async () => {
      markComplete('2026-10-01');
      markIncomplete('2026-10-02'); // Friday trading day

      // Saturday 01:00 WIB (2026-10-03 is Saturday)
      const saturdayEarlyMorning = new Date('2026-10-03T01:00:00+07:00');

      const dates = market.pendingDates(saturdayEarlyMorning, { rollover: true });
      assert.deepEqual(dates, ['2026-10-02'], 'Should preserve Friday batch on Saturday early morning');
    });
  });

  await t.test('5. run() locks startTime so crossing midnight completes successfully without code 3 bail-out', async () => {
    await withTempState(async () => {
      markComplete('2026-09-30');
      const startTime = new Date('2026-10-01T23:30:00+07:00');

      const candles = require('../tools/fetch-daily-candles');
      const origBrokerRun = broker.run;
      const origCandleMain = candles.main;

      process.exitCode = undefined;

      try {
        broker.run = async (args) => {
          broker.writeMarker(args[1], { version: 2, complete: true });
          return { skipped: true };
        };
        candles.main = async () => ({ skipped: true });
        const syncHistory = async () => ({ ok: true, rows_upserted: 1 });

        // Simulate run started at 23:30 WIB
        await market.run({
          startTime,
          syncHistory,
          argv: ['--accum-source=api', '--insider-mode=daily']
        });

        assert.strictEqual(process.exitCode, undefined, 'Run should not set non-zero exit code');

        const state = market.readMarketState('2026-10-01');
        assert.ok(state, 'State for 2026-10-01 should exist');
        assert.strictEqual(state.complete, true, '2026-10-01 should be marked complete');
      } finally {
        broker.run = origBrokerRun;
        candles.main = origCandleMain;
        process.exitCode = undefined;
      }
    });
  });
});
