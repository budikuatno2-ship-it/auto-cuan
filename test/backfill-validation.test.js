'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const arjumClient = require('../lib/arjum-client');
const bandarmologiService = require('../lib/bandarmologi-service');

test('backfill validation: arjumClient with noFallback returns error when circuit breaker tripped', async () => {
  arjumClient.tripCircuitBreaker('Test trip');
  try {
    assert.equal(arjumClient.isCircuitBreakerTripped(), true);

    // Call with noFallback: true
    const res = await arjumClient.fetchBrokerSummary('BBCA', '2026-10-16', 'F', null, { noFallback: true });
    assert.equal(res.ok, false, 'must return ok:false when noFallback is requested during tripped circuit breaker');
    assert.equal(res.status, 429);
    assert.equal(res.fallback, false);
  } finally {
    arjumClient.resetCircuitBreaker();
  }
});

test('backfill validation: arjumClient does not return flow=all fallback for flow=F request', async () => {
  arjumClient.tripCircuitBreaker('Test trip 2');
  try {
    // Call without noFallback, but requesting flow='F'
    const res = await arjumClient.fetchBrokerSummary('BBCA', '2026-10-16', 'F');
    // If local cache has no valid F, it must NOT return flow=all fallback with ok:true
    if (res.ok) {
      assert.equal(res.data.flow, 'F', 'if ok:true, data.flow must be F, never all');
    } else {
      assert.equal(res.ok, false);
      assert.equal(res.status, 429);
    }
  } finally {
    arjumClient.resetCircuitBreaker();
  }
});

test('backfill validation: readLocalBrokerSummary rejects non-F files when requesting flow=F', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-broksum-f-'));
  const origEnv = process.env.ARJUM_DATA_DIR;
  process.env.ARJUM_DATA_DIR = tmpDir;

  try {
    const fDir = path.join(tmpDir, 'broker-summary-F', 'TEST');
    fs.mkdirSync(fDir, { recursive: true });

    // File contaminated with flow: "all"
    fs.writeFileSync(path.join(fDir, '2026-10-16.json'), JSON.stringify({
      stock_code: 'TEST',
      date: '2026-10-16',
      flow: 'all',
      brokers: []
    }));

    const read = arjumClient.readLocalBrokerSummary('TEST', '2026-10-16', 'F');
    assert.equal(read, null, 'contaminated file with flow=all must be rejected by readLocalBrokerSummary(..., flow=F)');

    // File with valid flow: "F"
    fs.writeFileSync(path.join(fDir, '2026-10-15.json'), JSON.stringify({
      stock_code: 'TEST',
      date: '2026-10-15',
      flow: 'F',
      brokers: [{ broker_code: 'CC', bval: 100, bvol: 1 }]
    }));

    const validRead = arjumClient.readLocalBrokerSummary('TEST', '2026-10-15', 'F');
    assert.ok(validRead, 'valid flow=F file must be accepted');
    assert.equal(validRead.flow, 'F');
  } finally {
    if (origEnv !== undefined) process.env.ARJUM_DATA_DIR = origEnv;
    else delete process.env.ARJUM_DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('backfill validation: bandarmologiService returns unarchived status when foreign data is not flow=F', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-bandar-f-'));
  const origEnv = process.env.ARJUM_DATA_DIR;
  const origKey = process.env.ARJUM_API_KEY;
  process.env.ARJUM_DATA_DIR = tmpDir;
  delete process.env.ARJUM_API_KEY; // simulate offline / no key

  try {
    const fDir = path.join(tmpDir, 'broker-summary-F', 'UNARCH');
    fs.mkdirSync(fDir, { recursive: true });
    // Write corrupted file with flow: 'all'
    fs.writeFileSync(path.join(fDir, '2026-10-16.json'), JSON.stringify({
      stock_code: 'UNARCH',
      date: '2026-10-16',
      flow: 'all',
      brokers: []
    }));

    const res = await bandarmologiService.getBandarmologiData('UNARCH', { date: '2026-10-16', flow: 'F' });
    assert.equal(res.success, false, 'must not succeed with flow=all file');
    assert.equal(res.status, 'unarchived');
  } finally {
    if (origEnv !== undefined) process.env.ARJUM_DATA_DIR = origEnv;
    else delete process.env.ARJUM_DATA_DIR;
    if (origKey !== undefined) process.env.ARJUM_API_KEY = origKey;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
