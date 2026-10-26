'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const broker = require('../tools/run-daily-broker-update');
const bandarmologiService = require('../lib/bandarmologi-service');

test('BUG-10: Generate latest.json pointers for accumulation and insider data', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aux-latest-test-'));
  const origDataDir = process.env.ARJUM_DATA_DIR;
  process.env.ARJUM_DATA_DIR = tmpDir;

  t.after(() => {
    if (origDataDir) process.env.ARJUM_DATA_DIR = origDataDir;
    else delete process.env.ARJUM_DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  await t.test('1. writeAuxiliaryLatestPointers generates latest.json in accumulation and insider directories with metadata', () => {
    broker.writeAuxiliaryLatestPointers(tmpDir, '2026-10-23', {
      accumulation_count: 850,
      insider_count: 320
    });

    const accPath = path.join(tmpDir, 'broker-accumulation', 'latest.json');
    const insPath = path.join(tmpDir, 'insiders', 'latest.json');

    assert.ok(fs.existsSync(accPath), 'broker-accumulation/latest.json must exist');
    assert.ok(fs.existsSync(insPath), 'insiders/latest.json must exist');

    const accData = JSON.parse(fs.readFileSync(accPath, 'utf8'));
    assert.equal(accData.target_date, '2026-10-23');
    assert.equal(accData.status, 'complete');
    assert.equal(accData.endpoint, 'broker-accumulation');
    assert.equal(accData.count, 850);
    assert.ok(accData.updated_at);

    const insData = JSON.parse(fs.readFileSync(insPath, 'utf8'));
    assert.equal(insData.target_date, '2026-10-23');
    assert.equal(insData.status, 'complete');
    assert.equal(insData.endpoint, 'insiders');
    assert.equal(insData.count, 320);
    assert.ok(insData.updated_at);
  });

  await t.test('2. per-ticker latest.json pointer is readable via bandarmologiService.readDiskCache', () => {
    const ticker = 'BBCA';
    const accPayload = {
      ticker: 'BBCA',
      series: [{ date: '2026-10-23', net_val: 1000000000 }]
    };
    const insPayload = {
      items: [{ date: '2026-10-23', insider_name: 'Director', change: 100000 }]
    };

    bandarmologiService.writeDiskCache('broker-accumulation', ticker, 'latest', accPayload);
    bandarmologiService.writeDiskCache('insiders', ticker, 'latest', insPayload);

    const readAcc = bandarmologiService.readDiskCache('broker-accumulation', ticker, 'latest');
    assert.ok(readAcc, 'readDiskCache latest accumulation must succeed');
    assert.equal(readAcc.ticker, 'BBCA');

    const readIns = bandarmologiService.readDiskCache('insiders', ticker, 'latest');
    assert.ok(readIns, 'readDiskCache latest insiders must succeed');
    assert.equal(readIns.items.length, 1);
  });
});
