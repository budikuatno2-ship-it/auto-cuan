'use strict';

/**
 * Regression guards for BATCH 1 — Data integrity & unblocking the refill pipeline (P0).
 *
 * Root causes documented in SYSTEM_ARCHITECTURE_LIFECYCLE.md:
 *   T1 — lib/vps-data-fetcher.js hard-coded the Windows-only binary `curl.exe`,
 *        so on the Linux runtime every VPS-bridge fetch failed silently.
 *   T2 — failures were swallowed by empty `catch (_) {}` blocks, leaving no
 *        diagnosable evidence.
 *   T3 — an absent historical date was silently relabelled with data from a
 *        different snapshot (date masquerading).
 *   T4 — multi-day ranges fell back to multiplying one day by a synthetic
 *        constant (x5 / x10 / x22 / x44), fabricating volume and net flow.
 *
 * Offline only: no Telegram, no production endpoint, no Supabase.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FETCHER_PATH = path.join(__dirname, '..', 'lib', 'vps-data-fetcher.js');
const SERVICE_PATH = path.join(__dirname, '..', 'lib', 'bandarmologi-service.js');

// ---------------------------------------------------------------------------
// T1 — no Windows-only shell binary; native HTTP only
// ---------------------------------------------------------------------------

test('T1: vps-data-fetcher never shells out to curl.exe or curl', () => {
  const source = fs.readFileSync(FETCHER_PATH, 'utf8');

  // The exact string that broke production on Linux.
  assert.equal(source.includes('curl.exe'), false,
    'vps-data-fetcher must not reference curl.exe (Windows-only, throws on Linux)');

  // Any curl invocation, however spelled.
  const curlCall = /execFileSync\(\s*['"]curl(\.exe)?['"]|execFile\(\s*['"]curl(\.exe)?['"]|child_process[\s\S]{0,80}['"]curl/;
  assert.equal(curlCall.test(source), false,
    'vps-data-fetcher must not spawn a curl binary at all');

  // HTTP transport must be the Node 22 global fetch.
  assert.ok(/\bfetch\(/.test(source),
    'vps-data-fetcher must use the platform HTTP client (global fetch)');
});

test('T1b: the only shell binary ever spawned is ssh', () => {
  const source = fs.readFileSync(FETCHER_PATH, 'utf8');

  // Collect every literal binary name passed to execFileSync/execFile.
  // A non-literal first argument (e.g. process.execPath) is not captured here.
  const calls = source.match(/execFile(?:Sync)?\(\s*['"]([^'"]+)['"]/g) || [];
  const binaries = calls.map(function (c) {
    const m = /execFile(?:Sync)?\(\s*['"]([^'"]+)['"]/.exec(c);
    return m ? m[1] : '';
  });

  assert.ok(binaries.length > 0, 'expected at least the ssh call sites to be found');
  for (const bin of binaries) {
    assert.equal(bin, 'ssh', `execFile may only invoke ssh; found "${bin}"`);
  }
});

// ---------------------------------------------------------------------------
// T2 — network failure is reported, never silently swallowed
// ---------------------------------------------------------------------------

test('T2: a failed VPS fetch emits an explicit diagnostic instead of an empty catch', () => {
  // Real runtime path, real module, unreachable base, no SSH key available.
  // Run in a child process so the module-level env constants are configured.
  const script = `
    const f = require(${JSON.stringify(FETCHER_PATH)});
    (async () => {
      const dates = await f.fetchAvailableDatesFromVps('BBCA');
      console.log('RESULT_COUNT=' + dates.length);
    })().catch(e => { console.error('UNEXPECTED=' + e.message); process.exit(3); });
  `;

  const res = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 20000,
    env: Object.assign({}, process.env, {
      VPS_DATA_API_BASE: 'http://127.0.0.1:1',
      VPS_SSH_KEY: path.join(os.tmpdir(), 'definitely-missing-autocuan-key'),
      ARJUM_DATA_DIR: path.join(os.tmpdir(), 'autocuan-t2-empty'),
      NODE_ENV: 'production'
    })
  });

  assert.equal(res.status, 0, `child must exit cleanly. stderr=${res.stderr}`);
  const output = `${res.stdout || ''}${res.stderr || ''}`;

  assert.ok(output.includes('RESULT_COUNT=0'),
    `a failed fetch must still degrade to an empty list. output=${output}`);
  assert.match(output, /\[VPS-FETCHER\]\[WARN\]/,
    `failure must be logged with the [VPS-FETCHER][WARN] marker. output=${output}`);
});

test('T2b: the fetch functions contain no empty catch that discards errors', () => {
  const source = fs.readFileSync(FETCHER_PATH, 'utf8');

  // Strip comment lines so documentation of the old bug is not flagged.
  const code = source
    .split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

  assert.equal(/catch\s*\(_\)\s*\{\s*\}/.test(code), false,
    'empty `catch (_) {}` swallows are forbidden — log the failure instead');
});

// ---------------------------------------------------------------------------
// T3 / T4 — fixtures: one single-day snapshot on a temp disk
// ---------------------------------------------------------------------------

const DAY = '2026-09-14';
const ASKED_SAME_DAY = '2026-09-14';
const ASKED_MISSING_DAY = '2026-09-11';
const UNIQUE_BUY_VAL = 123456789;

const SNAPSHOT = {
  stock_code: 'AUDITT',
  date: DAY,
  broker_start_date: DAY,
  brokers: [
    { broker_code: 'YP', broker_name: 'Mirae', bval: UNIQUE_BUY_VAL, bvol: 1000, sval: 100, svol: 10, bfrq: 5, sfrq: 1 },
    { broker_code: 'CC', broker_name: 'Mandiri', bval: 500, bvol: 5, sval: 400, svol: 4, bfrq: 2, sfrq: 2 }
  ]
};

function makeFixture(ticker) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'autocuan-b1-'));
  const dir = path.join(base, 'broker-summary', ticker);
  fs.mkdirSync(dir, { recursive: true });
  const payload = Object.assign({}, SNAPSHOT, { stock_code: ticker });
  fs.writeFileSync(path.join(dir, `${DAY}.json`), JSON.stringify(payload, null, 2), 'utf8');
  return { base, ticker };
}

function withFixture(ticker, fn) {
  const fixture = makeFixture(ticker);
  const previous = process.env.ARJUM_DATA_DIR;
  process.env.ARJUM_DATA_DIR = fixture.base;
  try {
    return fn(fixture);
  } finally {
    if (previous === undefined) delete process.env.ARJUM_DATA_DIR;
    else process.env.ARJUM_DATA_DIR = previous;
    try { fs.rmSync(fixture.base, { recursive: true, force: true }); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// T3 — an absent historical date must NOT be relabelled from another snapshot
// ---------------------------------------------------------------------------

test('T3: a requested date that does not exist must not masquerade another snapshot', async () => {
  const service = require('../lib/bandarmologi-service');

  const res = await withFixture('AUDITMASK', () => service.getBandarmologiData('AUDITMASK', {
    range: '1d',
    date: ASKED_MISSING_DAY
  }));

  const hasRows = Array.isArray(res.broker_summary && res.broker_summary.top_buyers)
    && res.broker_summary.top_buyers.length > 0;

  // Forbidden: rows belonging to 2026-09-14 presented under the requested date.
  const masqueraded = hasRows && res.broker_summary.date === ASKED_MISSING_DAY;
  assert.equal(masqueraded, false,
    'must not label one snapshot with a different requested date (date masquerading)');

  // Required: an explicit not-found / empty signal.
  const notFound = res.status === 'NO_DATA'
    || res.is_empty === true
    || (res.broker_summary && res.broker_summary.is_empty === true);
  assert.equal(notFound, true,
    `absent date must return an explicit not-found signal. got status=${res.status} is_empty=${res.is_empty}`);
});

test('T3b: the real date is still served when it genuinely exists', async () => {
  const service = require('../lib/bandarmologi-service');

  const res = await withFixture('AUDITREAL', () => service.getBandarmologiData('AUDITREAL', {
    range: '1d',
    date: ASKED_SAME_DAY
  }));

  assert.equal(res.success, true);
  assert.equal(res.broker_summary.date, ASKED_SAME_DAY);
  assert.ok(res.broker_summary.top_buyers.length > 0,
    'a genuinely available date must still return rows');
});

test('T3c: the latest date is still served when no date is requested', async () => {
  const service = require('../lib/bandarmologi-service');

  const res = await withFixture('AUDITLATEST', () => service.getBandarmologiData('AUDITLATEST', {
    range: '1d'
  }));

  assert.equal(res.success, true);
  assert.equal(res.broker_summary.date, DAY);
  assert.ok(res.broker_summary.top_buyers.length > 0);
});

// ---------------------------------------------------------------------------
// T4 — no synthetic multipliers on multi-day ranges with a single day of data
// ---------------------------------------------------------------------------

test('T4: a single-day snapshot is never multiplied for multi-day ranges', async () => {
  const service = require('../lib/bandarmologi-service');

  const singleDay = await withFixture('AUDITSCALE1', () => service.getBandarmologiData('AUDITSCALE1', {
    range: '1d', date: DAY
  }));

  const oneDayBuyVal = singleDay.broker_summary.total_buy_val;
  assert.ok(oneDayBuyVal > 0, 'fixture must expose a positive total_buy_val');

  for (const spec of [
    { range: '5d', days: 5, banned: [5, 3] },
    { range: '14d', days: 14, banned: [10, 8] },
    { range: '30d', days: 30, banned: [22, 21] },
    { range: '60d', days: 60, banned: [44, 43] }
  ]) {
    // NOTE: ticker must survive arjumClient.cleanTicker() (A-Z0-9 only), otherwise
    // the fixture directory would not be the directory the service reads.
    const ticker = `AUDITSCALE${spec.range.toUpperCase()}`;
    const res = await withFixture(ticker, () => service.getBandarmologiData(ticker, {
      range: spec.range,
      days: spec.days
    }));

    const bs = res.broker_summary || {};
    const buyVal = bs.total_buy_val;

    if (typeof buyVal === 'number' && buyVal > 0) {
      const ratio = buyVal / oneDayBuyVal;
      for (const banned of spec.banned) {
        assert.equal(Math.abs(ratio - banned) > 0.01, true,
          `${spec.range}: volume/flow must not be multiplied by the synthetic constant x${banned} (ratio=${ratio})`);
      }
    }

    // Any response still claiming a multi-day window must be flagged as
    // synthesised/insufficient, never silently presented as a real aggregate.
    if (bs.range_label && /Hari Bursa/.test(bs.range_label)) {
      assert.equal(bs.synthetic_scaling, true,
        `${spec.range}: a single-day-based label must be explicitly flagged synthetic_scaling`);
    }
  }
});

test('T4b: real multi-day aggregation is preserved when the days are on disk', async () => {
  const service = require('../lib/bandarmologi-service');

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'autocuan-b1-agg-'));
  const ticker = 'AUDITAGG';
  const dir = path.join(base, 'broker-summary', ticker);
  fs.mkdirSync(dir, { recursive: true });

  const days = ['2026-09-14', '2026-09-11', '2026-09-10'];
  days.forEach((d, i) => {
    fs.writeFileSync(path.join(dir, `${d}.json`), JSON.stringify({
      stock_code: ticker,
      date: d,
      broker_start_date: d,
      brokers: [{ broker_code: 'YP', broker_name: 'Mirae', bval: 1000 * (i + 1), bvol: 100, sval: 0, svol: 0, bfrq: 1, sfrq: 0 }]
    }, null, 2), 'utf8');
  });

  const previous = process.env.ARJUM_DATA_DIR;
  process.env.ARJUM_DATA_DIR = base;
  try {
    const agg = service.aggregateBrokerSummaries(ticker, days, 3);
    assert.ok(agg, 'real aggregation must still be produced');
    assert.equal(agg.range_days, 3);
    // 1000 + 2000 + 3000 — a genuine sum, not a multiplier.
    const yp = agg.gross_buyers.find(b => b.broker === 'YP');
    assert.equal(yp.bval, 6000, 'aggregation must SUM real days, never multiply');
  } finally {
    if (previous === undefined) delete process.env.ARJUM_DATA_DIR;
    else process.env.ARJUM_DATA_DIR = previous;
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) {}
  }
});
