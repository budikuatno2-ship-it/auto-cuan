'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const arjumClient = require('../lib/arjum-client');
const bandarmologiService = require('../lib/bandarmologi-service');
const dailyUpdate = require('../tools/run-daily-broker-update');

// run() sets process.exitCode on several non-success paths (quota stop,
// incomplete, --final failure). Reset it after every test in this file so
// one test's exit code doesn't leak into the next test or into the overall
// process exit code for the whole suite.
test.afterEach(() => { process.exitCode = undefined; });

function withTempDataDir(fn) {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-update-'));
  const origEnv = process.env.ARJUM_DATA_DIR;
  // HERMETIC: run() also triggers the intel pre-calculation, which writes the
  // PERSISTENT index dir. ARJUM_DATA_DIR alone did not cover it, so every run of
  // this test rewrote the committed data/bandarmologi-intel-indexes files
  // (verified by mtime bisection). Redirect both roots into the temp dir.
  const origIntelIndex = process.env.INTEL_INDEX_DIR;
  const origIntelCache = process.env.INTEL_CACHE_DIR;
  const origHunterIndex = process.env.BROKER_HUNTER_INDEX_DIR;
  process.env.ARJUM_DATA_DIR = tmpBase;
  process.env.INTEL_INDEX_DIR = path.join(tmpBase, 'bandarmologi-intel-indexes');
  process.env.INTEL_CACHE_DIR = path.join(tmpBase, 'bandarmologi-intel');
  process.env.BROKER_HUNTER_INDEX_DIR = path.join(tmpBase, 'broker-hunter-indexes');
  return Promise.resolve()
    .then(() => fn(tmpBase))
    .finally(() => {
      if (origEnv !== undefined) process.env.ARJUM_DATA_DIR = origEnv;
      else delete process.env.ARJUM_DATA_DIR;
      if (origIntelIndex !== undefined) process.env.INTEL_INDEX_DIR = origIntelIndex;
      else delete process.env.INTEL_INDEX_DIR;
      if (origIntelCache !== undefined) process.env.INTEL_CACHE_DIR = origIntelCache;
      else delete process.env.INTEL_CACHE_DIR;
      if (origHunterIndex !== undefined) process.env.BROKER_HUNTER_INDEX_DIR = origHunterIndex;
      else delete process.env.BROKER_HUNTER_INDEX_DIR;
      fs.rmSync(tmpBase, { recursive: true, force: true });
    });
}

function mockArjum(overrides) {
  const orig = {
    hasArjumApiKey: arjumClient.hasArjumApiKey,
    fetchBrokerSummary: arjumClient.fetchBrokerSummary,
    fetchBrokerAccumulation: arjumClient.fetchBrokerAccumulation,
    fetchInsiders: arjumClient.fetchInsiders
  };
  arjumClient.hasArjumApiKey = () => true;
  arjumClient.fetchBrokerSummary = overrides.fetchBrokerSummary || (async () => ({ ok: true, data: { top_buyers: [], top_sellers: [] } }));
  arjumClient.fetchBrokerAccumulation = overrides.fetchBrokerAccumulation || (async () => ({ ok: true, data: { series: [] } }));
  arjumClient.fetchInsiders = overrides.fetchInsiders || (async () => ({ ok: true, data: [] }));
  return () => Object.assign(arjumClient, orig);
}

test('run-daily-broker-update: a ticker with real buy/sell rows is written to disk and counted done', async () => {
  await withTempDataDir(async () => {
    const restore = mockArjum({
      fetchBrokerSummary: async () => ({ ok: true, data: { top_buyers: [{ broker: 'YU', bval: 100, sval: 0, bvol: 10, svol: 0 }], top_sellers: [] } })
    });
    try {
      await dailyUpdate.run(['--tickers', 'BBCA', '--date', '2026-09-07', '--delay', '0']);
      assert.equal(bandarmologiService.hasDiskCache('broker-summary', 'BBCA', '2026-09-07'), true);
      const marker = dailyUpdate.readMarker('2026-09-07');
      assert.equal(marker.complete, true);
    } finally {
      restore();
    }
  });
});

