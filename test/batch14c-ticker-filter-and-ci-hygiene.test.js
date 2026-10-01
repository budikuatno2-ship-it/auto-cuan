'use strict';

// Batch 14C — LOW file cleanup, non-ticker folder filter, and CI hygiene.
//
// Locks the post-fix state so the cleaned-up artifacts cannot silently return:
//   F-035  scratch assets removed from public/
//   F-036  broker-summary folder readers ignore non-ticker artifact folders
//   F-055  same non-ticker filter for production folder enumerators
//   F-097  security/regression gates also trigger for PRs based on `main`

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ---------------------------------------------------------------------------
// F-036/F-055 — canonical IDX ticker format helper
// ---------------------------------------------------------------------------

test('isValidIdxTicker accepts real IDX codes and rejects audit/dummy folders', () => {
  const { isValidIdxTicker, IDX_TICKER_RE } = require('../lib/idx-ticker');

  for (const ok of ['BBCA', 'TLKM', 'ANTM', 'bbca', ' AADI ']) {
    assert.equal(isValidIdxTicker(ok), true, `${ok} should be a valid ticker`);
  }
  for (const bad of ['AUDITSCALE5D', 'AUDITSCALE14D', 'AUDITSCALE30D', 'AUDITSCALE60D', 'B4TST', 'DBGT4', 'NOACC', 'ABC', 'ABCDE', '', 'A-B.C', null, undefined]) {
    assert.equal(isValidIdxTicker(bad), false, `${bad} should be rejected`);
  }
  assert.equal(IDX_TICKER_RE.source, '^[A-Z]{4}$');
});

// ---------------------------------------------------------------------------
// F-036/F-055 — folder enumerators filter to 4-letter tickers only
// ---------------------------------------------------------------------------

test('broker-summary readers ignore non-ticker artifact folders', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'batch14c-arjum-'));
  const sumDir = path.join(tmp, 'broker-summary');
  for (const name of ['BBCA', 'TLKM', 'ASII', 'AUDITSCALE5D', 'AUDITSCALE14D', 'B4TST', 'DBGT4', 'NOACC']) {
    fs.mkdirSync(path.join(sumDir, name), { recursive: true });
    fs.writeFileSync(path.join(sumDir, name, '2026-09-01.json'), '{}');
  }

  const prev = process.env.ARJUM_DATA_DIR;
  process.env.ARJUM_DATA_DIR = tmp;
  try {
    const intel = require('../lib/bandarmologi-intel-service');
    const universe = intel.loadUniverseTickers();
    // The seeded real tickers are picked up from the broker-summary folders...
    for (const real of ['ASII', 'BBCA', 'TLKM']) {
      assert.equal(universe.includes(real), true, `${real} should enter the universe`);
    }
    // ...while every artifact folder is ignored.
    for (const artifact of ['AUDITSCALE5D', 'AUDITSCALE14D', 'AUDITSCALE30D', 'AUDITSCALE60D', 'B4TST', 'DBGT4', 'NOACC']) {
      assert.equal(universe.includes(artifact), false, `${artifact} must not enter the universe`);
    }
  } finally {
    if (prev === undefined) delete process.env.ARJUM_DATA_DIR;
    else process.env.ARJUM_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('every broker-summary folder reader uses the canonical ticker filter', () => {
  // The loose /^[A-Z0-9.-]+$/ filter that admitted AUDITSCALE*/B4TST must be gone
  // from the folder enumerations; each reader routes through isValidIdxTicker.
  const readers = {
    'lib/broker-hunter-service.js': 'filter(isValidIdxTicker)',
    'lib/bandarmologi-intel-service.js': 'filter(isValidIdxTicker)',
    'tools/collect-insider-data.js': '.filter(isValidIdxTicker)'
  };
  for (const [file, needle] of Object.entries(readers)) {
    const src = read(file);
    assert.ok(src.includes(needle), `${file} must filter folders with isValidIdxTicker`);
    assert.ok(!/\^\[A-Z0-9\.-\]\+\$/.test(src), `${file} must not keep the loose non-ticker regex`);
  }

  for (const file of ['tools/fetch-daily-candles.js', 'tools/backfill-historical-candles.js', 'tools/targeted-september-backfill.js']) {
    const src = read(file);
    assert.ok(src.includes("require('../lib/idx-ticker')"), `${file} must import the shared ticker helper`);
    assert.ok(src.includes('.filter(isValidIdxTicker)'), `${file} must filter enumerated dirs`);
  }
});

// ---------------------------------------------------------------------------
// F-035 — scratch artifacts removed
// ---------------------------------------------------------------------------

test('scratch assets are not tracked in public/', () => {
  for (const rel of ['public/tmp-ci-touch-batch1.js', 'public/tmp-measure.html', 'public/tmp-measure2.html']) {
    assert.equal(fs.existsSync(path.join(ROOT, rel)), false, `${rel} should be deleted`);
  }
});

// ---------------------------------------------------------------------------
// F-097 — security & regression gates also cover PRs based on main
// ---------------------------------------------------------------------------

test('security and regression workflows also trigger for main-based PRs', () => {
  const workflows = [
    '.github/workflows/security-gate.yml',
    '.github/workflows/codeql-security.yml',
    '.github/workflows/web-hardening-regression.yml',
    '.github/workflows/fast-watcher-regression.yml'
  ];
  for (const rel of workflows) {
    const src = read(rel);
    const header = src.slice(0, src.indexOf('permissions:'));
    const prBlock = header.slice(header.indexOf('pull_request:'));
    assert.match(prBlock, /-\s*main\b/, `${rel} pull_request must include the main branch`);
    assert.match(prBlock, /-\s*feat\/daytrade-screener-v1\b/, `${rel} must keep the working branch`);
  }
});