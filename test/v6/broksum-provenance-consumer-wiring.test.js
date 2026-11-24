'use strict';

/**
 * test/v6/broksum-provenance-consumer-wiring.test.js
 * V6-F5b — proves the provenance guard is actually WIRED into the runtime
 * consumer (`lib/arjum-client.js :: readLocalBrokerSummary`), not merely
 * present as an unused module.
 *
 * The guard must make `readLocalBrokerSummary(ticker, date, 'F')` return null
 * (cache miss) when the on-disk broker-summary-F file is:
 *   - a stale session (older window than requested), or
 *   - a locally-derived (synthetic) foreign payload.
 * and it must still serve a genuine provider original.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function withTmpBase(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'f5b-prov-'));
  const prev = process.env.ARJUM_DATA_DIR;
  process.env.ARJUM_DATA_DIR = base;
  try {
    return fn(base);
  } finally {
    if (prev === undefined) delete process.env.ARJUM_DATA_DIR;
    else process.env.ARJUM_DATA_DIR = prev;
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) {}
  }
}

function writeF(base, ticker, date, payload) {
  const dir = path.join(base, 'broker-summary-F', ticker);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, date + '.json'), JSON.stringify(payload, null, 2), 'utf8');
}

function providerF(date) {
  return {
    stock_code: 'BBRI',
    brokers: [{ broker_code: 'AK', broker_name: 'UBS SEKURITAS INDONESIA', bval: 500000, bvol: 200, sval: 0, svol: 0 }],
    broker_levels: [],
    broker_start_date: date,
    broker_end_date: date,
    flow: 'F'
  };
}

test('v6 broksum provenance wiring: a genuine provider F file IS served to the consumer', () => {
  withTmpBase((base) => {
    writeF(base, 'BBRI', '2026-11-13', providerF('2026-11-13'));
    const arjumClient = require('../../lib/arjum-client');
    const got = arjumClient.readLocalBrokerSummary('BBRI', '2026-11-13', 'F');
    assert.ok(got, 'a genuine provider F payload must still be served');
    assert.equal(got.flow, 'F');
    assert.equal(got.broker_start_date, '2026-11-13');
  });
});

test('v6 broksum provenance wiring: a STALE F file is refused by the consumer', () => {
  withTmpBase((base) => {
    // The file is named for the requested session but its window is older.
    writeF(base, 'BBRI', '2026-11-13', providerF('2026-11-12'));
    const arjumClient = require('../../lib/arjum-client');
    const got = arjumClient.readLocalBrokerSummary('BBRI', '2026-11-13', 'F');
    assert.equal(got, null, 'a stale foreign payload must NOT reach the consumer');
  });
});

test('v6 broksum provenance wiring: a SYNTHETIC (DERIVED_LOCAL) F file is refused by the consumer', () => {
  withTmpBase((base) => {
    const synthetic = {
      stock_code: 'BBRI',
      ticker: 'BBRI',
      date: '2026-11-13',
      flow: 'F',
      status: 'RELEASED',
      is_complete: false,
      provenance: 'DERIVED_LOCAL',
      computed_from: 'broker_code_heuristic_from_all',
      data_status: 'PARTIAL',
      brokers: [{ broker_code: 'AK', bval: 500000, bvol: 200, sval: 0, svol: 0 }],
      broker_levels: []
    };
    writeF(base, 'BBRI', '2026-11-13', synthetic);
    const arjumClient = require('../../lib/arjum-client');
    const got = arjumClient.readLocalBrokerSummary('BBRI', '2026-11-13', 'F');
    assert.equal(got, null, 'a synthetic foreign payload must NOT reach the consumer');
  });
});

test('v6 broksum provenance wiring: a NO_TRADE (zero broker rows) F file is refused for flow', () => {
  withTmpBase((base) => {
    writeF(base, 'BBRI', '2026-11-13', {
      stock_code: 'BBRI',
      brokers: [],
      broker_levels: [],
      broker_start_date: '2026-11-13',
      broker_end_date: '2026-11-13',
      flow: 'F'
    });
    const arjumClient = require('../../lib/arjum-client');
    const got = arjumClient.readLocalBrokerSummary('BBRI', '2026-11-13', 'F');
    assert.equal(got, null, 'a zero-row foreign payload must NOT be served as a flow');
  });
});