test('run-daily-broker-update: empty buyer/seller lists are treated as "not yet published", never cached as if they were real data', async () => {
  await withTempDataDir(async () => {
    const restore = mockArjum({
      fetchBrokerSummary: async () => ({ ok: true, data: { top_buyers: [], top_sellers: [] } })
    });
    try {
      await dailyUpdate.run(['--tickers', 'BBCA', '--date', '2026-09-07', '--delay', '0']);
      assert.equal(bandarmologiService.hasDiskCache('broker-summary', 'BBCA', '2026-09-07'), false, 'an empty response must not be cached as a confirmed "no data" day');
      const marker = dailyUpdate.readMarker('2026-09-07');
      assert.equal(marker.complete, false);
      assert.equal(marker.pending, 1);
    } finally {
      restore();
    }
  });
});

test('run-daily-broker-update: a quota-exceeded response stops the run cleanly and marks it incomplete, not errored', async () => {
  await withTempDataDir(async () => {
    const restore = mockArjum({
      fetchBrokerSummary: async () => ({ ok: false, status: 429, error: 'Too Many Requests' })
    });
    try {
      await dailyUpdate.run(['--tickers', 'BBCA,BBRI', '--date', '2026-09-07', '--delay', '0']);
      const marker = dailyUpdate.readMarker('2026-09-07');
      assert.equal(marker.complete, false);
      assert.equal(marker.errors, 0, 'a quota stop must not be counted as a per-ticker error');
    } finally {
      restore();
    }
  });
});

test('run-daily-broker-update: retry repairs missing auxiliary endpoints even when dated summary is already cached', async () => {
  await withTempDataDir(async () => {
    bandarmologiService.writeDiskCache('broker-summary', 'BBCA', '2026-09-07', {
      top_buyers: [{ broker: 'YU', bval: 100, bvol: 10 }],
      top_sellers: []
    });
    let summaryCalls = 0;
    let accumulationCalls = 0;
    let insiderCalls = 0;
    const restore = mockArjum({
      fetchBrokerSummary: async () => { summaryCalls++; return { ok: true, data: { top_buyers: [], top_sellers: [] } }; },
      fetchBrokerAccumulation: async () => { accumulationCalls++; return { ok: true, data: { series: [] } }; },
      fetchInsiders: async () => { insiderCalls++; return { ok: true, data: [] }; }
    });
    try {
      await dailyUpdate.run(['--tickers', 'BBCA', '--date', '2026-09-07', '--delay', '0']);
      assert.equal(summaryCalls, 0, 'cached dated summary must skip broker-summary request');
      assert.equal(accumulationCalls, 1, 'cached summary must still repair missing accumulation');
      assert.equal(insiderCalls, 1, 'cached summary must still repair missing insiders');
      const marker = dailyUpdate.readMarker('2026-09-07');
      assert.equal(marker.complete, true);
      assert.equal(marker.schema_version, 2);
      assert.deepEqual(marker.aux_complete_tickers, ['BBCA']);
    } finally {
      restore();
    }
  });
});

test('run-daily-broker-update: v1 complete marker is reopened to repair auxiliary data', async () => {
  await withTempDataDir(async () => {
    bandarmologiService.writeDiskCache('broker-summary', 'BBCA', '2026-09-07', {
      top_buyers: [{ broker: 'YU', bval: 100, bvol: 10 }],
      top_sellers: []
    });
    dailyUpdate.writeMarker('2026-09-07', {
      date: '2026-09-07',
      complete: true,
      completed_at: new Date().toISOString(),
      total_tickers: 1
    });
    let accumulationCalls = 0;
    let insiderCalls = 0;
    const restore = mockArjum({
      fetchBrokerAccumulation: async () => { accumulationCalls++; return { ok:true, data:{ series:[] } }; },
      fetchInsiders: async () => { insiderCalls++; return { ok:true, data:[] }; }
    });
    try {
      await dailyUpdate.run(['--tickers', 'BBCA', '--date', '2026-09-07', '--delay', '0']);
      assert.equal(accumulationCalls, 1);
      assert.equal(insiderCalls, 1);
      const marker = dailyUpdate.readMarker('2026-09-07');
      assert.equal(marker.schema_version, 2);
      assert.equal(marker.complete, true);
    } finally {
      restore();
    }
  });
});

