'use strict';

const { describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { computeDomestic } = require('../lib/broksum-flow');

describe('broksum-flow computeDomestic Unit Tests', () => {
  const auditDataPath = path.join(__dirname, '..', 'backtest', 'arjum-audit', 'section_c_raw.json');
  if (!fs.existsSync(auditDataPath)) {
    it.skip('Audit dataset section_c_raw.json not found, skipping', () => {});
    return;
  }

  const raw = JSON.parse(fs.readFileSync(auditDataPath, 'utf8'));
  const { dataAll, dataF, dataD } = raw;

  it('should compute domestic broker summary matching live flow=D with 0 discrepancy for all 60 brokers', () => {
    const computedD = computeDomestic(dataAll, dataF);

    assert.ok(computedD, 'computedD should not be null');
    assert.strictEqual(computedD.flow, 'D');

    // Build map from computed D
    const computedMap = new Map();
    computedD.brokers.forEach(b => computedMap.set(b.broker_code, b));

    // Build map from live D
    const liveMap = new Map();
    dataD.brokers.forEach(b => liveMap.set(b.broker_code, b));

    // Check all brokers in live D
    let checkedCount = 0;
    for (const [code, bLive] of liveMap.entries()) {
      const bComp = computedMap.get(code);
      assert.ok(bComp, `Broker ${code} must exist in computedDomestic`);

      // Assert bit-exact values
      assert.strictEqual(bComp.bval, bLive.bval, `Broker ${code} bval mismatch`);
      assert.strictEqual(bComp.sval, bLive.sval, `Broker ${code} sval mismatch`);
      assert.strictEqual(bComp.bvol, bLive.bvol, `Broker ${code} bvol mismatch`);
      assert.strictEqual(bComp.svol, bLive.svol, `Broker ${code} svol mismatch`);
      assert.strictEqual(bComp.nval, bLive.nval, `Broker ${code} nval mismatch`);
      assert.strictEqual(bComp.nvol, bLive.nvol, `Broker ${code} nvol mismatch`);

      checkedCount++;
    }

    assert.strictEqual(checkedCount, liveMap.size, 'All live domestic brokers must be verified');
    assert.strictEqual(computedD.brokers.length, dataD.brokers.length, 'Broker count must match');
  });

  it('should return incomplete status when foreign is null or missing', () => {
    const dMissing = computeDomestic(dataAll, null);
    assert.strictEqual(dMissing.flow, 'D');
    assert.strictEqual(dMissing.is_complete, false);
    assert.strictEqual(dMissing.status, 'foreign_missing');
    assert.strictEqual(dMissing.data, null);
  });

  it('should compute domestic when foreign has explicitly zero broker trades', () => {
    const emptyForeign = { flow: 'F', brokers: [], broker_levels: [] };
    const dOnly = computeDomestic(dataAll, emptyForeign);
    assert.strictEqual(dOnly.flow, 'D');
    assert.strictEqual(dOnly.is_complete, true);
    assert.strictEqual(dOnly.brokers.length, dataAll.brokers.length);
  });
});