test('run-daily-broker-update: pending empty summary does not spend auxiliary requests before final publication', async () => {
  await withTempDataDir(async () => {
    let accumulationCalls = 0;
    let insiderCalls = 0;
    const restore = mockArjum({
      fetchBrokerSummary: async () => ({ ok: true, data: { top_buyers: [], top_sellers: [] } }),
      fetchBrokerAccumulation: async () => { accumulationCalls++; return { ok: true, data: { series: [] } }; },
      fetchInsiders: async () => { insiderCalls++; return { ok: true, data: [] }; }
    });
    try {
      await dailyUpdate.run(['--tickers', 'BBCA', '--date', '2026-09-07', '--delay', '0']);
      assert.equal(accumulationCalls, 0, 'pending summary must not trigger accumulation request');
      assert.equal(insiderCalls, 0, 'pending summary must not trigger insiders request');
      const marker = dailyUpdate.readMarker('2026-09-07');
      assert.equal(marker.complete, false);
      assert.equal(marker.pending, 1);
    } finally {
      restore();
    }
  });
});

test('run-daily-broker-update: an already-complete marker makes the next firing a fast no-op', async () => {
  await withTempDataDir(async () => {
    dailyUpdate.writeMarker('2026-09-07', { schema_version: 2, date: '2026-09-07', complete: true, completed_at: new Date().toISOString(), total_tickers: 1, aux_complete_tickers: ['BBCA'], no_data_tickers: [] });
    let calledFetch = false;
    const restore = mockArjum({
      fetchBrokerSummary: async () => { calledFetch = true; return { ok: true, data: { top_buyers: [], top_sellers: [] } }; }
    });
    try {
      await dailyUpdate.run(['--tickers', 'BBCA', '--date', '2026-09-07', '--delay', '0']);
      assert.equal(calledFetch, false, 'an already-complete marker must skip all work, not re-fetch');
    } finally {
      restore();
    }
  });
});

test('run-daily-broker-update: complete marker is reopened when active universe grows', async () => {
  await withTempDataDir(async () => {
    dailyUpdate.writeMarker('2026-09-07', {
      schema_version: 2,
      date: '2026-09-07',
      complete: true,
      completed_at: new Date().toISOString(),
      total_tickers: 1,
      aux_complete_tickers: ['BBCA'],
      no_data_tickers: []
    });
    bandarmologiService.writeDiskCache('broker-summary', 'BBCA', '2026-09-07', {
      broker_start_date: '2026-09-07',
      broker_end_date: '2026-09-07',
      top_buyers: [{ broker: 'YU', bval: 100, bvol: 10 }],
      top_sellers: []
    });
    let calls = 0;
    const restore = mockArjum({
      fetchBrokerSummary: async (ticker) => {
        calls++;
        return {
          ok: true,
          data: {
            broker_start_date: '2026-09-07',
            broker_end_date: '2026-09-07',
            top_buyers: [{ broker: ticker === 'BBRI' ? 'CC' : 'YU', bval: 100, bvol: 10 }],
            top_sellers: []
          }
        };
      }
    });
    try {
      await dailyUpdate.run(['--tickers', 'BBCA,BBRI', '--date', '2026-09-07', '--delay', '0']);
      assert.equal(calls, 1, 'only the newly-added ticker should need broker-summary fetch');
      const marker = dailyUpdate.readMarker('2026-09-07');
      assert.equal(marker.complete, true);
      assert.equal(marker.total_tickers, 2);
      assert.equal(marker.broker_summary_rows, 2);
    } finally {
      restore();
    }
  });
});

test('run-daily-broker-update: historical recovery never downgrades a newer latest.json', async () => {
  await withTempDataDir(async () => {
    bandarmologiService.writeDiskCache('broker-summary', 'BBCA', '2026-09-29', {
      broker_start_date: '2026-09-29',
      broker_end_date: '2026-09-29',
      top_buyers: [{ broker: 'YU', bval: 100, bvol: 10 }],
      top_sellers: []
    });
    bandarmologiService.writeDiskCache('broker-summary', 'BBCA', 'latest', {
      broker_start_date: '2026-09-29',
      broker_end_date: '2026-09-29',
      top_buyers: [{ broker: 'YU', bval: 100, bvol: 10 }],
      top_sellers: []
    });

    const restore = mockArjum({
      fetchBrokerSummary: async () => ({
        ok: true,
        data: {
          broker_start_date: '2026-09-28',
          broker_end_date: '2026-09-28',
          top_buyers: [{ broker: 'CC', bval: 200, bvol: 20 }],
          top_sellers: []
        }
      })
    });

    try {
      await dailyUpdate.run(['--tickers', 'BBCA', '--date', '2026-09-28', '--delay', '0']);

      const historical = bandarmologiService.readDiskCache('broker-summary', 'BBCA', '2026-09-28');
      assert.equal(historical.broker_end_date, '2026-09-28', 'historical dated cache should still be written');

      const latest = bandarmologiService.readDiskCache('broker-summary', 'BBCA', 'latest');
      assert.equal(latest.broker_end_date, '2026-09-29', 'newer latest.json must not be downgraded by historical recovery');
    } finally {
      restore();
    }
  });
});

test('run-daily-broker-update: current/newer recovery may advance latest.json', async () => {
  await withTempDataDir(async () => {
    bandarmologiService.writeDiskCache('broker-summary', 'BBCA', '2026-09-28', {
      broker_start_date: '2026-09-28',
      broker_end_date: '2026-09-28',
      top_buyers: [{ broker: 'CC', bval: 100, bvol: 10 }],
      top_sellers: []
    });
    bandarmologiService.writeDiskCache('broker-summary', 'BBCA', 'latest', {
      broker_start_date: '2026-09-28',
      broker_end_date: '2026-09-28',
      top_buyers: [{ broker: 'CC', bval: 100, bvol: 10 }],
      top_sellers: []
    });

    const restore = mockArjum({
      fetchBrokerSummary: async () => ({
        ok: true,
        data: {
          broker_start_date: '2026-09-29',
          broker_end_date: '2026-09-29',
          top_buyers: [{ broker: 'YU', bval: 200, bvol: 20 }],
          top_sellers: []
        }
      })
    });

    try {
      await dailyUpdate.run(['--tickers', 'BBCA', '--date', '2026-09-29', '--delay', '0']);

      const latest = bandarmologiService.readDiskCache('broker-summary', 'BBCA', 'latest');
      assert.equal(latest.broker_end_date, '2026-09-29', 'newer data should still advance latest.json');
    } finally {
      restore();
    }
  });
});

test('run-daily-broker-update: --final only seals a verified suspended ticker as terminal NO_DATA', async () => {
  await withTempDataDir(async () => {
    const restore = mockArjum({
      fetchBrokerSummary: async () => ({ ok: true, data: { top_buyers: [], top_sellers: [] } })
    });
    try {
      await dailyUpdate.run(['--tickers', 'DPNS', '--date', '2026-09-07', '--delay', '0', '--final']);
      const marker = dailyUpdate.readMarker('2026-09-07');
      assert.equal(marker.complete, true, 'verified suspended empty response may be terminal NO_DATA');
      assert.equal(marker.broker_summary_rows, 0);
      assert.equal(marker.no_data, 1);
      assert.deepEqual(marker.no_data_tickers, ['DPNS']);
      assert.equal(process.exitCode, undefined);
      assert.equal(bandarmologiService.hasDiskCache('broker-summary', 'DPNS', '2026-09-07'), false);
    } finally {
      restore();
    }
  });
});

test('run-daily-broker-update: --final keeps an ordinary empty ticker pending for later repair', async () => {
  await withTempDataDir(async () => {
    const restore = mockArjum({
      fetchBrokerSummary: async () => ({ ok: true, data: { top_buyers: [], top_sellers: [] } })
    });
    try {
      await dailyUpdate.run(['--tickers', 'BBCA', '--date', '2026-09-07', '--delay', '0', '--final']);
      const marker = dailyUpdate.readMarker('2026-09-07');
      assert.equal(marker.complete, false);
      assert.equal(marker.no_data, 0);
      assert.equal(marker.pending, 1);
      assert.equal(process.exitCode, 4, 'late publication remains operationally incomplete at final pass');
    } finally {
      restore();
    }
  });
});

test('run-daily-broker-update: --final still fails closed on a real upstream error', async () => {
  await withTempDataDir(async () => {
    const restore = mockArjum({
      fetchBrokerSummary: async () => ({ ok: false, status: 500, error: 'upstream failure' })
    });
    try {
      await dailyUpdate.run(['--tickers', 'BBCA', '--date', '2026-09-07', '--delay', '0', '--final']);
      const marker = dailyUpdate.readMarker('2026-09-07');
      assert.equal(marker.complete, false);
      assert.equal(marker.errors, 1);
      assert.equal(process.exitCode, 4, 'real upstream errors must keep the final run incomplete');
    } finally {
      restore();
    }
  });
});

test('run-daily-broker-update: resolveTargetDate safety guard shifts to T-1 before 16:30 WIB when --date is omitted', () => {
  // 10:00 WIB on Monday 2026-09-07 (03:00 UTC)
  const mondayMorning = new Date('2026-09-07T03:00:00.000Z');
  const resMorning = dailyUpdate.resolveTargetDate({ now: mondayMorning });
  assert.equal(resMorning.shifted, true);
  assert.equal(resMorning.reason, 'before_market_close_cutoff');
  // Previous trading day before Monday 2026-09-07 is Friday 2026-09-04
  assert.equal(resMorning.targetDate, '2026-09-04');

  // 16:29 WIB on Monday 2026-09-07 (09:29 UTC)
  const justBeforeCutoff = new Date('2026-09-07T09:29:00.000Z');
  const resJustBefore = dailyUpdate.resolveTargetDate({ now: justBeforeCutoff });
  assert.equal(resJustBefore.shifted, true);
  assert.equal(resJustBefore.targetDate, '2026-09-04');
});

test('run-daily-broker-update: resolveTargetDate targets today (T-0) at or after 16:30 WIB', () => {
  // 16:30 WIB on Monday 2026-09-07 (09:30 UTC)
  const exactlyAtCutoff = new Date('2026-09-07T09:30:00.000Z');
  const resCutoff = dailyUpdate.resolveTargetDate({ now: exactlyAtCutoff });
  assert.equal(resCutoff.shifted, false);
  assert.equal(resCutoff.targetDate, '2026-09-07');

  // 20:00 WIB evening scheduled firing (13:00 UTC)
  const eveningFiring = new Date('2026-09-07T13:00:00.000Z');
  const resEvening = dailyUpdate.resolveTargetDate({ now: eveningFiring });
  assert.equal(resEvening.shifted, false);
  assert.equal(resEvening.targetDate, '2026-09-07');
});

test('run-daily-broker-update: resolveTargetDate honors explicit date argument regardless of time', () => {
  const morningTime = new Date('2026-09-07T03:00:00.000Z');
  const resExplicit = dailyUpdate.resolveTargetDate({ dateArg: '2026-08-28', now: morningTime });
  assert.equal(resExplicit.shifted, false);
  assert.equal(resExplicit.targetDate, '2026-08-28');
  assert.equal(resExplicit.reason, 'explicit_argument');
});
